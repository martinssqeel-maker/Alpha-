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
import { toolNeedsApproval } from '@shared/permissions'
import { getLogger } from './logger'
import { PathError } from './pathGuard'
import type { ApprovalBroker, PermissionService } from './permissionService'
import type { ProviderRegistry } from './providers/registry'
import type { ChatToolCall, ProviderMessage } from './providers/types'
import { ProviderError } from './providers/types'
import type { ProjectService } from './projectService'
import type { ConversationsRepo, SettingsRepo } from './store'
import { AGENT_ONLY_TOOLS, executeTool, toolByName, TOOL_DEFINITIONS, type ToolContext } from './tools'
import type { EditService } from './editService'
import type { GitService } from './git'
import type { TerminalService } from './terminal'
import type { SkillsService } from './skills'
import type { AuthorizedRoots } from './authorizedRoots'
import type { DesktopService } from './desktopService'
import type { ComputerUseService } from './computerUseService'
import type { BrowserPreviewService } from './browserPreview'
import {
  looksLikeToolAttempt,
  parseFallbackToolCalls,
  stripFallbackToolCalls,
  TOOL_CALL_PROTOCOL
} from './toolCallFallback'

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
  roots: AuthorizedRoots
  desktop: DesktopService
  computer: ComputerUseService
  browser: BrowserPreviewService
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
  /** Skip native tool calling and use the `<tool_call>` JSON protocol. */
  forceToolFallback?: boolean
}

/**
 * Ceiling on tool rounds for one turn.
 *
 * Six was tuned for "read a file, edit a file". A desktop task — open Word,
 * write headings, add bullets, save, verify — legitimately takes a dozen
 * observations and actions. Fifteen leaves room without letting a confused model
 * spin indefinitely; a hard ceiling plus the repeat-failure detector below are
 * what keep a bad turn bounded, not a small number.
 */
const DEFAULT_MAX_TOOL_ITERATIONS = 15
const MAX_TOOL_ITERATIONS_CEILING = 40
/** The same failing call may be retried once, never twice. */
const MAX_IDENTICAL_FAILURES = 2
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
  // `propose_file_patch` is categorised as a write because that is its intent,
  // but it touches nothing: it computes an in-memory diff against the file's
  // current hash and returns a proposal id. Proposing three files in one round
  // is therefore safe and much faster than doing it serially.
  if (name === 'propose_file_patch') return true
  return definition.category === 'read' || definition.category === 'git'
}

/**
 * Stream filter for the JSON tool protocol.
 *
 * When the fallback engine is active the model writes `<tool_call>{...}</tool_call>`
 * into its normal text stream. Piping that straight to the UI would show the
 * user raw protocol, so the filter holds back anything that might be the start
 * of a block and discards complete ones. It releases text as soon as it is
 * provably not part of a call, so normal prose still streams token by token.
 */
export class ToolCallStreamFilter {
  private pending = ''

  constructor(private readonly enabled: boolean) {}

  push(chunk: string): string {
    if (!this.enabled) return chunk
    this.pending += chunk
    let out = ''
    while (this.pending) {
      const open = this.pending.toLowerCase().indexOf('<tool_call>')
      if (open === -1) {
        // Keep a tail that could still grow into the opening tag.
        const keep = longestPartialMatch(this.pending, '<tool_call>')
        out += this.pending.slice(0, this.pending.length - keep)
        this.pending = this.pending.slice(this.pending.length - keep)
        break
      }
      out += this.pending.slice(0, open)
      const close = this.pending.toLowerCase().indexOf('</tool_call>', open)
      if (close === -1) {
        // Still inside the block: hold everything from the tag onward.
        this.pending = this.pending.slice(open)
        break
      }
      this.pending = this.pending.slice(close + '</tool_call>'.length)
    }
    return out
  }

