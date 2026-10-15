import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type {
  HardwareInfo,
  ModelInfo,
  OllamaCatalogEntry,
  OllamaFit,
  OllamaPullProgress,
  OllamaPullResult,
  OllamaRecommendation,
  OllamaStatus
} from '@shared/types'
import { getLogger } from './logger'
import { ProviderError } from './providers/types'
import type { ProviderRegistry } from './providers/registry'

/** The official download page. The app links to it; it never runs an installer. */
export const OLLAMA_DOWNLOAD_URL = 'https://ollama.com/download'

/** How long a preloaded model is kept warm in memory. */
export const OLLAMA_PRELOAD_KEEP_ALIVE = '15m'

/** A preload older than this is repeated rather than assumed still warm. */
const PRELOAD_FRESH_MS = 10 * 60 * 1000

const GIB = 1024 ** 3

/**
 * Curated entries from the official Ollama model library.
 *
 * `approxBytes` is the approximate default (Q4) download size and `minRamGb` is
 * guidance for running the model alongside the OS and a working context — both
 * are labelled as approximations in the UI, because the exact figures come from
 * Ollama itself when a pull starts. Only model *names* are asserted here; whether
 * a model is installed, its real size and its capabilities are all read from the
 * running Ollama service at runtime.
 */
export const OLLAMA_CATALOG: OllamaCatalogEntry[] = [
  {
    name: 'qwen3:1.7b',
    title: 'Qwen3 1.7B',
    description: 'Small, fast, tool-capable general model. A good first local model on modest hardware.',
    categories: ['general', 'fast', 'tools'],
    params: '2.0B',
    approxBytes: 1.36 * GIB,
    minRamGb: 4
  },
  {
    name: 'llama3.2:1b',
    title: 'Llama 3.2 1B',
    description: 'Very light general model for quick answers and short edits.',
    categories: ['general', 'fast'],
    params: '1.2B',
    approxBytes: 1.3 * GIB,
    minRamGb: 4
  },
  {
    name: 'qwen2.5-coder:1.5b',
    title: 'Qwen2.5 Coder 1.5B',
    description: 'Small code-focused model; good for completions and small refactors.',
    categories: ['coding', 'fast'],
    params: '1.5B',
    approxBytes: 0.99 * GIB,
    minRamGb: 4
  },
  {
    name: 'deepseek-r1:1.5b',
    title: 'DeepSeek R1 1.5B',
    description: 'Compact reasoning model that shows its thinking before answering.',
    categories: ['reasoning', 'fast'],
    params: '1.8B',
    approxBytes: 1.1 * GIB,
    minRamGb: 4
  },
  {
    name: 'llama3.2:3b',
    title: 'Llama 3.2 3B',
    description: 'Balanced general model — noticeably more capable than the 1B, still light.',
    categories: ['general', 'tools'],
    params: '3.2B',
    approxBytes: 2.0 * GIB,
    minRamGb: 5
  },
  {
    name: 'qwen3:4b',
    title: 'Qwen3 4B',
    description: 'Strong mid-size general model with tool calling.',
    categories: ['general', 'tools'],
    params: '4.0B',
    approxBytes: 2.5 * GIB,
    minRamGb: 6
  },
  {
    name: 'gemma3:4b',
    title: 'Gemma 3 4B',
    description: 'Multimodal general model (text + images).',
    categories: ['general', 'vision'],
    params: '4.3B',
    approxBytes: 3.3 * GIB,
    minRamGb: 6
  },
  {
    name: 'mistral:7b',
    title: 'Mistral 7B',
    description: 'Long-standing 7B general model with a wide ecosystem.',
    categories: ['general'],
    params: '7.2B',
    approxBytes: 4.4 * GIB,
    minRamGb: 10
  },
  {
    name: 'qwen2.5-coder:7b',
    title: 'Qwen2.5 Coder 7B',
    description: 'Well-regarded 7B coding model for real editing work.',
    categories: ['coding'],
    params: '7.6B',
    approxBytes: 4.7 * GIB,
    minRamGb: 10
  },
  {
    name: 'llava:7b',
    title: 'LLaVA 7B',
    description: 'Vision model: describe images and screenshots you attach.',
    categories: ['vision'],
    params: '7B',
    approxBytes: 4.7 * GIB,
    minRamGb: 10
  },
  {
    name: 'deepseek-r1:8b',
    title: 'DeepSeek R1 8B',
    description: 'Reasoning model with visible thinking; slower but more careful.',
    categories: ['reasoning'],
    params: '8.2B',
    approxBytes: 4.9 * GIB,
    minRamGb: 10
  },
  {
    name: 'qwen3:8b',
    title: 'Qwen3 8B',
    description: 'Higher-quality general model with tool calling — wants a roomy machine.',
    categories: ['general', 'tools'],
    params: '8.2B',
    approxBytes: 5.2 * GIB,
    minRamGb: 12
  },
  {
    name: 'gemma3:12b',
    title: 'Gemma 3 12B',
    description: 'Large multimodal model; strong quality, needs a lot of memory.',
    categories: ['general', 'vision'],
    params: '12.2B',
    approxBytes: 8.1 * GIB,
    minRamGb: 16
  },
  {
    name: 'phi4:14b',
    title: 'Phi-4 14B',
    description: 'Reasoning-heavy 14B model for demanding machines.',
    categories: ['reasoning'],
    params: '14.7B',
    approxBytes: 9.1 * GIB,
    minRamGb: 18
  }
]

