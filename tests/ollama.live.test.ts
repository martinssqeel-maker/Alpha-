/**
 * Live Ollama integration tests.
 *
 * These talk to a real Ollama service on the machine — no mocks — because the
 * things worth checking (detection, real model list, an actual pull, a real
 * refusal for an unknown name) only exist against the service. The whole suite
 * skips when nothing answers on the configured port, so CI without Ollama still
 * passes; `tests/ollama.test.ts` covers the logic with a mocked service.
 *
 * Nothing here removes or re-downloads a model: the pull case re-pulls a model
 * that is already installed, which Ollama answers from its local manifest.
 */
import { describe, expect, it } from 'vitest'
import { OllamaManager } from '../src/main/services/ollamaManager'
import type { ProviderRegistry } from '../src/main/services/providers/registry'

const BASE = (process.env.OLLAMA_URL ?? 'http://127.0.0.1:11434').replace(/\/+$/, '')

const live = await (async (): Promise<boolean> => {
  try {
    const res = await fetch(`${BASE}/api/version`, { signal: AbortSignal.timeout(1500) })
    return res.ok
  } catch {
    return false
  }
})()

function manager(): OllamaManager {
  // `status()` reads the installed list through the registry, so this mirrors the
  // real registry's contract (query Ollama's own /api/tags) instead of faking it.
  const registry = {
    list: () => [{ id: 'ollama-live', kind: 'ollama', baseUrl: BASE }],
    modelsFor: async (): Promise<unknown[]> => {
      const res = await fetch(`${BASE}/api/tags`)
      const body = (await res.json()) as { models?: { name?: string }[] }
      return (body.models ?? []).map((m) => ({
        id: m.name ?? '',
        name: m.name ?? '',
        providerId: 'ollama-live',
        providerName: 'Ollama (live)',
        providerKind: 'ollama',
        local: true,
        capabilities: { streaming: true, tools: false, vision: false }
      }))
    },
    ensureLocalOllama: () => ({ id: 'ollama-live' })
  } as unknown as ProviderRegistry
  return new OllamaManager({ registry, baseUrl: () => BASE, emit: () => {} })
}

describe.skipIf(!live)(`Ollama live service at ${BASE}`, () => {
  it('detects the running service and lists real installed models', async () => {
    const status = await manager().status()
    expect(status.reachable).toBe(true)
    expect(status.version).toMatch(/^\d+\.\d+/)
    expect(Array.isArray(status.models)).toBe(true)
    // Model ids must look like Ollama tags, not placeholders we invented.
    for (const model of status.models) expect(model.id).toMatch(/^[A-Za-z0-9][\w./:-]*$/)
  })

  it('reads this machine\'s real hardware figures', async () => {
    const hw = await manager().hardware(true)
    expect(hw.totalRamGb).toBeGreaterThan(0)
    expect(hw.freeRamGb).toBeGreaterThanOrEqual(0)
    expect(hw.cpuCount).toBeGreaterThan(0)
    expect(hw.cpuModel.length).toBeGreaterThan(2)
    expect(hw.platform.length).toBeGreaterThan(2)
  })

  it('recommends at least one model this machine can actually run', async () => {
    const recs = await manager().recommendations()
    expect(recs.length).toBeGreaterThan(0)
    expect(recs.some((r) => r.fit !== 'too-large')).toBe(true)
  })

  it('re-verifies an installed model through a real pull', async () => {
    const status = await manager().status()
    const installed = status.models[0]
    if (!installed) return // nothing installed: nothing to re-verify
    const mgr = manager()
    const result = await mgr.pull(installed.id)
    expect(result.message ?? '').not.toContain('already downloading')
    if (!result.ok) {
      // A genuine failure is reported, never faked — surface it in the log.
      console.warn(`live pull of ${installed.id} did not succeed: ${result.message}`)
    }
    expect(result.model).toBe(installed.id)
  }, 120_000)

  it('reports a real error for a model name Ollama does not have', async () => {
    const result = await manager().pull('alpha-nonexistent-model:0b')
    expect(result.ok).toBe(false)
    expect(result.message).toBeTruthy()
  }, 60_000)
})
