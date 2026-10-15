import { afterEach, describe, expect, it, vi } from 'vitest'
import { OLLAMA_CATALOG, OllamaManager, assessFit } from '../src/main/services/ollamaManager'
import type { ProviderRegistry } from '../src/main/services/providers/registry'
import type { HardwareInfo, OllamaPullProgress } from '../src/shared/types'
import { zOllamaModel } from '../src/shared/schemas'

const encoder = new TextEncoder()

function hardware(overrides: Partial<HardwareInfo> = {}): HardwareInfo {
  return {
    totalRamGb: 8,
    freeRamGb: 4,
    cpuCount: 8,
    cpuModel: 'Test CPU',
    gpu: null,
    platform: 'win32 x64',
    probedAt: Date.now(),
    ...overrides
  }
}

/** A fetch response whose body streams the given NDJSON lines. */
function ndjson(lines: string[], status = 200): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const line of lines) controller.enqueue(encoder.encode(`${line}\n`))
      controller.close()
    }
  })
  return new Response(body, { status })
}

/** A body that stays open until `release()` is called, so a pull can be held mid-flight. */
function heldResponse(): { response: Response; release: () => void } {
  let release = (): void => {}
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode('{"status":"pulling manifest"}\n'))
      release = () => {
        controller.enqueue(encoder.encode('{"status":"success"}\n'))
        controller.close()
      }
    }
  })
  return { response: new Response(body, { status: 200 }), release: () => release() }
}

function manager(opts: {
  registry?: Partial<ProviderRegistry>
  installProbe?: () => Promise<boolean>
  hw?: HardwareInfo
  emit?: (progress: OllamaPullProgress) => void
} = {}): OllamaManager {
  const registry = {
    list: () => [{ id: 'ollama-1', kind: 'ollama', baseUrl: 'http://127.0.0.1:11434' }],
    modelsFor: async () => [],
    ensureLocalOllama: () => ({ id: 'ollama-1' }),
    ...opts.registry
  } as unknown as ProviderRegistry
  return new OllamaManager({
    registry,
    baseUrl: () => 'http://127.0.0.1:11434',
    emit: opts.emit ?? (() => {}),
    installProbe: opts.installProbe ?? (async () => true),
    hardwareProbe: async () => opts.hw ?? hardware()
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('Ollama catalog', () => {
  it('only lists names the IPC schema will accept, and no duplicates', () => {
    const names = OLLAMA_CATALOG.map((entry) => entry.name)
    expect(new Set(names).size).toBe(names.length)
    for (const entry of OLLAMA_CATALOG) {
      // A catalog entry that the request schema rejects would be an un-installable
      // card: the guard keeps the two in step.
      expect(zOllamaModel.safeParse({ model: entry.name }).success, entry.name).toBe(true)
      expect(entry.approxBytes).toBeGreaterThan(0)
      expect(entry.minRamGb).toBeGreaterThan(0)
      expect(entry.description.length).toBeGreaterThan(10)
    }
  })
})

describe('assessFit', () => {
  it('calls a small model comfortable on a machine with headroom', () => {
    const entry = OLLAMA_CATALOG.find((e) => e.name === 'qwen3:1.7b')!
    const rec = assessFit(entry, hardware({ totalRamGb: 16, freeRamGb: 12 }))
    expect(rec.fit).toBe('comfortable')
    expect(rec.reason).toContain('16 GB RAM')
  })

  it('flags a large model as too big for this machine and says why', () => {
    const entry = OLLAMA_CATALOG.find((e) => e.name === 'phi4:14b')!
    const rec = assessFit(entry, hardware({ totalRamGb: 8, freeRamGb: 1 }))
    expect(rec.fit).toBe('too-large')
    expect(rec.reason).toContain('8 GB')
    expect(rec.reason).toContain('RAM is free')
  })

  it('marks the middle ground as a tight fit rather than failing it', () => {
    const entry = OLLAMA_CATALOG.find((e) => e.name === 'qwen2.5-coder:7b')!
    const rec = assessFit(entry, hardware({ totalRamGb: 10, freeRamGb: 3 }))
    expect(rec.fit).toBe('tight')
  })

  it('uses GPU memory when there is a discrete GPU', () => {
    const entry = OLLAMA_CATALOG.find((e) => e.name === 'deepseek-r1:8b')!
    const rec = assessFit(entry, hardware({ totalRamGb: 6, freeRamGb: 2, gpu: { name: 'RTX 4090', vramGb: 24 } }))
    expect(rec.fit).toBe('comfortable')
    expect(rec.reason).toContain('RTX 4090')
  })

  it('recommendations sort usable models first', async () => {
    const mgr = manager({ hw: hardware({ totalRamGb: 8, freeRamGb: 2 }) })
    const recs = await mgr.recommendations()
    const order = recs.map((r) => r.fit)
    expect(order.indexOf('comfortable')).toBeLessThan(order.indexOf('too-large'))
    expect(recs[0].fit).not.toBe('too-large')
  })
})

describe('Ollama status', () => {
  it('reports a missing install and points at the download page', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new Error('connect ECONNREFUSED'))))
    const mgr = manager({ installProbe: async () => false })
    const status = await mgr.status()
    expect(status.reachable).toBe(false)
    expect(status.installed).toBe(false)
    expect(status.message).toMatch(/not found/i)
    expect(status.installUrl).toBe('https://ollama.com/download')
    expect(status.models).toEqual([])
  })

  it('distinguishes installed-but-not-running from not installed', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new Error('connect ECONNREFUSED'))))
    const mgr = manager({ installProbe: async () => true })
    const status = await mgr.status()
    expect(status.installed).toBe(true)
    expect(status.reachable).toBe(false)
    expect(status.message).toMatch(/not answering|Start Ollama/i)
  })

  it('reports the version and installed models when it is running', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ version: '0.40.3' }), { status: 200 }))
    )
    const mgr = manager({
      registry: { modelsFor: async () => [{ id: 'qwen3:1.7b' }] } as never
    })
    const status = await mgr.status()
    expect(status.reachable).toBe(true)
    expect(status.version).toBe('0.40.3')
    expect(status.models).toHaveLength(1)
  })
})

