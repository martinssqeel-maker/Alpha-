import type { ChatUsage, ModelCapabilities, ModelInfo, ProviderStatus } from '@shared/types'
import { withTimeout, ProviderError, type ChatDelta, type ChatRequest, type ChatResult, type ProviderAdapter } from './types'

export interface GatewayContext {
  getToken(): Promise<string | null>
  apiBaseUrl(): string
}

interface GatewayModelItem {
  modelId: string
  label?: string
  providerLabel?: string
  capabilities?: Partial<ModelCapabilities>
  contextLength?: number
}

interface GatewayErrorPayload {
  error?: { code?: string; message?: string } | string
}

interface ChatStreamItem {
  choices?: {
    delta?: {
      content?: string
      reasoning?: string
      tool_calls?: { index: number; id?: string; function?: { name?: string; arguments?: string } }[]
    }
    finish_reason?: string | null
  }[]
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
  error?: { code?: string; message?: string }
}

export interface GatewayToolCallDelta {
  index: number
  id?: string
  name?: string
  arguments?: string
}

export interface GatewaySseEvent {
  kind: 'delta' | 'done' | 'error'
  delta?: ChatDelta
  finishReason?: string
  usage?: ChatUsage
  toolCalls?: GatewayToolCallDelta[]
  error?: ProviderError
}

/** Parse a single SSE line from the gateway (OpenAI-compatible framing). */
export function parseGatewaySseLine(line: string): GatewaySseEvent | null {
  const raw = line.trim()
  if (!raw) return null
  if (raw === 'data: [DONE]') return { kind: 'done' }
  const jsonBody = raw.startsWith('data:') ? raw.slice(5).trim() : raw
  if (!jsonBody) return null
  let obj: ChatStreamItem
  try {
    obj = JSON.parse(jsonBody) as ChatStreamItem
  } catch {
    return null
  }
  if (obj.error) {
    return {
      kind: 'error',
      error: new ProviderError(obj.error.message ?? 'Gateway error.', obj.error.code ?? 'gateway', 502)
    }
  }
  const choice = obj.choices?.[0]
  const delta = choice?.delta
  const ev: GatewaySseEvent = { kind: 'delta' }
  if (delta?.content) ev.delta = { content: delta.content }
  else if (delta?.reasoning) ev.delta = { thinking: delta.reasoning }
  if (delta?.tool_calls?.length) {
    ev.toolCalls = delta.tool_calls.map((t) => ({
      index: t.index,
      id: t.id,
      name: t.function?.name,
      arguments: t.function?.arguments
    }))
  }
  if (typeof choice?.finish_reason === 'string' && choice.finish_reason) ev.finishReason = choice.finish_reason
  if (obj.usage) {
    ev.usage = {
      promptTokens: obj.usage.prompt_tokens ?? 0,
      completionTokens: obj.usage.completion_tokens ?? 0,
      totalTokens: obj.usage.total_tokens
    }
  }
  return ev
}

/** Cloud provider backed by the Alpha Cloud API gateway. */
export class GatewayAdapter implements ProviderAdapter {
  readonly kind = 'gateway' as const

  constructor(private context: () => GatewayContext) {}

  private base(): string {
    return this.context().apiBaseUrl().replace(/\/+$/, '')
  }

  private async authHeaders(): Promise<{ Authorization: string; 'Content-Type': string }> {
    const token = await this.context().getToken()
    if (!token) throw new ProviderError('Sign in to your Alpha account to use cloud models.', 'unauthorized', 401)
    return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
  }

  async listModels(): Promise<ModelInfo[]> {
    const res = await this.get('/gateway/models')
    const data = res as { models?: GatewayModelItem[] }
    const items = Array.isArray(data?.models) ? data.models : []
    return items.map((m) => ({
      id: m.modelId,
      name: m.label ?? m.modelId,
      providerId: '',
      providerName: m.providerLabel ?? 'Alpha Cloud',
      providerKind: 'gateway',
      local: false,
      capabilities: {
        streaming: m.capabilities?.streaming ?? true,
        tools: m.capabilities?.tools ?? false,
        vision: m.capabilities?.vision ?? false
      },
      contextLength: m.contextLength
    }))
  }

  async test(): Promise<ProviderStatus> {
    try {
      const models = await this.listModels()
      return {
        providerId: '',
        state: 'connected',
        message: 'Connected to Alpha Cloud',
        modelCount: models.length,
        latencyMs: undefined,
        checkedAt: 0
      }
    } catch (e) {
      const err = e as ProviderError
      return {
        providerId: '',
        state: err.status === 401 || err.status === 403 ? 'error' : 'unreachable',
        message: err.message,
        latencyMs: undefined,
        checkedAt: 0
      }
    }
  }