function round1(value: number): number {
  return Math.round(value * 10) / 10
}

/**
 * How comfortably a model fits this machine.
 *
 * Deliberately conservative and explainable: it compares the model's download
 * size plus a working-set allowance against reported memory. It is guidance, not
 * a benchmark, and the UI says so.
 */
export function assessFit(entry: OllamaCatalogEntry, hw: HardwareInfo): OllamaRecommendation {
  const modelGb = round1(entry.approxBytes / GIB)
  const needed = Math.max(entry.minRamGb, Math.ceil(modelGb * 1.5 + 1))
  const vram = hw.gpu?.vramGb ?? 0
  const workspaceGb = round1(modelGb * 0.5 + 1)
  let fit: OllamaFit

  if (hw.totalRamGb >= needed + 3 || (vram && vram >= modelGb + workspaceGb)) {
    fit = 'comfortable'
  } else if (hw.totalRamGb >= needed) {
    fit = 'tight'
  } else {
    fit = 'too-large'
  }

  const parts: string[] = []
  if (fit === 'comfortable') {
    parts.push(`~${modelGb} GB download fits in ${hw.totalRamGb} GB RAM with room to spare`)
  } else if (fit === 'tight') {
    parts.push(`~${modelGb} GB download will run in ${hw.totalRamGb} GB RAM, but close to the limit`)
  } else {
    parts.push(`~${modelGb} GB download needs about ${needed} GB RAM; this machine reports ${hw.totalRamGb} GB`)
  }
  if (hw.gpu && hw.gpu.vramGb) {
    parts.push(`GPU ${hw.gpu.name} (${hw.gpu.vramGb} GB VRAM)`)
  } else {
    parts.push('no discrete GPU detected — expect CPU-speed generation')
  }
  if (hw.freeRamGb < 2) parts.push(`only ${hw.freeRamGb} GB RAM is free right now`)

  return { model: entry, fit, needed, reason: parts.join(' · ') }
}

interface OllamaPullLine {
  status?: string
  digest?: string
  total?: number
  completed?: number
  error?: string
}

/** Candidates for a local install, so we can say "installed but not running". */
function installCandidates(): string[] {
  const list: string[] = []
  if (process.env.LOCALAPPDATA) {
    list.push(path.join(process.env.LOCALAPPDATA, 'Programs', 'Ollama', 'ollama.exe'))
  }
  if (process.platform === 'win32') list.push('C:\\Program Files\\Ollama\\ollama.exe')
  else list.push('/usr/local/bin/ollama', '/usr/bin/ollama', '/opt/homebrew/bin/ollama')
  return list
}

