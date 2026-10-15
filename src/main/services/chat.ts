import { randomUUID } from 'node:crypto'
import type {
  ActivityItem,
  AttachmentRef,
  ChatEvent,
  ChatMetrics,
  ChatUsage,
  PermissionMode
} from '@shared/types'
import { createConversationTitle } from '@shared/conversationTitle'
import { getLogger } from './logger'
import { PathError } from './pathGuard'
import type { ApprovalBroker, PermissionService } from './permissionService'
import type { ProviderRegistry } from './providers/registry'
import type { ChatToolCall, ProviderMessage } from './providers/types'
import { ProviderError } from './providers/types'
import type { ProjectService } from './projectService'
import type { ConversationsRepo, SettingsRepo } from './store'
import { executeTool, toolByName, TOOL_DEFINITIONS, type ToolContext } from './tools'
import type { EditService } from './editService'
import type { GitService } from './git'
import type { TerminalService } from './terminal'
import type { SkillsService } from './skills'

export interface ChatDeps {
  providers: ProviderRegistry
  conversations: ConversationsRepo
  projects: ProjectService
  edits: EditService
  git: GitService
  terminal: TerminalService
  skills: SkillsService
  permissions: PermissionService
  broker: ApprovalBroker
  settings: SettingsRepo
  emit: (event: ChatEvent) => void
}

export interface SendInput {
  conversationId: string
  providerId: string
  modelId: string
  mode: PermissionMode
  projectId?: string | null
  text: string
  attachments?: AttachmentRef[]
}

const MAX_TOOL_ITERATIONS = 6
const MAX_HISTORY_MESSAGES = 20
const MAX_MESSAGE_CHARS = 12000
/**
 * History budget, in characters, for the turns sent with each request.
 *
 * `MAX_HISTORY_MESSAGES` alone allowed 20 × 12k = 240k characters of history —
 * many times any local model's context. Providers then truncate the prompt
 * themselves, usually from the *newest* end, which is the worst possible part to
 * lose. Keeping the newest turns up to a real budget is the honest fix; older
 * turns are dropped rather than silently mangled. ~4 characters per token makes
 * this roughly a 6k-token history.
 */
export const MAX_HISTORY_CHARS = 24_000

/**
 * Take the newest history that fits a character budget, oldest-first.
 *
 * The most recent message is always kept, even if it alone exceeds the budget:
 * dropping it would answer the wrong question.
 */
export function selectHistory<T extends { content: string }>(
  history: T[],
  maxMessages = MAX_HISTORY_MESSAGES,
  maxChars = MAX_HISTORY_CHARS
): T[] {
  const recent = history.slice(-maxMessages)
  const kept: T[] = []
  let used = 0
  for (let index = recent.length - 1; index >= 0; index--) {
    const message = recent[index]
    const size = message.content.length
    if (kept.length > 0 && used + size > maxChars) break
    kept.push(message)
    used += size
  }
  return kept.reverse()
}

/**
 * Which read-only tools may be started together.
 *
 * Only tools that actually *await* something can overlap: `get_git_status` and
 * `get_git_diff` await a child process, so starting both overlaps the spawn and
 * the repository read. The file tools (`list_project_files`, `search_project`,
 * `read_project_file`) are synchronous filesystem calls, so awaiting them in
 * parallel changes nothing — the event loop still runs them one at a time. They
 * are included because grouping them is harmless and lets identical calls be
 * de-duplicated, but no speed-up is claimed for them.
 *
 * Everything that writes, patches, commits or executes stays strictly serial in
 * the model's original order: those touch shared state a parallel run could
 * corrupt.
 */
export function isParallelSafeTool(name: string): boolean {
  const definition = toolByName(name)
  if (!definition || definition.requiresApproval) return false
  if (definition.permissionKey !== 'read') return false
  return definition.category === 'read' || definition.category === 'git'
}

/** Identity of a tool call, used to avoid running the exact same read twice. */
function toolCallKey(call: ChatToolCall): string {
  let args = ''
  try {
    args = JSON.stringify(call.arguments ?? {})
  } catch {
    args = String(call.arguments)
  }
  return `${call.name}:${args}`
}

export class ChatService {
  private active = new Map<string, AbortController>()

  constructor(private deps: ChatDeps) {}