  flush(): string {
    if (!this.enabled) return ''
    const rest = this.pending
    this.pending = ''
    // An unterminated block is a truncated call: drop it rather than print it.
    return /<tool_call>/i.test(rest) ? '' : rest
  }
}

/** Length of the longest suffix of `text` that is a prefix of `tag`. */
function longestPartialMatch(text: string, tag: string): number {
  const max = Math.min(text.length, tag.length - 1)
  const lowerText = text.toLowerCase()
  const lowerTag = tag.toLowerCase()
  for (let size = max; size > 0; size--) {
    if (lowerText.endsWith(lowerTag.slice(0, size))) return size
  }
  return 0
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

  /**
   * Abort every turn in flight. Used by the global emergency kill-switch, which
   * must not depend on the UI being focused or on a specific request id.
   */
  cancelAll(): number {
    let cancelled = 0
    for (const [id, controller] of this.active) {
      controller.abort()
      this.active.delete(id)
      cancelled++
    }
    return cancelled
  }

  /** Number of turns currently running (HUD + tests). */
  get activeCount(): number {
    return this.active.size
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

      // Tools are available whenever the mode permits them. A coding project is
      // no longer a precondition: desktop, browser and authorized-folder tools
      // are the whole point of the general Windows agent, and the project-only
      // tools state their own requirement when called.
      const toolsEnabled = input.mode !== 'chat'
      const settings = this.deps.settings.get()
      const configured = settings.agent?.maxToolIterations ?? DEFAULT_MAX_TOOL_ITERATIONS
      const maxIterations = Math.min(Math.max(1, configured), MAX_TOOL_ITERATIONS_CEILING)

      // Settings → Agent off means: coding assistant only. The desktop tools are
      // removed from the model's menu entirely rather than being denied one by
      // one, so the model cannot plan around a capability it does not have.
      const agentEnabled = settings.agent?.enabled !== false
      const availableTools = agentEnabled
        ? TOOL_DEFINITIONS
        : TOOL_DEFINITIONS.filter((tool) => !AGENT_ONLY_TOOLS.has(tool.name))

      // Native tool calling first; the JSON protocol is the fallback for models
      // that reject or ignore it. `forceToolFallback` lets the user pin it.
      let fallbackMode = input.forceToolFallback === true
      // Enabled whenever tools are, not only once a fallback is detected: a
      // model that answers with the protocol on its very first turn would
      // otherwise leak the raw block into the transcript before we could react.
      const streamFilter = new ToolCallStreamFilter(toolsEnabled)
      const toolProtocol = `${TOOL_CALL_PROTOCOL}\n\nAvailable tools:\n${availableTools.map(
        (t) => `- ${t.name}: ${t.description.split('\n')[0]}`
      ).join('\n')}`

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
      /** `${name}:${json args}` → consecutive failures. */
      const failures = new Map<string, number>()

      /** Add the JSON protocol to the system message the first time we need it. */
      const enableFallback = (): void => {
        fallbackMode = true
        const system = messages[0]
        if (system?.role === 'system' && !system.content.includes('<tool_call>')) {
          system.content = `${system.content}\n\n${toolProtocol}`
        }
      }

      if (fallbackMode) enableFallback()

      for (let iteration = 0; iteration < maxIterations; iteration++) {
        if (controller.signal.aborted) break
        // Snapshot before the request so the protocol text can be removed
        // without assuming the adapter returned exactly the concatenated deltas.
        const assistantBeforeRound = assistantText
        let result
        const requestOnce = async (withTools: boolean) =>
          providers.chat(input.providerId, {
            model: input.modelId,
            messages,
            tools: withTools && !fallbackMode ? availableTools : undefined,
            signal: controller.signal,
            onDelta: (delta) => {
              if (delta.content) {
                recordOutput()
                assistantText += delta.content
                const visible = streamFilter.push(delta.content)
                if (visible) emitEvent({ type: 'delta', requestId, content: visible })
              }
              if (delta.thinking) {
                recordOutput()
                emitEvent({ type: 'thinking', requestId, content: delta.thinking })
              }
            }
          })

        try {
          result = await requestOnce(toolsEnabled)
        } catch (e) {
          if (e instanceof Error && e.name === 'AbortError') throw e
          // The model or its template rejected the native tools array. Switch to
          // the JSON protocol and ask again — this is the case that made small
          // local models unable to use any tool at all.
          if (toolsEnabled && !fallbackMode && e instanceof ProviderError && /tool|function/i.test(e.message)) {
            log.warn('chat', `provider rejected native tools, switching to JSON protocol: ${e.message}`)
            enableFallback()
            result = await requestOnce(false)
          } else {
            throw e
          }
        }

        if (result.usage) usage = result.usage

        // A model can emit the protocol even while native tools are offered, so
        // parse the text whenever nothing structured came back.
        let toolCalls = result.toolCalls
        if (!toolCalls.length && toolsEnabled) {
          const parsed = parseFallbackToolCalls(result.content)
          if (parsed.length) {
            if (!fallbackMode) {
              // The model chose the protocol on its own; keep using it.
              enableFallback()
            }
            toolCalls = parsed
            // Replace the raw protocol text with just the prose.
            const cleaned = stripFallbackToolCalls(result.content)
            assistantText = assistantBeforeRound + cleaned
            result = { ...result, content: cleaned }
          } else if (!fallbackMode && looksLikeToolAttempt(result.content)) {
            // A malformed attempt: nudge once rather than silently answering.
            const hint = 'Your last message looked like a tool call but could not be parsed. Emit exactly <tool_call>{"name": "...", "arguments": {...}}</tool_call>, or answer without tools.'
            if (!messages.some((m) => m.content === hint)) {
              enableFallback()
              messages.push({ role: 'system', content: hint })
              continue
            }
          }
        }

        if (!toolCalls.length) {
          const tail = streamFilter.flush()
          if (tail) {
            assistantText += tail
            emitEvent({ type: 'delta', requestId, content: tail })
          }
          break
        }

        messages.push({
          role: 'assistant',
          content: result.content || '',
          toolCalls: toolCalls.map((c) => ({ id: c.id, name: c.name, arguments: c.arguments }))
        })

        const toolContext: ToolContext = {
          projectId: input.projectId ?? null,
          projects,
          edits: this.deps.edits,
          git: this.deps.git,
          terminal: this.deps.terminal,
          permissions,
          roots: this.deps.roots,
          desktop: this.deps.desktop,
          computer: this.deps.computer,
          browser: this.deps.browser
        }

        const toolResults = await this.runTools(
          requestId,
          toolCalls,
          toolContext,
          activities,
          emitEvent,
          controller,
          failures
        )
        for (const [index, call] of toolCalls.entries()) {
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
    controller: AbortController,
    failures: Map<string, number>
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
            const run = this.runTool(requestId, call, ctx, activities, emit, controller, failures)
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
      results[index] = await this.runTool(requestId, calls[index], ctx, activities, emit, controller, failures)
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
    controller: AbortController,
    failures?: Map<string, number>
  ): Promise<{ content: string; activity: ActivityItem }> {
    const def = toolByName(call.name)
    const approvalCopy = describeApproval(call, ctx)
    const callKey = toolCallKey(call)
    const priorFailures = failures?.get(callKey) ?? 0
    const markFailure = (): void => {
      if (failures) failures.set(callKey, (failures.get(callKey) ?? 0) + 1)
    }
    const kind: ActivityItem['kind'] =
      def?.category === 'execute'
        ? 'command'
        : def?.category === 'write'
          ? 'edit'
          : def?.category === 'git'
            ? 'git'
            : def?.category === 'desktop'
              ? 'desktop'
              : def?.category === 'browser'
                ? 'browser'
                : 'tool'
    const activity: ActivityItem = {
      id: randomUUID(),
      kind,
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
      markFailure()
      return { content: JSON.stringify({ error: activity.error }), activity }
    }

    // Repeat-failure detector. A small model that gets the same error twice will
    // often keep re-issuing the identical call; the ceiling on iterations would
    // eventually stop it, but only after burning the whole budget. Refusing the
    // third attempt and naming the reason gets it unstuck on the next turn.
    if (priorFailures >= MAX_IDENTICAL_FAILURES) {
      activity.state = 'failed'
      activity.error = `This exact call has already failed ${priorFailures} times. It will not be retried; change the approach or arguments.`
      activity.endedAt = Date.now()
      emit({ type: 'activity', requestId, activity: { ...activity } })
      return { content: JSON.stringify({ error: activity.error, repeated: true }), activity }
    }

    if (
      call.name === 'apply_approved_patch' &&
      !ctx.edits.describeProposal(String((call.arguments as Record<string, unknown> | null)?.proposalId ?? ''))
    ) {
      activity.state = 'failed'
      activity.error = 'The proposed change is unavailable or expired. Review the file and propose it again.'
      activity.endedAt = Date.now()
      emit({ type: 'activity', requestId, activity: { ...activity } })
      markFailure()
      return { content: JSON.stringify({ error: activity.error }), activity }
    }

    const permissionKey = def.permissionKey
    if (permissionKey !== 'read') {
      // `toolNeedsApproval` keeps the promise a tool makes when it declares
      // `requiresApproval: true`: an allowed capability does not silently waive
      // the prompt a destructive tool asked for.
      const { decision } = toolNeedsApproval(ctx.permissions.get(), permissionKey, def.requiresApproval)
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
          if (!approved) markFailure()
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
      activity.verification = exec.verification
      activity.endedAt = Date.now()
      failures?.delete(callKey)
      emit({ type: 'activity', requestId, activity: { ...activity } })
      emit({ type: 'tool-result', requestId, callId: call.id, result: exec.result })
      // The verification travels with the result so the model reads the same
      // evidence the user sees. A false verification is stated plainly rather
      // than left for the model to infer from a successful-looking payload.
      const payload =
        exec.verification === undefined
          ? exec.result
          : { result: exec.result, verification: exec.verification }
      return { content: JSON.stringify(payload).slice(0, 20000), activity }
    } catch (e) {
      const err = e as Error
      activity.state = 'failed'
      activity.error = err.message
      activity.verification = {
        verified: false,
        note: err.message,
        check: err instanceof PathError ? err.code : 'execution'
      }
      activity.endedAt = Date.now()
      markFailure()
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
      'You are Alpha, an agent inside the Alpha AI Workspace desktop app on Windows.',
      'You can read and edit a coding project, work with files in the user\'s folders, control Windows applications, and drive the built-in browser.',
      'Be concise and precise. Prefer doing over describing.',
      `Permission mode: ${input.mode}.` +
        (input.mode === 'chat'
          ? ' Tools are disabled entirely: answer from the conversation only.'
          : ' Tools that need the user\'s approval will pause until they respond.')
    ]

    // Capability description is only useful when tools are actually on.
    if (input.mode !== 'chat') {
      lines.push(
        [
          '',
          '## How to act on a Windows desktop',
          '',
          'Follow this order and stop at the first level that works:',
          '1. **Native / file / COM** — create_or_write_file, create_or_edit_office_document.',
          '   Fastest and most reliable; use it whenever it can express the task.',
          '2. **UI Automation** — inspect_window_ui, then interact_with_window_element with',
          '   the [n] number it returns. This does NOT move the user\'s mouse: prefer it',
          '   over clicking. Inspect again after the window changes; numbers are reassigned.',
          '3. **Clipboard + keyboard** — clipboard_bridge with action "paste_text" for long',
          '   text, then send keys. It restores what the user had copied.',
          '4. **Mouse** — only for canvas UIs where nothing above can see a control.',
          '',
          'Workflow for "open Word and write a report": find_and_launch_app, then',
          'create_or_edit_office_document with structured blocks (title, heading,',
          'paragraph, bullet, table). Do not type a whole document key by key.',
          '',
          'Before saving anywhere, call list_authorized_locations if you do not already',
          'know which folders are allowed. Use "documents/report.docx" style paths.',
          '',
          '## Proving your work',
          '',
          'Every tool returns a `verification` object with `verified` and a note.',
          '- Never say an action succeeded unless `verified` is true.',
          '- If `verified` is false, say what the check observed and what you will try next.',
          '- Never invent file contents, window titles, test results or page text.',
          '- When the task is done, state what was created, where it is (full path), and',
          '  which verification confirmed it.',
          '',
          '## Editing code',
          '',
          'propose_file_patch computes a diff without writing; apply_approved_patch writes',
          'it after approval. Never claim a file changed unless that tool reports success.'
        ].join('\n')
      )
    }

    if (input.projectId) {
      try {
        const project = projects.resolveProject(input.projectId)
        lines.push(`The user has opened the coding project "${project.name}". You may work inside it; the authorized folders are separate and also available.`)
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
  if (call.name === 'find_and_launch_app') {
    return {
      title: `Open ${String(args.query ?? 'an application')}`,
      detail: `Application: ${String(args.query ?? '')}\nThis starts a program on your desktop.`
    }
  }
  if (call.name === 'close_window') {
    const label = args.window ?? args.processId ?? 'a window'
    return {
      title: `Close ${String(label)}`,
      detail: `Target: ${String(label)}\nThe app is asked to exit first; it is only forced after four seconds. Unsaved work may be lost.`
    }
  }
  if (call.name === 'delete_file') {
    return {
      title: `Delete ${String(args.path ?? 'a file')}`,
      detail: `File: ${String(args.path ?? '')}\nThis removes the file from disk. There is no checkpoint for files outside a project.`
    }
  }
  if (call.name === 'create_or_edit_office_document') {
    return {
      title: `Create ${String(args.app ?? 'word') === 'excel' ? 'spreadsheet' : 'document'} ${String(args.path ?? '')}`,
      detail: `Writes ${String(args.path ?? '')} and opens ${String(args.app ?? 'word') === 'excel' ? 'Excel' : 'Word'} on your desktop so you can see it.`
    }
  }
  if (call.name === 'interact_with_window_element') {
    return {
      title: `${String(args.action ?? 'Interact with')} element ${String(args.elementId ?? '')}`,
      detail: `Window: ${String(args.window ?? args.processId ?? '')}\nElement: [${String(args.elementId ?? '')}]${
        typeof args.value === 'string' ? `\nValue: ${args.value.slice(0, 200)}` : ''
      }\nThis sends input to another application.`
    }
  }
  if (call.name === 'run_approved_command') {
    const command = String(args.command ?? '')
    const cwd = ctx.projectId ? ctx.projects.resolveRoot(ctx.projectId) : 'an authorized folder'
    return {
      title: 'Run command',
      detail: `Command: ${command}\nDirectory: ${cwd}\nThis executes a shell command and may change files or use the network.`
    }
  }
  if (call.name === 'apply_approved_patch') {
    const proposal = ctx.edits.describeProposal(String(args.proposalId ?? ''))
    if (!proposal) return { title: 'Apply proposed file change', detail: 'The proposed change is unavailable or expired.' }
    const action = proposal.kind === 'delete' ? 'delete' : 'write'
    const consequence = proposal.kind === 'delete'
      ? 'This removes the project file. A checkpoint is created first.'
      : 'This writes the proposed content to the project file. A checkpoint is created first.'
    return { title: `Apply ${action} to ${proposal.path}`, detail: `Target: ${proposal.path}\n${consequence}` }
  }
  return null
}