async function defaultInstallProbe(): Promise<boolean> {
  for (const candidate of installCandidates()) {
    try {
      if (existsSync(candidate)) return true
    } catch {
      /* unreadable path: keep looking */
    }
  }
  // PATH install: `ollama --version` exits non-zero on some builds, but it only
  // needs to be *spawnable* to prove the CLI is present.
  return await new Promise<boolean>((resolve) => {
    execFile('ollama', ['--version'], { timeout: 3000, windowsHide: true }, (error) => {
      const code = (error as NodeJS.ErrnoException | null)?.code
      resolve(!error || code !== 'ENOENT')
    })
  })
}

async function defaultGpuProbe(): Promise<HardwareInfo['gpu']> {
  return await new Promise((resolve) => {
    execFile(
      'nvidia-smi',
      ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits'],
      { timeout: 2500, windowsHide: true },
      (error, stdout) => {
        if (error || !stdout) {
          resolve(null)
          return
        }
        const line = stdout.split('\n')[0]?.trim()
        if (!line) {
          resolve(null)
          return
        }
        const [name, vramMb] = line.split(',').map((part) => part.trim())
        const mb = Number.parseInt(vramMb ?? '', 10)
        resolve({ name: name || 'NVIDIA GPU', vramGb: Number.isFinite(mb) ? round1(mb / 1024) : 0 })
      }
    )
  })
}

export interface OllamaPreloadOutcome {
  ok: boolean
  message?: string
  cached?: boolean
}

export interface OllamaManagerDeps {
  registry: ProviderRegistry
  baseUrl: () => string
  emit: (event: OllamaPullProgress) => void
  installProbe?: () => Promise<boolean>
  gpuProbe?: () => Promise<HardwareInfo['gpu']>
  hardwareProbe?: () => Promise<HardwareInfo>
}

const PULL_TIMEOUT_MS = 60 * 60 * 1000

export class OllamaManager {
  private inflight = new Map<string, AbortController>()
  private preloaded: { model: string; at: number } | null = null
  private cachedHardware: HardwareInfo | null = null
  private lastProbe: { installed: boolean; at: number } | null = null

  constructor(private deps: OllamaManagerDeps) {}

  private get base(): string {
    return this.deps.baseUrl().replace(/\/+$/, '')
  }

  /** Local install is only checked occasionally; it needs a process spawn. */
  private async installed(): Promise<boolean> {
    const now = Date.now()
    if (this.lastProbe && now - this.lastProbe.at < 60_000) return this.lastProbe.installed
    const probe = this.deps.installProbe ?? defaultInstallProbe
    let installed = false
    try {
      installed = await probe()
    } catch {
      installed = false
    }
    this.lastProbe = { installed, at: now }
    return installed
  }

  async hardware(force = false): Promise<HardwareInfo> {
    if (this.cachedHardware && !force) return this.cachedHardware
    if (this.deps.hardwareProbe) {
      this.cachedHardware = await this.deps.hardwareProbe()
      return this.cachedHardware
    }
    const probe = this.deps.gpuProbe ?? defaultGpuProbe
    let gpu: HardwareInfo['gpu'] = null
    try {
      gpu = await probe()
    } catch {
      gpu = null
    }
    const cpus = os.cpus()
    this.cachedHardware = {
      totalRamGb: round1(os.totalmem() / GIB),
      freeRamGb: round1(os.freemem() / GIB),
      cpuCount: cpus.length,
      cpuModel: cpus[0]?.model?.trim() || 'unknown CPU',
      gpu,
      platform: `${os.platform()} ${os.arch()}`,
      probedAt: Date.now()
    }
    return this.cachedHardware
  }