  send(input: SendInput): { requestId: string } {
    const requestId = randomUUID()
    const controller = new AbortController()
    this.active.set(requestId, controller)
    void this.run(requestId, controller, input).finally(() => {
      this.active.delete(requestId)
    })
    return { requestId }
  }

  cancel(requestId: string): boolean {
    const controller = this.active.get(requestId)
    if (!controller) return false
    controller.abort()
    return true
  }

  private async run(
    requestId: string,
    controller: AbortController,
    input: SendInput
  ): Promise<void> {
    const { conversations, providers, projects, permissions } = this.deps
    const emitEvent = (event: ChatEvent): void => this.deps.emit({ ...event, conversationId: input.conversationId })
    const log = getLogger()
    let assistantText = ''
    const activities: ActivityItem[] = []
    try {
      permissions.setMode(input.mode)

      const userContent = buildUserContent(input.text, input.attachments)
      const currentConversation = conversations.get(input.conversationId)
      const hasPriorUserMessage = conversations.messages(input.conversationId).some((message) => message.role === 'user')
      conversations.append({
        conversationId: input.conversationId,
        role: 'user',
        content: input.text,
        attachments: input.attachments?.map((a) => ({
          id: a.id,
          name: a.name,
          mimeType: a.mimeType,
          size: a.size,
          kind: a.kind
        }))
      })
      if (
        currentConversation?.title === 'New chat' &&
        currentConversation.titleSource !== 'manual' &&
        !hasPriorUserMessage
      ) {
        conversations.setAutoTitle(
          input.conversationId,
          createConversationTitle(input.text, input.attachments?.map((attachment) => attachment.name))
        )
      }

      const provider = providers.get(input.providerId)
      if (!provider) throw new ProviderError('Provider not found', 'not_found')

      const history = conversations.messages(input.conversationId).slice(0, -1)
      const messages: ProviderMessage[] = [
        { role: 'system', content: this.systemPrompt(input, providers, projects) },
        ...selectHistory(history).map(toProviderMessage),
        { role: 'user', content: userContent }
      ]

      const toolsEnabled = Boolean(input.projectId) && input.mode !== 'chat'
      const tools = toolsEnabled ? TOOL_DEFINITIONS : undefined

      // Timing is measured from the moment the request was accepted, because that
      // is what the user waits for: the first number here is context assembly, the
      // second is the provider's own latency to the first visible token.
      const sentAt = Date.now()
      let firstOutputAt: number | undefined
      let toolMs = 0
      let toolCallCount = 0
      const recordOutput = (): void => {
        if (firstOutputAt === undefined) firstOutputAt = Date.now()
      }
      const emitMetrics = (completedAt: number): void => {
        const totalMs = completedAt - sentAt
        const outputTokens = usage?.completionTokens
        const metrics: ChatMetrics = {
          promptMs: requestStartedAt - sentAt,
          ttftMs: (firstOutputAt ?? completedAt) - sentAt,
          totalMs,
          promptTokens: usage?.promptTokens,
          outputTokens,
          tokensPerSecond:
            outputTokens && totalMs > 0 ? Math.round((outputTokens / (totalMs / 1000)) * 10) / 10 : undefined,
          toolCalls: toolCallCount,
          toolMs,
          historyMessages: messages.length - 2
        }
        emitEvent({ type: 'metrics', requestId, metrics })
      }

      const requestStartedAt = Date.now()
      emitEvent({ type: 'start', requestId })

      let usage: ChatUsage | undefined
      let usedTools = false

      for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
        if (controller.signal.aborted) break
        let result
        try {
          result = await providers.chat(input.providerId, {
            model: input.modelId,
            messages,
            tools,
            signal: controller.signal,
            onDelta: (delta) => {
              if (delta.content) {
                recordOutput()
                assistantText += delta.content
                emitEvent({ type: 'delta', requestId, content: delta.content })
              }
              if (delta.thinking) {
                recordOutput()
                emitEvent({ type: 'thinking', requestId, content: delta.thinking })
              }
            }
          })
        } catch (e) {
          if (e instanceof Error && e.name === 'AbortError') throw e
          // If the model rejected tools, retry once without them.
          if (tools && !usedTools && e instanceof ProviderError && /tool/i.test(e.message)) {
            log.warn('chat', `retrying without tools: ${e.message}`)
            result = await providers.chat(input.providerId, {
              model: input.modelId,
              messages,
              signal: controller.signal,
              onDelta: (delta) => {
                if (delta.content) {
                  recordOutput()
                  assistantText += delta.content
                  emitEvent({ type: 'delta', requestId, content: delta.content })
                }
              }
            })
          } else {
            throw e
          }
        }

        if (result.usage) usage = result.usage
        if (!result.toolCalls.length) break

        usedTools = true
        messages.push({
          role: 'assistant',
          content: result.content || '',
          toolCalls: result.toolCalls.map((c) => ({ id: c.id, name: c.name, arguments: c.arguments }))
        })

        const toolContext: ToolContext = {
          projectId: input.projectId ?? null,
          projects,
          edits: this.deps.edits,
          git: this.deps.git,
          terminal: this.deps.terminal,
          permissions
        }

        const toolResults = await this.runTools(
          requestId,
          result.toolCalls,
          toolContext,
          activities,
          emitEvent,
          controller
        )
        for (const [index, call] of result.toolCalls.entries()) {
          messages.push({
            role: 'tool',
            content: toolResults[index]?.content ?? JSON.stringify({ error: 'Tool did not run.' }),
            toolCallId: call.id,
            name: call.name
          })
        }
        toolCallCount += toolResults.length
        toolMs = activities.reduce(
          (sum, activity) => sum + ((activity.endedAt ?? activity.startedAt ?? 0) - (activity.startedAt ?? 0)),
          0
        )
        if (controller.signal.aborted) break
      }

      if (controller.signal.aborted) {
        conversations.append({
          conversationId: input.conversationId,
          role: 'assistant',
          content: assistantText,
          modelId: input.modelId,
          providerId: input.providerId,
          activity: activities
        })
        emitMetrics(Date.now())
        emitEvent({ type: 'cancelled', requestId })
        return
      }

      const message = conversations.append({
        conversationId: input.conversationId,
        role: 'assistant',
        content: assistantText,
        modelId: input.modelId,
        providerId: input.providerId,
        activity: activities
      })
      emitMetrics(Date.now())
      emitEvent({ type: 'done', requestId, messageId: message.id, content: assistantText, usage })
    } catch (e) {
      if (e instanceof Error && e.name === 'AbortError') {
        conversations.append({
          conversationId: input.conversationId,
          role: 'assistant',
          content: assistantText,
          modelId: input.modelId,
          providerId: input.providerId,
          activity: activities
        })
        emitEvent({ type: 'cancelled', requestId })
        return
      }
      const err = e as ProviderError
      log.error('chat', `request ${requestId} failed: ${err.message}`)
      if (assistantText) {
        conversations.append({
          conversationId: input.conversationId,
          role: 'assistant',
          content: assistantText,
          modelId: input.modelId,
          providerId: input.providerId,
          activity: activities
        })
      }
      emitEvent({ type: 'error', requestId, error: err.message, code: err.code })
    }
  }

  /**
   * Run one round of tool calls.
   *
   * Consecutive read-only calls are independent, so they run together; an
   * identical read repeated inside the same round is executed once and its result
   * reused, because re-reading the same file costs latency and returns nothing new.
   * Everything that writes, patches, commits or runs a command stays serial in the
   * model's original order — those touch shared state a parallel run could corrupt.
   *
   * Results are returned positionally to match `calls`; a cancelled round leaves
   * `undefined` holes, which the caller answers explicitly instead of sending
   * nothing to the model.
   */
  private async runTools(
    requestId: string,
    calls: ChatToolCall[],
    ctx: ToolContext,
    activities: ActivityItem[],
    emit: (e: ChatEvent) => void,
    controller: AbortController
  ): Promise<Array<{ content: string; activity: ActivityItem } | undefined>> {
    const results: Array<{ content: string; activity: ActivityItem } | undefined> = new Array(calls.length)
    const round = new Map<string, Promise<{ content: string; activity: ActivityItem }>>()
    let index = 0

    while (index < calls.length) {
      if (controller.signal.aborted) break
      if (isParallelSafeTool(calls[index].name)) {
        let end = index
        while (end < calls.length && isParallelSafeTool(calls[end].name) && !controller.signal.aborted) end++
        const batch = calls.slice(index, end)
        const settled = await Promise.all(
          batch.map((call) => {
            const key = toolCallKey(call)
            const existing = round.get(key)
            if (existing) {
              getLogger().debug('chat', `reusing identical ${call.name} call in this round`)
              return existing
            }
            const run = this.runTool(requestId, call, ctx, activities, emit, controller)
            round.set(key, run)
            return run
          })
        )
        settled.forEach((result, offset) => {
          results[index + offset] = result
        })
        index = end
        continue
      }
      results[index] = await this.runTool(requestId, calls[index], ctx, activities, emit, controller)
      index++
    }
    return results
  }

  private async runTool(
    requestId: string,
    call: ChatToolCall,
    ctx: ToolContext,
    activities: ActivityItem[],
    emit: (e: ChatEvent) => void,
    controller: AbortController
  ): Promise<{ content: string; activity: ActivityItem }> {
    const def = toolByName(call.name)
    const approvalCopy = describeApproval(call, ctx)
    const activity: ActivityItem = {
      id: randomUUID(),
      kind: def?.category === 'execute' ? 'command' : def?.category === 'write' ? 'edit' : def?.category === 'git' ? 'git' : 'tool',
      title: approvalCopy?.title ?? call.name,
      detail: approvalCopy?.detail ?? describeCall(call),
      state: 'proposed',
      toolName: call.name,
      args: call.arguments,
      startedAt: Date.now(),
      requiresApproval: def?.requiresApproval
    }
    activities.push(activity)
    emit({ type: 'activity', requestId, activity: { ...activity } })
    emit({ type: 'tool-call', requestId, call: { id: call.id, name: call.name, args: call.arguments } })

    if (!def) {
      activity.state = 'failed'
      activity.error = `Unknown tool: ${call.name}`
      activity.endedAt = Date.now()
      emit({ type: 'activity', requestId, activity: { ...activity } })
      return { content: JSON.stringify({ error: activity.error }), activity }
    }

    if (
      call.name === 'apply_approved_patch' &&
      !ctx.edits.describeProposal(String((call.arguments as Record<string, unknown> | null)?.proposalId ?? ''))
    ) {
      activity.state = 'failed'
      activity.error = 'The proposed change is unavailable or expired. Review the file and propose it again.'
      activity.endedAt = Date.now()
      emit({ type: 'activity', requestId, activity: { ...activity } })
      return { content: JSON.stringify({ error: activity.error }), activity }
    }

    const permissionKey = def.permissionKey
    if (permissionKey !== 'read') {
      const decision = ctx.permissions.resolve(permissionKey)
      if (decision === 'deny') {
        activity.state = 'failed'
        activity.error = 'Denied by current permission settings.'
        activity.endedAt = Date.now()
        emit({ type: 'activity', requestId, activity: { ...activity } })
        return { content: JSON.stringify({ error: activity.error }), activity }
      }
      if (decision === 'ask') {
        const approvalId = randomUUID()
        activity.state = 'awaiting-approval'
        activity.approvalId = approvalId
        activity.detail = `${activity.detail ?? ''} — waiting for approval`.trim()
        emit({ type: 'activity', requestId, activity: { ...activity } })
        const approved = await this.deps.broker.request(approvalId)
        if (controller.signal.aborted || !approved) {
          activity.state = 'cancelled'
          activity.error = approved ? 'Cancelled' : 'User denied the action.'
          activity.endedAt = Date.now()
          emit({ type: 'activity', requestId, activity: { ...activity } })
          return { content: JSON.stringify({ error: activity.error }), activity }
        }
        activity.approvalId = undefined
        activity.state = 'proposed'
      }
    }

    activity.state = 'running'
    emit({ type: 'activity', requestId, activity: { ...activity } })
    try {
      const exec = await executeTool(call.name, call.arguments, ctx)
      activity.state = 'completed'
      activity.result = exec.result
      activity.detail = exec.summary
      activity.endedAt = Date.now()
      emit({ type: 'activity', requestId, activity: { ...activity } })
      emit({ type: 'tool-result', requestId, callId: call.id, result: exec.result })
      return { content: JSON.stringify(exec.result).slice(0, 20000), activity }
    } catch (e) {
      const err = e as Error
      activity.state = 'failed'
      activity.error = err.message
      activity.endedAt = Date.now()
      emit({ type: 'activity', requestId, activity: { ...activity } })
      const payload = err instanceof PathError ? { error: err.message, code: err.code } : { error: err.message }
      return { content: JSON.stringify(payload), activity }
    }
  }

  private systemPrompt(
    input: SendInput,
    providers: ProviderRegistry,
    projects: ProjectService
  ): string {
    const provider = providers.get(input.providerId)
    const lines = [
      'You are Alpha, a coding assistant inside the Alpha AI Workspace desktop app.',
      'Be concise and precise. Prefer doing over describing.',
      `Permission mode: ${input.mode}. In chat mode you may not read projects or run tools.`
    ]
    if (input.projectId) {
      try {
        const project = projects.resolveProject(input.projectId)
        lines.push(`The user has opened the project "${project.name}". Work only inside it using the provided tools.`)
        try {
          const tree = projects.listTree(input.projectId, '', 1)
          const names = tree.slice(0, 60).map((n) => (n.type === 'directory' ? n.name + '/' : n.name))
          lines.push(`Top-level entries: ${names.join(', ')}`)
        } catch {
          /* ignore */
        }
        lines.push(
          'To change files, call propose_file_patch, then apply_approved_patch. Never claim a file changed unless the tool result confirms it. Never invent test results.'
        )
      } catch {
        /* ignore */
      }
    }
    if (provider) lines.push(`Provider: ${provider.name} (${provider.isLocal ? 'local' : 'cloud'}).`)
    const skillContext = this.deps.skills.promptContext()
    if (skillContext) lines.push(skillContext)
    return lines.join('\n')
  }
}

