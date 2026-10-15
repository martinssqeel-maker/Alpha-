import { randomUUID } from 'node:crypto'
import { providerEndpointProblem } from '@shared/providerUrl'
import type { ModelInfo, ProviderConfig, ProviderKind, ProviderStatus, ToolDefinition } from '@shared/types'
import { getLogger } from '../logger'
import type { SecretStore } from '../secrets'
import type { ProvidersRepo } from '../store'
import { OllamaAdapter } from './ollama'
import { OpenAICompatibleAdapter } from './openaiCompatible'
import { GatewayAdapter, type GatewayContext } from './gateway'
import { ProviderError, type ChatRequest, type ChatResult, type ProviderAdapter } from './types'

export interface ProviderPreset {
  id: string
  name: string
  kind: ProviderKind
  baseUrl: string
  needsKey: boolean
  local: boolean
  note: string
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: 'ollama',
    name: 'Ollama (local)',
    kind: 'ollama',
    baseUrl: 'http://127.0.0.1:11434',
    needsKey: false,
    local: true,
    note: 'Your existing local Ollama installation.'
  },
  {
    id: 'openai',
    name: 'OpenAI',
    kind: 'openai-compatible',
    baseUrl: 'https://api.openai.com/v1',
    needsKey: true,
    local: false,
    note: 'Cloud. Sends prompts to OpenAI.'
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    kind: 'openai-compatible',
    baseUrl: 'https://openrouter.ai/api/v1',
    needsKey: true,
    local: false,
    note: 'Cloud gateway to many models.'
  },
  {
    id: 'groq',
    name: 'Groq',
    kind: 'openai-compatible',
    baseUrl: 'https://api.groq.com/openai/v1',
    needsKey: true,
    local: false,
    note: 'Cloud. Fast hosted inference.'
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    kind: 'openai-compatible',
    baseUrl: 'https://api.deepseek.com/v1',
    needsKey: true,
    local: false,
    note: 'Cloud OpenAI-compatible API.'
  },
  {
    id: 'together',
    name: 'Together AI',
    kind: 'openai-compatible',
    baseUrl: 'https://api.together.xyz/v1',
    needsKey: true,
    local: false,
    note: 'Cloud OpenAI-compatible API.'
  },
  {
    id: 'lmstudio',
    name: 'LM Studio (local)',
    kind: 'openai-compatible',
    baseUrl: 'http://127.0.0.1:1234/v1',
    needsKey: false,
    local: true,
    note: 'Local server exposing an OpenAI-compatible API.'
  },
  {
    id: 'custom',
    name: 'Custom OpenAI-compatible',
    kind: 'openai-compatible',
    baseUrl: 'http://127.0.0.1:8000/v1',
    needsKey: false,
    local: true,
    note: 'Any endpoint that implements /chat/completions and /models.'
  }
]

export interface ResolvedTarget {
  provider: ProviderConfig
  adapter: ProviderAdapter
  apiKey: string | null
}

export class ProviderRegistry {
  private adapters: Record<ProviderKind, ProviderAdapter> = {
    ollama: new OllamaAdapter(),
    'openai-compatible': new OpenAICompatibleAdapter(),
    gateway: new GatewayAdapter(() => this.gatewayContext ?? emptyGatewayContext)
  }
  private statusCache: Record<string, ProviderStatus> = {}
  private gatewayContext: GatewayContext | null = null

  constructor(
    private repo: ProvidersRepo,
    private secrets: SecretStore
  ) {}

  static secretRef(providerId: string): string {
    return `provider:${providerId}:apiKey`
  }

  /** Wire the cloud gateway (platform token + API base URL). */
  attachGateway(ctx: GatewayContext): void {
    this.gatewayContext = ctx
  }

  /**
   * Keep the managed Alpha Cloud provider in sync with the platform session.
   * Created + enabled while signed in; removed when signed out.
   */
  syncGateway(opts: { apiBaseUrl: string; enabled: boolean }): void {
    const existing = this.repo.list().find((p) => p.kind === 'gateway')
    const cleaned = opts.apiBaseUrl.replace(/\/+$/, '')
    if (!opts.enabled || !cleaned) {
      if (existing) this.remove(existing.id)
      return
    }
    if (existing) {
      if (existing.baseUrl !== cleaned || !existing.enabled) {
        this.repo.save({
          id: existing.id,
          kind: 'gateway',
          name: 'Alpha Cloud',
          baseUrl: cleaned,
          enabled: true,
          isLocal: false,
          hasApiKey: false,
          preset: 'alpha-cloud'
        })
      }
      return
    }
    this.repo.save({
      kind: 'gateway',
      name: 'Alpha Cloud',
      baseUrl: cleaned,
      enabled: true,
      isLocal: false,
      hasApiKey: false,
      preset: 'alpha-cloud'
    })
  }

  presets(): ProviderPreset[] {
    return PROVIDER_PRESETS
  }

  list(): ProviderConfig[] {
    return this.repo.list()
  }

  get(id: string): ProviderConfig | null {
    return this.repo.get(id)
  }

  apiKeyFor(id: string): string | null {
    return this.secrets.get(ProviderRegistry.secretRef(id))
  }

