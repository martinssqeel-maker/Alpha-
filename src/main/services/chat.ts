import { randomUUID } from 'node:crypto'
import type {
  ActivityItem,
  AttachmentRef,
  ChatEvent,
  ChatUsage,
  PermissionMode
} from '@shared/types'
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

export interface ChatDeps {
  providers: ProviderRegistry
  conversations: ConversationsRepo
  projects: ProjectService
  edits: EditService
  git: GitService
  terminal: TerminalService
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
    const { emit, conversations, providers, projects, permissions } = this.deps
    const log = getLogger()
    let assistantText = ''
    const activities: ActivityItem[] = []
    try {
      permissions.setMode(input.mode)

      const userContent = buildUserContent(input.text, input.attachments)
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

      const provider = providers.get(input.providerId)
      if (!provider) throw new ProviderError('Provider not found', 'not_found')

      const history = conversations.messages(input.conversationId).slice(0, -1)
      const messages: ProviderMessage[] = [
        { role: 'system', content: this.systemPrompt(input, providers, projects) },
        ...history.slice(-MAX_HISTORY_MESSAGES).map(toProviderMessage),
        { role: 'user', content: userContent }
      ]

      const toolsEnabled = Boolean(input.projectId) && input.mode !== 'chat'
      const tools = toolsEnabled ? TOOL_DEFINITIONS : undefined

      emit({ type: 'start', requestId })

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
                assistantText += delta.content
                emit({ type: 'delta', requestId, content: delta.content })
              }
              if (delta.thinking) emit({ type: 'thinking', requestId, content: delta.thinking })
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
                  assistantText += delta.content
                  emit({ type: 'delta', requestId, content: delta.content })
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

        for (const call of result.toolCalls) {
          if (controller.signal.aborted) break
          const toolResult = await this.runTool(requestId, call, toolContext, activities, emit, controller)
          messages.push({
            role: 'tool',
            content: toolResult.content,
            toolCallId: call.id,
            name: call.name
          })
        }
        if (controller.signal.aborted) break
      }

      if (controller.signal.aborted) {
        const msg = conversations.append({
          conversationId: input.conversationId,
          role: 'assistant',
          content: assistantText,
          modelId: input.modelId,
          providerId: input.providerId,
          activity: activities
        })
        emit({ type: 'cancelled', requestId })
        void msg
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
      emit({ type: 'done', requestId, messageId: message.id, content: assistantText, usage })
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
        emit({ type: 'cancelled', requestId })
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
      emit({ type: 'error', requestId, error: err.message, code: err.code })
    }
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
    const activity: ActivityItem = {
      id: randomUUID(),
      kind: def?.category === 'execute' ? 'command' : def?.category === 'write' ? 'edit' : def?.category === 'git' ? 'git' : 'tool',
      title: call.name,
      detail: describeCall(call),
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
