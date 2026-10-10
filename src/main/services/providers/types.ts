import type { ChatUsage, ModelInfo, ProviderKind, ProviderStatus, ToolDefinition } from '@shared/types'

export interface ProviderMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  toolCalls?: { id: string; name: string; arguments: unknown }[]
  toolCallId?: string
  name?: string
  images?: string[]
}

export interface ChatDelta {
  content?: string
  thinking?: string
}

export interface ChatToolCall {
  id: string
  name: string
  arguments: unknown
}

export interface ChatRequest {
  model: string
  messages: ProviderMessage[]
  tools?: ToolDefinition[]
  signal: AbortSignal
  temperature?: number
  onDelta?: (delta: ChatDelta) => void
}

export interface ChatResult {
  content: string
  toolCalls: ChatToolCall[]
  usage?: ChatUsage
  finishReason?: string
}

export interface TranscribeRequest {
  audio: Buffer
  mimeType: string
  model?: string
  language?: string
}

export interface ProviderAdapter {
  kind: ProviderKind
  listModels(baseUrl: string, apiKey: string | null): Promise<ModelInfo[]>
  test(baseUrl: string, apiKey: string | null): Promise<ProviderStatus>
  chat(baseUrl: string, apiKey: string | null, req: ChatRequest): Promise<ChatResult>
  transcribe?(baseUrl: string, apiKey: string | null, req: TranscribeRequest): Promise<string>
}

export class ProviderError extends Error {
  code: string
  status?: number
  constructor(message: string, code: string, status?: number) {
    super(message)
    this.code = code
    this.status = status
  }
}

export function joinUrl(base: string, path: string): string {
  return base.replace(/\/+$/, '') + path
}

export function withTimeout(signal: AbortSignal, ms: number): AbortSignal {
  const timeout = AbortSignal.timeout(ms)
  return AbortSignal.any([signal, timeout])
}