  save(input: {
    id?: string
    kind: ProviderKind
    name: string
    baseUrl: string
    enabled?: boolean
    isLocal?: boolean
    preset?: string
    apiKey?: string
  }): ProviderConfig {
    // Defence in depth: the IPC schema already rejects a bad endpoint, but every
    // request for this provider is sent to `baseUrl`, so the registry refuses one
    // too rather than trusting its caller.
    const problem = providerEndpointProblem(input.baseUrl, input.kind)
    if (problem) throw new ProviderError(problem, 'invalid_endpoint')
    const saved = this.repo.save({
      id: input.id,
      kind: input.kind,
      name: input.name,
      baseUrl: input.baseUrl.replace(/\/+$/, ''),
      enabled: input.enabled ?? true,
      isLocal: input.isLocal ?? false,
      hasApiKey: input.apiKey ? true : input.id ? this.repo.get(input.id)?.hasApiKey ?? false : false,
      preset: input.preset
    })
    if (input.apiKey) {
      this.secrets.set(ProviderRegistry.secretRef(saved.id), input.apiKey)
    }
    return saved
  }

  remove(id: string): void {
    this.secrets.delete(ProviderRegistry.secretRef(id))
    this.repo.remove(id)
    delete this.statusCache[id]
  }

  ensureLocalOllama(url: string): ProviderConfig {
    const existing = this.repo.list().find((p) => p.kind === 'ollama')
    if (existing) return existing
    return this.repo.save({
      kind: 'ollama',
      name: 'Ollama (local)',
      baseUrl: url.replace(/\/+$/, ''),
      enabled: true,
      isLocal: true,
      hasApiKey: false,
      preset: 'ollama'
    })
  }

  async test(input: {
    id?: string
    kind: ProviderKind
    baseUrl: string
    apiKey?: string
  }): Promise<ProviderStatus> {
    const adapter = this.adapters[input.kind]
    const apiKey =
      input.apiKey ?? (input.id ? this.apiKeyFor(input.id) : null) ?? null
    const status = await adapter.test(input.baseUrl.replace(/\/+$/, ''), apiKey)
    return { ...status, providerId: input.id ?? '', checkedAt: Date.now() }
  }

  async modelsFor(id: string): Promise<ModelInfo[]> {
    const provider = this.repo.get(id)
    if (!provider) throw new ProviderError('Provider not found', 'not_found')
    if (!provider.enabled) return []
    const adapter = this.adapters[provider.kind]
    try {
      const models = await adapter.listModels(provider.baseUrl, this.apiKeyFor(id))
      return models.map((m) => ({
        ...m,
        providerId: provider.id,
        providerName: provider.name,
        providerKind: provider.kind,
        local: provider.isLocal || m.local
      }))
    } catch (e) {
      getLogger().debug('providers', `modelsFor(${provider.name}) failed: ${(e as Error).message}`)
      throw e
    }
  }

  async allModels(): Promise<ModelInfo[]> {
    const providers = this.repo.list().filter((p) => p.enabled)
    const results = await Promise.all(
      providers.map(async (p) => {
        try {
          return await this.modelsFor(p.id)
        } catch {
          return [] as ModelInfo[]
        }
      })
    )
    return results.flat()
  }

  async statuses(): Promise<ProviderStatus[]> {
    const providers = this.repo.list()
    const results = await Promise.all(
      providers.map(async (p): Promise<ProviderStatus> => {
        if (!p.enabled) {
          return { providerId: p.id, state: 'disabled', message: 'Disabled', checkedAt: Date.now() }
        }
        const status = await this.adapters[p.kind].test(p.baseUrl, this.apiKeyFor(p.id))
        return { ...status, providerId: p.id, checkedAt: Date.now() }
      })
    )
    for (const s of results) this.statusCache[s.providerId] = s
    return results
  }

  /** Non-blocking statuses backed by the last probe (no network I/O). */
  cachedStatuses(): ProviderStatus[] {
    return this.repo.list().map((p): ProviderStatus => {
      if (!p.enabled) {
        return { providerId: p.id, state: 'disabled', message: 'Disabled', checkedAt: Date.now() }
      }
      return (
        this.statusCache[p.id] ?? {
          providerId: p.id,
          state: 'unknown',
          message: 'Not checked yet',
          checkedAt: Date.now()
        }
      )
    })
  }

  resolve(providerId: string): ResolvedTarget {
    const provider = this.repo.get(providerId)
    if (!provider) throw new ProviderError('Provider not found', 'not_found')
    if (!provider.enabled) throw new ProviderError('Provider is disabled', 'disabled')
    return {
      provider,
      adapter: this.adapters[provider.kind],
      apiKey: this.apiKeyFor(providerId)
    }
  }

  async chat(
    providerId: string,
    req: Omit<ChatRequest, 'signal'> & { signal: AbortSignal }
  ): Promise<ChatResult> {
    const target = this.resolve(providerId)
    return target.adapter.chat(target.provider.baseUrl, target.apiKey, req)
  }

  async transcribe(
    providerId: string,
    audio: Buffer,
    mimeType: string,
    model?: string,
    language?: string
  ): Promise<string> {
    const target = this.resolve(providerId)
    if (!target.adapter.transcribe) {
      throw new ProviderError('This provider does not support transcription.', 'unsupported')
    }
    return target.adapter.transcribe(target.provider.baseUrl, target.apiKey, {
      audio,
      mimeType,
      model,
      language
    })
  }
}

export function providerToolSupport(kind: ProviderKind): boolean {
  return kind === 'ollama' || kind === 'openai-compatible' || kind === 'gateway'
}

export const emptyGatewayContext: GatewayContext = {
  async getToken() {
    return null
  },
  apiBaseUrl() {
    return ''
  }
}

export type { ChatRequest, ChatResult, ToolDefinition }
