import type { ModelInfo, ProviderStatus, ToolDefinition } from '@shared/types'
import {
  joinUrl,
  ProviderError,
  withTimeout,
  type ChatRequest,
  type ChatResult,
  type ChatToolCall,
  type ProviderAdapter,
  type ProviderMessage,
  type TranscribeRequest
} from './types'

interface OpenAIModel {
  id: string
  owned_by?: string
  context_length?: number
}

interface StreamToolCallDelta {
  index: number
  id?: string
  type?: string
  function?: { name?: string; arguments?: string }
}

interface StreamChoiceDelta {
  content?: string | null
  reasoning_content?: string | null
  tool_calls?: StreamToolCallDelta[]
}

interface StreamChunk {
  choices?: { delta?: StreamChoiceDelta; finish_reason?: string | null }[]
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
  error?: { message?: string }
}

function inferVision(id: string): boolean {
  return /(gpt-4o|gpt-4\.1|gpt-4-turbo|vision|claude-3|claude-4|gemini|llava|qwen2?\.?5?-?vl|pixtral)/i.test(
    id
  )
}

function toModelInfo(m: OpenAIModel, baseUrl: string): ModelInfo {
  return {
    id: m.id,
    name: m.id,
    providerId: '',
    providerName: '',
    providerKind: 'openai-compatible',
    local: /localhost|127\.0\.0\.1|0\.0\.0\.0/.test(baseUrl),
    capabilities: { streaming: true, tools: true, vision: inferVision(m.id) },
    contextLength: m.context_length
  }
}

function mapMessages(messages: ProviderMessage[]): unknown[] {
  return messages.map((m) => {
    if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length) {
      return {
        role: 'assistant',
        content: m.content || null,
        tool_calls: m.toolCalls.map((t) => ({
          id: t.id,
          type: 'function',
          function: { name: t.name, arguments: JSON.stringify(t.arguments ?? {}) }
        }))
      }
    }
    if (m.role === 'tool') {
      return { role: 'tool', tool_call_id: m.toolCallId, content: m.content }
    }
    if (m.images && m.images.length) {
      const parts: unknown[] = []
      if (m.content) parts.push({ type: 'text', text: m.content })
      for (const img of m.images) parts.push({ type: 'image_url', image_url: { url: img } })
      return { role: m.role, content: parts }
    }
    return { role: m.role, content: m.content }
  })
}

function mapTools(tools?: ToolDefinition[]): unknown[] | undefined {
  if (!tools || !tools.length) return undefined
  return tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters }
  }))
}

function authHeaders(apiKey: string | null): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' }
  if (apiKey) h.Authorization = `Bearer ${apiKey}`
  return h
}

export class OpenAICompatibleAdapter implements ProviderAdapter {
  kind = 'openai-compatible' as const