  /**
   * Detect Ollama and read its installed models.
   *
   * "Installed" and "running" are reported separately on purpose: a missing
   * service is a different problem from a missing install, and only the second
   * one should send the user to the download page.
   */
  async status(): Promise<OllamaStatus> {
    const baseUrl = this.base
    const base: Omit<OllamaStatus, 'reachable' | 'installed' | 'models' | 'message'> = {
      baseUrl,
      installUrl: OLLAMA_DOWNLOAD_URL
    }
    let version: string | undefined
    let models: ModelInfo[] = []
    try {
      const res = await fetch(`${baseUrl}/api/version`, { signal: AbortSignal.timeout(4000) })
      if (!res.ok) throw new ProviderError(`Ollama answered HTTP ${res.status}`, 'http_error', res.status)
      const body = (await res.json()) as { version?: string }
      version = body.version
      models = await this.deps.registry.modelsFor(this.ollamaProviderId())
    } catch (e) {
      const installed = await this.installed()
      const err = e as Error
      getLogger().debug('ollama', `status probe failed: ${err.message}`)
      return {
        ...base,
        reachable: false,
        installed,
        models: [],
        message: installed
          ? 'Ollama is installed but its service is not answering. Start Ollama and refresh.'
          : 'Ollama was not found on this machine. Install it, then refresh.'
      }
    }
    return { ...base, reachable: true, installed: true, version, models }
  }

  catalog(): OllamaCatalogEntry[] {
    return OLLAMA_CATALOG
  }

  /** Catalog entries ranked for this machine, best fit first. */
  async recommendations(): Promise<OllamaRecommendation[]> {
    const hw = await this.hardware()
    const rank: Record<OllamaFit, number> = { comfortable: 0, tight: 1, 'too-large': 2 }
    return OLLAMA_CATALOG.map((entry) => assessFit(entry, hw)).sort((a, b) => {
      if (rank[a.fit] !== rank[b.fit]) return rank[a.fit] - rank[b.fit]
      return b.model.approxBytes - a.model.approxBytes
    })
  }

  private ollamaProviderId(): string {
    const provider = this.deps.registry.list().find((p) => p.kind === 'ollama')
    if (provider) return provider.id
    // No saved Ollama provider yet: register the configured URL so `modelsFor`
    // has something real to query instead of failing with "not found".
    return this.deps.registry.ensureLocalOllama(this.base).id
  }