describe('Ollama pull', () => {
  it('streams real byte progress and succeeds', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        ndjson([
          '{"status":"pulling manifest"}',
          '{"status":"downloading","total":1000,"completed":250}',
          '{"status":"downloading","total":1000,"completed":1000}',
          '{"status":"success"}'
        ])
      )
    )
    const seen: OllamaPullProgress[] = []
    const mgr = manager({ emit: (p) => seen.push(p) })
    const result = await mgr.pull('llama3.2:1b')

    expect(result.ok).toBe(true)
    expect(result.model).toBe('llama3.2:1b')
    // Percentages come from Ollama's own byte counts: 250 of 1000 first, then the
    // final completion event.
    const percents = seen.map((p) => p.percent).filter((p): p is number => p !== undefined)
    expect(percents[0]).toBe(25)
    expect(percents.at(-1)).toBe(100)
    expect(seen.at(-1)?.state).toBe('done')
    expect(seen.find((p) => p.percent === 25)?.total).toBe(1000)
  })

  it('refuses a second download of the same model instead of starting one', async () => {
    const held = heldResponse()
    const fetchMock = vi.fn(async () => held.response)
    vi.stubGlobal('fetch', fetchMock)
    const mgr = manager()

    const first = mgr.pull('qwen3:4b')
    const second = await mgr.pull('qwen3:4b')
    expect(second.ok).toBe(false)
    expect(second.message).toMatch(/already downloading/i)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(mgr.isPulling('qwen3:4b')).toBe(true)

    held.release()
    await expect(first).resolves.toMatchObject({ ok: true })
    expect(mgr.isPulling('qwen3:4b')).toBe(false)
  })

  it('cancels a download in flight', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        return await new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            const err = new Error('The operation was aborted')
            err.name = 'AbortError'
            reject(err)
          })
        })
      })
    )
    const seen: OllamaPullProgress[] = []
    const mgr = manager({ emit: (p) => seen.push(p) })
    const pull = mgr.pull('gemma3:12b')
    expect(mgr.cancelPull('gemma3:12b')).toBe(true)

    const result = await pull
    expect(result.ok).toBe(false)
    expect(result.cancelled).toBe(true)
    expect(seen.at(-1)?.state).toBe('cancelled')
    expect(mgr.cancelPull('gemma3:12b')).toBe(false)
  })

  it('surfaces an unknown model name from Ollama instead of pretending success', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ndjson(['{"error":"pull model manifest: file does not exist"}'])))
    const mgr = manager()
    const result = await mgr.pull('definitely-not-a-model:99b')
    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/does not exist/)
  })

  it('reports a refused download with the HTTP status', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })))
    const mgr = manager()
    const result = await mgr.pull('llama3.2:3b')
    expect(result.ok).toBe(false)
    expect(result.message).toContain('500')
  })

  it('does not report success when the stream ends without Ollama saying so', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ndjson(['{"status":"downloading","total":10,"completed":4}'])))
    const mgr = manager()
    const result = await mgr.pull('llama3.2:1b')
    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/before Ollama reported success/i)
  })
})

describe('Ollama remove', () => {
  it('removes a model with the documented endpoint', async () => {
    const fetchMock = vi.fn(async () => new Response('', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const mgr = manager()
    const result = await mgr.remove('llama3.2:1b')
    expect(result.ok).toBe(true)
    expect(fetchMock.mock.calls[0][0]).toBe('http://127.0.0.1:11434/api/delete')
    expect(JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body))).toEqual({
      model: 'llama3.2:1b'
    })
  })

  it('reports a model that is not installed', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 404 })))
    const mgr = manager()
    const result = await mgr.remove('ghost:1b')
    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/does not have/i)
  })

  it('refuses to delete while that model is downloading', async () => {
    const held = heldResponse()
    vi.stubGlobal('fetch', vi.fn(async () => held.response))
    const mgr = manager()
    const pull = mgr.pull('qwen3:8b')
    const result = await mgr.remove('qwen3:8b')
    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/Cancel the download/i)
    held.release()
    await pull
  })
})
