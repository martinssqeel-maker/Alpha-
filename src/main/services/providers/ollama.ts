import type { ModelInfo, ProviderStatus, ToolDefinition } from '@shared/types'
import { getLogger } from '../logger'
import {
  joinUrl,
  ProviderError,
  withTimeout,
  type ChatRequest,
  type ChatResult,
  type ChatToolCall,
  type ProviderAdapter,
  type ProviderMessage
} from './types'

interface OllamaTag {
  name: string
  model: string
  size: number
  details?: {
    family?: string
    parameter_size?: string
    quantization_level?: string
    context_length?: number
  }
  capabilities?: string[]
}

interface OllamaChatLine {
  message?: {
    role?: string
    content?: string
    thinking?: string
    tool_calls?: { function?: { name?: string; arguments?: unknown } }[]
  }
  done?: boolean
  error?: string
  prompt_eval_count?: number
  eval_count?: number
}

function inferVision(family: string, id: string): boolean {
  const probe = `${family} ${id}`.toLowerCase()
  return /(llava|vision|bakllava|moondream|minicpm-v|gemma3)/.test(probe)
}

function toModelInfo(tag: OllamaTag, baseUrl: string): ModelInfo {
  const id = tag.name || tag.model
  const family = tag.details?.family ?? ''
  const caps = tag.capabilities ?? []
  const capabilities = {
    streaming: true,
    tools: caps.includes('tools'),
    vision: caps.includes('vision') || (caps.length === 0 && inferVision(family, id))
  }
  return {
    id,
    name: id,
    providerId: '',
    providerName: '',
    providerKind: 'ollama',
    local: true,
    capabilities,
    contextLength: tag.details?.context_length,
    parameterSize: tag.details?.parameter_size,
    quantization: tag.details?.quantization_level,
    family
  }
}

/**
 * How long Ollama keeps a model in memory after a request.
 *
 * Ollama's default is 5 minutes, after which the model is evicted; the next
 * request then pays a full reload (measured at ~39s to first token for
 * qwen3:1.7b on a CPU-only laptop, versus ~2.4s while resident). 15 minutes
 * covers a normal working session without pinning memory forever after the app
 * is closed. Raise or lower it here if the trade-off matters more than the win.
 */
export const OLLAMA_KEEP_ALIVE = '15m'

function mapMessages(messages: ProviderMessage[]): unknown[] {
  return messages.map((m) => {
    if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length) {
      return {
        role: 'assistant',
        content: m.content || '',
        tool_calls: m.toolCalls.map((t) => ({
          function: { name: t.name, arguments: t.arguments }
        }))
      }
    }
    if (m.role === 'tool') {
      return { role: 'tool', content: m.content, tool_name: m.name }
    }
    const out: Record<string, unknown> = { role: m.role, content: m.content }
    if (m.images && m.images.length) out.images = m.images
    return out
  })
}

function mapTools(tools?: ToolDefinition[]): unknown[] | undefined {
  if (!tools || !tools.length) return undefined
  return tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters }
  }))
}

/**
 * Backoff schedule for probing a local Ollama server.
 *
 * The first launch after login is the case this exists for: Ollama is often
 * started by its own autostart entry or by the user a second or two after Alpha,
 * so the very first probe legitimately fails and succeeds moments later. Failing
 * that quickly would show a false "Ollama unreachable" and could leave a model
 * picker empty for the whole session.
 *
 * Delays are short on purpose — this runs while the UI is loading. Roughly
 * 0.4s + 1s + 2.5s between four attempts, with jitter so several windows doing
 * this at once do not retry in lockstep.
 */
export const OLLAMA_PROBE_DELAYS_MS = [400, 1000, 2500] as const
const PROBE_TIMEOUT_MS = 8000

