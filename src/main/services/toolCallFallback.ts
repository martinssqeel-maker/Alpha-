import type { ChatToolCall } from './providers/types'

/**
 * Structured tool-calling fallback for local models.
 *
 * Native tool calling is a *capability*, not a given: many Ollama builds expose
 * no `tools` flag, some templates drop the `tools` array entirely, and several
 * quantised models emit syntactically invalid native tool calls. Without a
 * fallback those models cannot drive any tool — which would make the desktop
 * agent unusable on exactly the hardware it targets.
 *
 * So when a model cannot do native tools we describe a tiny JSON protocol in the
 * system prompt and parse it back out of the assistant text. The protocol is
 * deliberately boring: one tag, one JSON object, `name` + `arguments` matching
 * the native shape exactly, so everything downstream is unchanged.
 */
export const TOOL_CALL_PROTOCOL = `## Calling tools (required format)

You cannot use native function calling in this session. To call a tool, emit a
single block exactly like this and then stop:

<tool_call>{"name": "tool_name", "arguments": {"key": "value"}}</tool_call>

Rules:
- Use only the tool names listed above. Arguments must be a JSON object.
- One block per call. You may emit several blocks to call several tools.
- Put no prose inside <tool_call>; prose goes outside it.
- After a tool result arrives, continue the task. Do not repeat a call that has
  already returned the same result.
- Never describe a result you have not received.`

interface ParsedCall {
  name: string
  arguments: Record<string, unknown>
}

const TAG_OPEN = /<tool_call>/gi

/**
 * Extract `<tool_call>` payloads from assistant text.
 *
 * The parser is intentionally forgiving in what it *accepts* and strict in what
 * it *returns*: fences, trailing commas in prose, `args` instead of `arguments`,
 * or a bare JSON object are all tolerated, but anything that is not a JSON
 * object with a non-empty `name` is dropped rather than guessed at.
 */
export function parseFallbackToolCalls(content: string): ChatToolCall[] {
  if (!content || !/tool_call|"name"\s*:|'name'\s*:/i.test(content)) return []

  const payloads: string[] = []

  // 1. Tagged blocks: <tool_call> ... </tool_call>
  const lower = content.toLowerCase()
  let cursor = 0
  TAG_OPEN.lastIndex = 0
  let open = TAG_OPEN.exec(content)
  while (open) {
    const start = open.index + open[0].length
    const close = lower.indexOf('</tool_call>', start)
    if (close < 0) {
      // Unterminated block: take the remainder rather than losing the call.
      payloads.push(content.slice(start))
      break
    }
    payloads.push(content.slice(start, close))
    cursor = close + '</tool_call>'.length
    TAG_OPEN.lastIndex = cursor
    open = TAG_OPEN.exec(content)
  }

  // 2. Fenced blocks labelled tool_call / json.
  if (!payloads.length) {
    const fence = /```(?:tool_call|tool|json)?\s*([\s\S]*?)```/gi
    let m = fence.exec(content)
    while (m) {
      if (/"name"\s*:/.test(m[1])) payloads.push(m[1])
      m = fence.exec(content)
    }
  }

  // 3. Last resort: a bare object that looks like a call and mentions a tool.
  if (!payloads.length && /^\s*\{/.test(content)) {
    payloads.push(content)
  }

  const calls: ChatToolCall[] = []
  for (const payload of payloads) {
    for (const object of extractJsonObjects(payload)) {
      const parsed = toCall(object)
      if (!parsed) continue
      calls.push({
        id: `call_${Math.random().toString(36).slice(2, 10)}`,
        name: parsed.name,
        arguments: parsed.arguments
      })
    }
  }
  return calls
}

/** Remove the protocol blocks so they never render as assistant prose. */
export function stripFallbackToolCalls(content: string): string {
  if (!content) return content
  return content
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, '')
    .replace(/<tool_call>[\s\S]*$/i, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** True when text looks like it is trying to call a tool (used for retry hints). */
export function looksLikeToolAttempt(content: string): boolean {
  return /<tool_call>/i.test(content) || /"name"\s*:\s*"[a-z_]+"/i.test(content)
}

function toCall(value: unknown): ParsedCall | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  // Accept the shapes small models actually produce.
  const name =
    firstString(record.name) ??
    firstString(record.tool) ??
    firstString(record.tool_name) ??
    firstString((record.function as Record<string, unknown> | undefined)?.name)
  if (!name || !/^[a-z][a-z0-9_]{1,63}$/i.test(name)) return null

  const rawArgs =
    record.arguments ??
    record.args ??
    record.parameters ??
    record.input ??
    (record.function as Record<string, unknown> | undefined)?.arguments

  let args: Record<string, unknown> = {}
  if (typeof rawArgs === 'string') {
    const parsed = safeParse(rawArgs)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      args = parsed as Record<string, unknown>
    } else if (!rawArgs.trim()) {
      args = {}
    } else {
      // A string that is not JSON is almost always a single positional value.
      args = { value: rawArgs }
    }
  } else if (rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs)) {
    args = rawArgs as Record<string, unknown>
  }
  return { name, arguments: args }
}

function firstString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function safeParse(text: string): unknown {
  const trimmed = text.trim().replace(/,$/, '')
  try {
    return JSON.parse(trimmed)
  } catch {
    // Models sometimes emit single quotes or unquoted keys; repair the cheap ones.
    const repaired = trimmed
      .replace(/,\s*([}\]])/g, '$1')
      .replace(/([{,]\s*)'([^']+)'\s*:/g, '$1"$2":')
    try {
      return JSON.parse(repaired)
    } catch {
      return null
    }
  }
}

/**
 * Pull every balanced `{...}` object out of a string.
 *
 * Brace counting is string- and escape-aware, so a JSON value containing `}` or
 * a quoted `<tool_call>` does not truncate the object.
 */
export function extractJsonObjects(text: string): unknown[] {
  const out: unknown[] = []
  let depth = 0
  let start = -1
  let inString = false
  let escaped = false

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') {
      inString = true
      continue
    }
    if (ch === '{') {
      if (depth === 0) start = i
      depth++
      continue
    }
    if (ch === '}') {
      if (depth === 0) continue
      depth--
      if (depth === 0 && start >= 0) {
        const candidate = text.slice(start, i + 1)
        const parsed = safeParse(candidate)
        if (parsed !== null) out.push(parsed)
        start = -1
      }
    }
  }
  return out
}