  async chat(_baseUrl: string, _apiKey: string | null, req: ChatRequest): Promise<ChatResult> {
    const url = `${this.base()}/gateway/chat/completions`
    const headers = await this.authHeaders()
    const signal = withTimeout(req.signal, 5 * 60_000)
    const body = {
      model: req.model,
      messages: req.messages,
      tools: req.tools,
      stream: true,
      temperature: req.temperature
    }

    let res: Response
    try {
      res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal })
    } catch (e) {
      if (signal.aborted) throw new ProviderError('Request cancelled.', 'aborted', 499)
      throw new ProviderError(`Gateway unreachable: ${(e as Error).message}`, 'network')
    }
    if (!res.ok) {
      throw new ProviderError(await this.readError(res), await this.errorCode(res), res.status)
    }
    if (!res.body) {
      throw new ProviderError('Gateway returned no response stream.', 'empty')
    }

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let content = ''
    const toolAccum = new Map<number, { id: string; name: string; args: string }>()
    let usage: ChatResult['usage']
    let finishReason: string | undefined

    const flushLine = (raw: string) => {
      const parsed = parseGatewaySseLine(raw)
      if (!parsed) return
      if (parsed.kind === 'error') throw parsed.error
      if (parsed.kind === 'done') return
      if (parsed.delta?.content) {
        content += parsed.delta.content
        req.onDelta?.({ content: parsed.delta.content })
      } else if (parsed.delta?.thinking) {
        req.onDelta?.({ thinking: parsed.delta.thinking })
      }
      if (parsed.toolCalls) {
        for (const t of parsed.toolCalls) {
          const cur = toolAccum.get(t.index) ?? { id: '', name: '', args: '' }
          if (t.id) cur.id = t.id
          if (t.name) cur.name = t.name
          if (t.arguments) cur.args += t.arguments
          toolAccum.set(t.index, cur)
        }
      }
      if (parsed.finishReason) finishReason = parsed.finishReason
      if (parsed.usage) usage = parsed.usage
    }

    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let idx: number
        while ((idx = buffer.indexOf('\n')) >= 0) {
          const raw = buffer.slice(0, idx)
          buffer = buffer.slice(idx + 1)
          if (raw.trim()) flushLine(raw)
        }
      }
      if (buffer.trim()) flushLine(buffer)
    } catch (e) {
      if (e instanceof ProviderError) throw e
      if (req.signal.aborted) throw new ProviderError('Request cancelled.', 'aborted', 499)
      throw new ProviderError(`Gateway stream failed: ${(e as Error).message}`, 'network')
    } finally {
      reader.releaseLock()
    }

    if (finishReason === 'content_filter') {
      throw new ProviderError('The response was blocked by the platform content policy.', 'content_policy', 451)
    }
    const toolCalls: ChatResult['toolCalls'] = [...toolAccum.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, t]) => ({
        id: t.id || `call_${Math.random().toString(36).slice(2)}`,
        name: t.name,
        arguments: parseArgs(t.args)
      }))
    return { content, toolCalls, usage, finishReason }
  }

  private async get(path: string): Promise<unknown> {
    const url = `${this.base()}${path}`
    const headers = await this.authHeaders()
    const signal = withTimeout(new AbortController().signal, 30_000)
    let res: Response
    try {
      res = await fetch(url, { method: 'GET', headers, signal })
    } catch (e) {
      throw new ProviderError(`Gateway unreachable: ${(e as Error).message}`, 'network')
    }
    if (!res.ok) throw new ProviderError(await this.readError(res), await this.errorCode(res), res.status)
    return (await res.json()) as unknown
  }

  private async readError(res: Response): Promise<string> {
    try {
      const body = (await res.json()) as GatewayErrorPayload
      const err = body.error
      if (typeof err === 'string') return err
      if (err?.message) return err.message
    } catch {
      /* fall through */
    }
    return `Gateway request failed (${res.status}).`
  }

  private async errorCode(res: Response): Promise<string> {
    try {
      const body = (await res.json()) as GatewayErrorPayload
      const err = body.error
      if (err && typeof err !== 'string' && err.code) return err.code
    } catch {
      /* fall through */
    }
    return String(res.status)
  }
}

function parseArgs(raw: string): unknown {
  if (!raw) return {}
  try {
    return JSON.parse(raw)
  } catch {
    return {}
  }
}