/** Transient conditions worth retrying. Anything else is reported once. */
export function isRetryableProbeError(error: unknown): boolean {
  if (error instanceof ProviderError) {
    return error.code === 'unreachable' || error.code === 'timeout'
  }
  const err = error as { name?: string; code?: string; message?: string; cause?: { code?: string } }
  if (err?.name === 'AbortError') return false
  const code = err?.code ?? err?.cause?.code ?? ''
  if (
    code === 'ECONNREFUSED' ||
    code === 'ECONNRESET' ||
    code === 'EHOSTUNREACH' ||
    code === 'ENETUNREACH' ||
    code === 'ENOTFOUND' ||
    code === 'ETIMEDOUT' ||
    code === 'UND_ERR_CONNECT_TIMEOUT' ||
    code === 'UND_ERR_SOCKET'
  ) {
    return true
  }
  // A fetch failure whose error type is generic ("fetch failed") is almost
  // always the server not being up yet.
  return /fetch failed|network|socket hang up|other side closed/i.test(err?.message ?? '')
}

/**
 * Retry an async probe with exponential-ish backoff.
 *
 * `shouldRetry` decides; `onRetry` is for logging/tests. The final error is
 * rethrown unchanged so the caller's error mapping still applies.
 */
export async function retryWithBackoff<T>(
  operation: () => Promise<T>,
  options: {
    delays?: readonly number[]
    shouldRetry?: (error: unknown) => boolean
    onRetry?: (error: unknown, attempt: number, delayMs: number) => void
  } = {}
): Promise<T> {
  const delays = options.delays ?? OLLAMA_PROBE_DELAYS_MS
  const shouldRetry = options.shouldRetry ?? isRetryableProbeError
  let lastError: unknown
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      return await operation()
    } catch (error) {
      lastError = error
      if (attempt >= delays.length || !shouldRetry(error)) throw error
      const base = delays[attempt]
      const delay = base + Math.round(Math.random() * base * 0.25)
      options.onRetry?.(error, attempt + 1, delay)
      await new Promise((resolve) => setTimeout(resolve, delay))
    }
  }
  throw lastError
}

export class OllamaAdapter implements ProviderAdapter {
  kind = 'ollama' as const

  async listModels(baseUrl: string, _apiKey: string | null): Promise<ModelInfo[]> {
    const models = await retryWithBackoff(
      () => this.fetchModelsOnce(baseUrl),
      {
        onRetry: (error, attempt, delayMs) =>
          getLogger().debug(
            'ollama',
            `probe ${baseUrl} failed (attempt ${attempt}), retrying in ${delayMs}ms: ${(error as Error).message}`
          )
      }
    )
    return models
  }

  private async fetchModelsOnce(baseUrl: string): Promise<ModelInfo[]> {
    const controller = new AbortController()
    let res: Response
    try {
      res = await fetch(joinUrl(baseUrl, '/api/tags'), {
        signal: withTimeout(controller.signal, PROBE_TIMEOUT_MS)
      })
    } catch (e) {
      const err = e as Error
      // A timeout is as transient as a refused connection: a cold Ollama under
      // load can take longer than the probe window to answer /api/tags.
      const timedOut = err.name === 'TimeoutError' || err.name === 'AbortError'
      throw new ProviderError(
        `Could not reach Ollama at ${baseUrl}. Is it running? ${err.message}`,
        timedOut ? 'timeout' : 'unreachable'
      )
    }
    if (!res.ok) {
      // An HTTP answer means the server is up; retrying would not change it.
      throw new ProviderError(`Ollama returned HTTP ${res.status}`, 'http_error', res.status)
    }
    const body = (await res.json()) as { models?: OllamaTag[] }
    return (body.models ?? []).map((t) => toModelInfo(t, baseUrl))
  }