  async listModels(baseUrl: string, apiKey: string | null): Promise<ModelInfo[]> {
    let res: Response
    try {
      res = await fetch(joinUrl(baseUrl, '/models'), {
        headers: authHeaders(apiKey),
        signal: withTimeout(new AbortController().signal, 15000)
      })
    } catch (e) {
      throw new ProviderError(`Could not reach provider at ${baseUrl}: ${(e as Error).message}`, 'unreachable')
    }
    if (!res.ok) {
      if (res.status === 401 || res.status === 403) {
        throw new ProviderError('Authentication failed. Check the API key.', 'auth', res.status)
      }
      throw new ProviderError(`Provider returned HTTP ${res.status}`, 'http_error', res.status)
    }
    const body = (await res.json()) as { data?: OpenAIModel[]; models?: OpenAIModel[] }
    const list = body.data ?? body.models ?? []
    return list.map((m) => toModelInfo(m, baseUrl))
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
        message: `${models.length} model(s) available`
      }
    } catch (e) {
      const err = e as ProviderError
      const state =
        err.code === 'auth' ? 'error' : err.code === 'unreachable' ? 'unreachable' : 'error'
      return { providerId: '', state, message: err.message, latencyMs: Date.now() - started, checkedAt: Date.now() }
    }
  }

  async chat(baseUrl: string, apiKey: string | null, req: ChatRequest): Promise<ChatResult> {
    const body: Record<string, unknown> = {
      model: req.model,
      messages: mapMessages(req.messages),
      stream: true,
      stream_options: { include_usage: true }
    }
    const tools = mapTools(req.tools)
    if (tools) body.tools = tools
    if (req.temperature !== undefined) body.temperature = req.temperature

    let res: Response
    try {
      res = await fetch(joinUrl(baseUrl, '/chat/completions'), {
        method: 'POST',
        headers: authHeaders(apiKey),
        body: JSON.stringify(body),
        signal: req.signal
      })
    } catch (e) {
      const err = e as Error
      if (err.name === 'AbortError') throw err
      throw new ProviderError(`Provider request failed: ${err.message}`, 'unreachable')
    }
    if (!res.ok) {
      const text = await safeText(res)
      if (res.status === 401 || res.status === 403) {
        throw new ProviderError('Authentication failed. Check the API key.', 'auth', res.status)
      }
      if (res.status === 429) {
        throw new ProviderError('Provider rate limit reached. Try again later.', 'rate_limit', 429)
      }
      if (res.status === 404) {
        throw new ProviderError(`Model "${req.model}" not found at this provider.`, 'model_not_found', 404)
      }
      throw new ProviderError(`Provider HTTP ${res.status}: ${text}`, 'http_error', res.status)
    }
    if (!res.body) throw new ProviderError('Provider returned no response body', 'empty')

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let content = ''
    const toolAcc: Record<number, { id: string; name: string; args: string }> = {}
    let usage: ChatResult['usage']
    let finishReason: string | undefined

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let idx: number
      while ((idx = buffer.indexOf('\n')) >= 0) {
        let line = buffer.slice(0, idx)
        buffer = buffer.slice(idx + 1)
        line = line.trim()
        if (!line || line.startsWith(':')) continue
        if (!line.startsWith('data:')) continue
        const payload = line.slice(5).trim()
        if (payload === '[DONE]') continue
        let chunk: StreamChunk
        try {
          chunk = JSON.parse(payload)
        } catch {
          continue
        }
        if (chunk.error?.message) throw new ProviderError(chunk.error.message, 'model_error')
        const choice = chunk.choices?.[0]
        const delta = choice?.delta
        if (delta?.reasoning_content) req.onDelta?.({ thinking: delta.reasoning_content })
        if (delta?.content) {
          content += delta.content
          req.onDelta?.({ content: delta.content })
        }
        if (delta?.tool_calls) {
          for (const tc of delta.tool_calls) {
            const slot = toolAcc[tc.index] ?? (toolAcc[tc.index] = { id: '', name: '', args: '' })
            if (tc.id) slot.id = tc.id
            if (tc.function?.name) slot.name = tc.function.name
            if (tc.function?.arguments) slot.args += tc.function.arguments
          }
        }
        if (choice?.finish_reason) finishReason = choice.finish_reason
        if (chunk.usage) {
          usage = {
            promptTokens: chunk.usage.prompt_tokens,
            completionTokens: chunk.usage.completion_tokens,
            totalTokens: chunk.usage.total_tokens
          }
        }
      }
    }

    const toolCalls: ChatToolCall[] = Object.keys(toolAcc)
      .map((k) => Number(k))
      .sort((a, b) => a - b)
      .map((i) => {
        const slot = toolAcc[i]
        let args: unknown = {}
        try {
          args = slot.args ? JSON.parse(slot.args) : {}
        } catch {
          args = { _raw: slot.args }
        }
        return { id: slot.id || `call_${i}`, name: slot.name, arguments: args }
      })
      .filter((t) => t.name)

    return { content, toolCalls, usage, finishReason }
  }

  async transcribe(baseUrl: string, apiKey: string | null, req: TranscribeRequest): Promise<string> {
    const form = new FormData()
    const blob = new Blob([new Uint8Array(req.audio)], { type: req.mimeType || 'audio/webm' })
    form.append('file', blob, 'audio.webm')
    if (req.model) form.append('model', req.model)
    if (req.language) form.append('language', req.language)
    const headers: Record<string, string> = {}
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`
    let res: Response
    try {
      res = await fetch(joinUrl(baseUrl, '/audio/transcriptions'), {
        method: 'POST',
        headers,
        body: form,
        signal: withTimeout(new AbortController().signal, 120000)
      })
    } catch (e) {
      throw new ProviderError(`Transcription failed: ${(e as Error).message}`, 'unreachable')
    }
    if (!res.ok) {
      const text = await safeText(res)
      throw new ProviderError(`Transcription HTTP ${res.status}: ${text}`, 'http_error', res.status)
    }
    const body = (await res.json()) as { text?: string }
    return body.text ?? ''
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 500)
  } catch {
    return ''
  }
}
