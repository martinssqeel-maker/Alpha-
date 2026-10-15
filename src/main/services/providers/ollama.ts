import type { ModelInfo, ProviderStatus, ToolDefinition } from '@shared/types'
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

export class OllamaAdapter implements ProviderAdapter {
  kind = 'ollama' as const

  async listModels(baseUrl: string, _apiKey: string | null): Promise<ModelInfo[]> {
    const controller = new AbortController()
    let res: Response
    try {
      res = await fetch(joinUrl(baseUrl, '/api/tags'), {
        signal: withTimeout(controller.signal, 8000)
      })
    } catch (e) {
      throw new ProviderError(
        `Could not reach Ollama at ${baseUrl}. Is it running? ${(e as Error).message}`,
        'unreachable'
      )
    }
    if (!res.ok) {
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

  async chat(baseUrl: string, _apiKey: string | null, req: ChatRequest): Promise<ChatResult> {
    const body: Record<string, unknown> = {
      model: req.model,
      messages: mapMessages(req.messages),
      stream: true,
      // Keep the model resident between turns so the user does not pay a reload
      // on the first message after a pause.
      keep_alive: OLLAMA_KEEP_ALIVE
    }
    const tools = mapTools(req.tools)
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