  async test(baseUrl: string, apiKey: string | null): Promise<ProviderStatus> {
    const started = Date.now()
    try {
      const models = await this.listModels(baseUrl, apiKey)
      return {
        providerId: '',
        state: 'connected',
        modelCount: models.length,
        latencyMs: Date.now() - started,
        checkedAt: Date.now(),
        message: models.length ? `${models.length} model(s) available` : 'Connected, no models installed'
      }
    } catch (e) {
      const err = e as ProviderError
      return {
        providerId: '',
        state: err.code === 'unreachable' ? 'unreachable' : 'error',
        message: err.message,
        latencyMs: Date.now() - started,
        checkedAt: Date.now()
      }
    }
  }

  async chat(baseUrl: string, apiKey: string | null, req: ChatRequest): Promise<ChatResult> {
    try {
      return await this.chatOnce(baseUrl, req, true)
    } catch (error) {
      // Some Ollama versions answer 400 rather than ignoring an unsupported
      // `tools` array, and a few model templates raise "does not support tools".
      // Retrying without tools lets the caller fall back to the JSON protocol
      // instead of failing the whole turn. Only a tool-shaped rejection is
      // retried, so a genuine model error is still reported once.
      const err = error as ProviderError
      const toolShaped = /tool|function/i.test(err.message)
      if (req.tools?.length && toolShaped) {
        return this.chatOnce(baseUrl, req, false)
      }
      throw error
    }
  }

  private async chatOnce(
    baseUrl: string,
    req: ChatRequest,
    withTools: boolean
  ): Promise<ChatResult> {
    const body: Record<string, unknown> = {
      model: req.model,
      messages: mapMessages(req.messages),
      stream: true,
      // Keep the model resident between turns so the user does not pay a reload
      // on the first message after a pause.
      keep_alive: OLLAMA_KEEP_ALIVE
    }
    const tools = withTools ? mapTools(req.tools) : undefined
    if (tools) body.tools = tools
    if (req.temperature !== undefined) body.options = { temperature: req.temperature }

    let res: Response
    try {
      res = await fetch(joinUrl(baseUrl, '/api/chat'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: req.signal
      })
    } catch (e) {
      const err = e as Error
      if (err.name === 'AbortError') throw err
      throw new ProviderError(`Ollama request failed: ${err.message}`, 'unreachable')
    }
    if (!res.ok) {
      const text = await safeText(res)
      if (res.status === 404) {
        throw new ProviderError(
          `Model "${req.model}" was not found in Ollama. Pull it or select another model.`,
          'model_not_found',
          404
        )
      }
      throw new ProviderError(`Ollama HTTP ${res.status}: ${text}`, 'http_error', res.status)
    }
    if (!res.body) throw new ProviderError('Ollama returned no response body', 'empty')

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let content = ''
    const toolCalls: ChatToolCall[] = []
    let usage = undefined as ChatResult['usage']
    let finishReason: string | undefined

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let idx: number
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).trim()
        buffer = buffer.slice(idx + 1)
        if (!line) continue
        let obj: OllamaChatLine
        try {
          obj = JSON.parse(line)
        } catch {
          continue
        }
        if (obj.error) throw new ProviderError(obj.error, 'model_error')
        const msg = obj.message
        if (msg?.thinking) req.onDelta?.({ thinking: msg.thinking })
        if (msg?.content) {
          content += msg.content
          req.onDelta?.({ content: msg.content })
        }
        if (msg?.tool_calls) {
          for (const tc of msg.tool_calls) {
            const name = tc.function?.name ?? ''
            if (!name) continue
            toolCalls.push({
              id: `call_${Math.random().toString(36).slice(2, 10)}`,
              name,
              arguments: tc.function?.arguments ?? {}
            })
          }
        }
        if (obj.done) {
          finishReason = 'stop'
          if (obj.prompt_eval_count !== undefined || obj.eval_count !== undefined) {
            usage = {
              promptTokens: obj.prompt_eval_count,
              completionTokens: obj.eval_count,
              totalTokens: (obj.prompt_eval_count ?? 0) + (obj.eval_count ?? 0)
            }
          }
        }
      }
    }
    return { content, toolCalls, usage, finishReason }
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 500)
  } catch {
    return ''
  }
}