  /**
   * Start a real `ollama pull`.
   *
   * Progress comes from Ollama's own NDJSON stream, so the numbers shown are the
   * download's actual totals rather than an estimate. One pull per model: a
   * second request for the same model is refused instead of double-downloading.
   */
  async pull(
    model: string,
    onProgress?: (progress: OllamaPullProgress) => void
  ): Promise<OllamaPullResult> {
    const name = model.trim()
    if (!name) return { ok: false, model: name, message: 'A model name is required.' }
    if (this.inflight.has(name)) {
      return { ok: false, model: name, message: `${name} is already downloading.` }
    }
    const controller = new AbortController()
    this.inflight.set(name, controller)
    const report = (progress: OllamaPullProgress): void => {
      onProgress?.(progress)
      this.deps.emit(progress)
    }
    const started = Date.now()
    try {
      const res = await fetch(`${this.base}/api/pull`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: name, stream: true }),
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(PULL_TIMEOUT_MS)])
      })
      if (!res.ok || !res.body) {
        const detail = await res.text().catch(() => '')
        const message =
          res.status === 404
            ? `Ollama has no model called "${name}". Check the name on ollama.com/library.`
            : `Ollama refused the download (HTTP ${res.status}). ${detail.slice(0, 200)}`.trim()
        report({ model: name, state: 'error', status: 'failed', message })
        return { ok: false, model: name, message }
      }

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let last: OllamaPullProgress = { model: name, state: 'pulling', status: 'starting' }
      let succeeded = false

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let index: number
        while ((index = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, index).trim()
          buffer = buffer.slice(index + 1)
          if (!line) continue
          let parsed: OllamaPullLine
          try {
            parsed = JSON.parse(line) as OllamaPullLine
          } catch {
            continue
          }
          if (parsed.error) {
            last = { model: name, state: 'error', status: 'failed', message: parsed.error }
            report(last)
            return { ok: false, model: name, message: parsed.error }
          }
          const percent =
            parsed.total && parsed.completed !== undefined
              ? Math.min(100, Math.round((parsed.completed / parsed.total) * 100))
              : undefined
          last = {
            model: name,
            state: 'pulling',
            status: parsed.status ?? 'downloading',
            completed: parsed.completed,
            total: parsed.total,
            percent
          }
          report(last)
          if (parsed.status === 'success') succeeded = true
        }
      }

      const elapsedMs = Date.now() - started
      if (!succeeded) {
        report({ model: name, state: 'error', status: 'failed', message: 'The download ended early.' })
        return { ok: false, model: name, message: 'The download ended before Ollama reported success.' }
      }
      report({ model: name, state: 'done', status: 'success', percent: 100, elapsedMs })
      getLogger().info('ollama', `pulled ${name} in ${elapsedMs}ms`)
      return { ok: true, model: name, elapsedMs }
    } catch (e) {
      const err = e as Error
      if (err.name === 'AbortError' || err.name === 'TimeoutError') {
        const cancelled = controller.signal.aborted
        const message = cancelled
          ? 'Download cancelled.'
          : 'The download timed out after an hour of no completion.'
        report({ model: name, state: cancelled ? 'cancelled' : 'error', status: 'stopped', message })
        return { ok: false, model: name, message, cancelled }
      }
      const message = `Could not reach Ollama at ${this.base}: ${err.message}`
      report({ model: name, state: 'error', status: 'failed', message })
      return { ok: false, model: name, message }
    } finally {
      this.inflight.delete(name)
    }
  }

  /**
   * Load a model into memory before it is needed.
   *
   * This is the app's main lever on time-to-first-token: a request that has to
   * load the model first waits for the load. Selecting a model is a clear signal
   * the user is about to ask something, so the load is paid while they type.
   * Repeat calls for the same model within a few minutes are no-ops.
   */
  async preload(model: string): Promise<OllamaPreloadOutcome> {
    const name = model.trim()
    if (!name) return { ok: false, message: 'A model name is required.' }
    if (this.preloaded?.model === name && Date.now() - this.preloaded.at < PRELOAD_FRESH_MS) {
      return { ok: true, cached: true }
    }
    try {
      const res = await fetch(`${this.base}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: name, prompt: '', keep_alive: OLLAMA_PRELOAD_KEEP_ALIVE }),
        signal: AbortSignal.timeout(180_000)
      })
      if (!res.ok) {
        const detail = await res.text().catch(() => '')
        return {
          ok: false,
          message: `Ollama could not load ${name} (HTTP ${res.status}). ${detail.slice(0, 200)}`.trim()
        }
      }
      // The body is a small stream; drain it so the socket is released.
      await res.text().catch(() => '')
      this.preloaded = { model: name, at: Date.now() }
      getLogger().info('ollama', `preloaded ${name}`)
      return { ok: true }
    } catch (e) {
      return { ok: false, message: `Could not load ${name}: ${(e as Error).message}` }
    }
  }

  cancelPull(model: string): boolean {
    const controller = this.inflight.get(model.trim())
    if (!controller) return false
    controller.abort()
    return true
  }

  /** True while a model is being downloaded (used to keep the UI honest). */
  isPulling(model: string): boolean {
    return this.inflight.has(model.trim())
  }

  activePulls(): string[] {
    return [...this.inflight.keys()]
  }

  async remove(model: string): Promise<OllamaPullResult> {
    const name = model.trim()
    if (!name) return { ok: false, model: name, message: 'A model name is required.' }
    if (this.inflight.has(name)) {
      return { ok: false, model: name, message: 'Cancel the download before removing this model.' }
    }
    try {
      const res = await fetch(`${this.base}/api/delete`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: name }),
        signal: AbortSignal.timeout(15_000)
      })
      if (res.status === 404) {
        return { ok: false, model: name, message: `Ollama does not have "${name}" installed.` }
      }
      if (!res.ok) {
        const detail = await res.text().catch(() => '')
        return {
          ok: false,
          model: name,
          message: `Ollama refused to remove the model (HTTP ${res.status}). ${detail.slice(0, 200)}`.trim()
        }
      }
      getLogger().info('ollama', `removed ${name}`)
      return { ok: true, model: name }
    } catch (e) {
      return { ok: false, model: name, message: `Could not reach Ollama at ${this.base}: ${(e as Error).message}` }
    }
  }
}