function toProviderMessage(m: { role: string; content: string; toolName?: string }): ProviderMessage {
  const role = (m.role === 'assistant' || m.role === 'user' || m.role === 'system' || m.role === 'tool'
    ? m.role
    : 'user') as ProviderMessage['role']
  return { role, content: m.content.slice(0, MAX_MESSAGE_CHARS) }
}

function buildUserContent(text: string, attachments?: AttachmentRef[]): string {
  if (!attachments || !attachments.length) return text
  const parts = [text]
  for (const a of attachments) {
    if (a.extractedText) {
      parts.push(`\n\n--- Attached file: ${a.name} (${a.mimeType}) ---\n${a.extractedText}`)
    } else if (a.kind === 'image') {
      parts.push(`\n\n[Attached image: ${a.name}]`)
    } else {
      parts.push(`\n\n[Attached ${a.kind} file: ${a.name}${a.note ? ' — ' + a.note : ''}]`)
    }
  }
  return parts.join('')
}

function describeCall(call: ChatToolCall): string {
  const args = (call.arguments ?? {}) as Record<string, unknown>
  if (call.name === 'run_approved_command') return String(args.command ?? '')
  if (call.name === 'read_project_file' || call.name === 'propose_file_patch') return String(args.path ?? '')
  if (call.name === 'search_project') return String(args.query ?? '')
  return JSON.stringify(args).slice(0, 200)
}

function describeApproval(
  call: ChatToolCall,
  ctx: ToolContext
): { title: string; detail: string } | null {
  const args = (call.arguments ?? {}) as Record<string, unknown>
  if (call.name === 'apply_approved_patch') {
    const proposal = ctx.edits.describeProposal(String(args.proposalId ?? ''))
    if (!proposal) return { title: 'Apply proposed file change', detail: 'The proposed change is unavailable or expired.' }
    const action = proposal.kind === 'delete' ? 'delete' : 'write'
    const consequence = proposal.kind === 'delete'
      ? 'This removes the project file. A checkpoint is created first.'
      : 'This writes the proposed content to the project file. A checkpoint is created first.'
    return { title: `Apply ${action} to ${proposal.path}`, detail: `Target: ${proposal.path}\n${consequence}` }
  }
  if (call.name === 'run_approved_command') {
    const command = String(args.command ?? '')
    const cwd = ctx.projectId ? ctx.projects.resolveRoot(ctx.projectId) : 'No project selected'
    return {
      title: 'Run command in project',
      detail: `Command: ${command}\nDirectory: ${cwd}\nThis executes a shell command and may change project files or use network access.`
    }
  }
  return null
}
