/**
 * Live end-to-end chat timing, measured through the real pipeline.
 *
 * Nothing here is simulated: this builds the same `ChatService` the app builds
 * (real SQLite conversations, real provider registry, real Ollama adapter) and
 * sends a real prompt to a real local model, timing the events the renderer
 * would receive. It prints one `BENCH {...}` line per run so a before/after
 * comparison is a diff of two lines rather than a claim.
 *
 * What it measures:
 *   promptMs   send → `start`: conversation read, system prompt, project tree
 *   ttftMs     send → first visible output token (content or thinking)
 *   totalMs    send → done
 *   tok/s      from Ollama's own eval counts
 *   toolMs     time inside tool executions, and when the first one began
 *
 * Runs for several minutes against a real model, so it lives outside the default
 * `npm test` glob on purpose. Run it with `npm run bench:chat`; it skips when no
 * Ollama service answers, so CI never depends on a local model.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ChatService } from '../../src/main/services/chat'
import { CheckpointService } from '../../src/main/services/checkpoints'
import { Db } from '../../src/main/services/db'
import { EditService } from '../../src/main/services/editService'
import { GitService } from '../../src/main/services/git'
import { initLogger } from '../../src/main/services/logger'
import { ApprovalBroker, PermissionService } from '../../src/main/services/permissionService'
import { ProjectService } from '../../src/main/services/projectService'
import { ProviderRegistry } from '../../src/main/services/providers/registry'
import { SecretStore, type Cipher } from '../../src/main/services/secrets'
import { SkillsService } from '../../src/main/services/skills'
import { TerminalService } from '../../src/main/services/terminal'
import {
  ConversationsRepo,
  ProjectsRepo,
  ProvidersRepo,
  SettingsRepo
} from '../../src/main/services/store'
import type { ChatEvent } from '../../src/shared/types'

const BASE = (process.env.OLLAMA_URL ?? 'http://127.0.0.1:11434').replace(/\/+$/, '')

/** Default prompt: invites real tool use in a real project folder. */
const PROMPT =
  process.env.ALPHA_BENCH_PROMPT ??
  'List the files in this project, then read notes.txt and tell me in one short sentence what it says.'

const live = await (async (): Promise<boolean> => {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 1500)
    const res = await fetch(`${BASE}/api/version`, { signal: controller.signal })
    clearTimeout(timer)
    return res.ok
  } catch {
    return false
  }
})()

const installed = await (async (): Promise<string[]> => {
  if (!live) return []
  try {
    const res = await fetch(`${BASE}/api/tags`)
    const body = (await res.json()) as { models?: { name?: string }[] }
    return (body.models ?? []).map((m) => m.name ?? '').filter(Boolean)
  } catch {
    return []
  }
})()

const MODEL = process.env.ALPHA_BENCH_MODEL || installed[0] || ''

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'alpha-bench-'))
const projectRoot = path.join(tmpRoot, 'bench-project')

interface Activity {
  id: string
  toolName?: string
  state: string
  startedAt?: number
  endedAt?: number
  approvalId?: string
}

interface RunResult {
  /** Timings as the main process reported them (the `metrics` event). */
  reported?: { promptMs: number; ttftMs: number; totalMs: number; toolMs: number; toolCalls: number }
  promptMs: number
  ttftMs: number
  totalMs: number
  promptTokens: number
  outputChars: number
  outputTokens: number
  tokensPerSecond: number | null
  toolCount: number
  toolWallMs: number
  firstToolAtMs: number | null
  activities: Activity[]
  error?: string
}

describe.skipIf(!live || !MODEL)(`live chat timing at ${BASE}`, () => {
  let db: Db
  let conversations: ConversationsRepo
  let registry: ProviderRegistry
  let projects: ProjectService
  let settings: SettingsRepo
  let broker: ApprovalBroker
  let providerId = ''
  let conversationId = ''
  let projectId = ''
  let edits: EditService
  let git: GitService
  let terminal: TerminalService
  let skills: SkillsService
  let permissions: PermissionService

  const identityCipher: Cipher = {
    available: () => true,
    encrypt: (plain) => plain,
    decrypt: (payload) => payload
  }

  beforeAll(async () => {
    fs.mkdirSync(path.join(projectRoot, 'src'), { recursive: true })
    fs.writeFileSync(path.join(projectRoot, 'notes.txt'), 'The benchmark note says hello.\n')
    fs.writeFileSync(path.join(projectRoot, 'package.json'), JSON.stringify({ name: 'bench-project' }, null, 2))
    for (let i = 0; i < 10; i++) {
      fs.writeFileSync(
        path.join(projectRoot, 'src', `module-${i}.ts`),
        `export const value${i} = ${i}\nexport function helper${i}(): number {\n  return ${i}\n}\n`
      )
    }

    initLogger(path.join(tmpRoot, 'logs'))
    db = await Db.open(path.join(tmpRoot, 'bench.db'))
    const projectsRepo = new ProjectsRepo(db)
    conversations = new ConversationsRepo(db)
    settings = new SettingsRepo(db)
    registry = new ProviderRegistry(new ProvidersRepo(db), new SecretStore(path.join(tmpRoot, 'secrets.enc'), identityCipher))
    const ollama = registry.ensureLocalOllama(BASE)
    providerId = ollama.id
    projects = new ProjectService(projectsRepo)
    const opened = projects.openProject(projectRoot)
    projectId = opened.project.id
    const conversation = conversations.create({ projectId })
    conversationId = conversation.id
    broker = new ApprovalBroker()
    permissions = new PermissionService(settings)
    // The real services, exactly as `buildContext` wires them: a benchmark against
    // stubs would measure the stubs.
    const checkpoints = new CheckpointService(db, path.join(tmpRoot, 'checkpoints'))
    edits = new EditService(projects, checkpoints)
    git = new GitService(projects)
    terminal = new TerminalService(projects, permissions)
    skills = new SkillsService(path.join(process.cwd(), 'product-skills'), settings)
  })

  afterAll(() => {
    db?.close()
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true })
    } catch {
      /* best effort */
    }
  })

  /**
   * One real request through ChatService. Timings are taken from the events the
   * renderer receives, so they include everything the user actually waits for.
   */
  /**
   * A conversation with real prior turns, so the history budget can be measured.
   * Each turn is `chars` characters of ordinary prose (≈4 characters per token).
   */
  function seedHistory(turns: number, chars: number): string {
    const conversation = conversations.create({ projectId })
    const sentence = 'Please keep the deployment checklist and the migration notes in mind. '
    const filler = sentence.repeat(Math.ceil(chars / sentence.length)).slice(0, chars)
    for (let turn = 0; turn < turns; turn++) {
      conversations.append({
        conversationId: conversation.id,
        role: 'user',
        content: `Turn ${turn} question: ${filler}`
      })
      conversations.append({
        conversationId: conversation.id,
        role: 'assistant',
        content: `Turn ${turn} answer: ${filler}`
      })
    }
    return conversation.id
  }

  async function runOnce(
    label: string,
    text: string,
    conversation = conversationId
  ): Promise<RunResult> {
    const events: { at: number; event: ChatEvent }[] = []
    const activities: Activity[] = []

    // The emitter is captured at construction, so the service is built with the
    // recording one. Everything else is exactly what the app wires up.
    const chat = new ChatService({
      providers: registry,
      conversations,
      projects,
      edits,
      git,
      terminal,
      skills,
      permissions,
      broker,
      settings,
      emit: (event) => {
        // Same clock as `startedAt` (Date.now), so tool timestamps and event
        // timestamps can be subtracted from each other.
        events.push({ at: Date.now(), event })
        if (event.type === 'activity') {
          const activity = event.activity as unknown as Activity
          const index = activities.findIndex((a) => a.id === activity.id)
          if (index >= 0) activities[index] = activity
          else activities.push(activity)
          // Never let an approval prompt stall the benchmark: deny it, which also
          // exercises the denial path instead of hanging on a dialog nobody can see.
          if (activity.approvalId) broker.resolve(activity.approvalId, false)
        }
      }
    })

    // One clock for everything: tool activities are stamped with `Date.now()`.
    const startedAt = Date.now()
    const request = chat.send({
      conversationId: conversation,
      providerId,
      modelId: MODEL,
      mode: 'assist',
      projectId,
      text,
      attachments: []
    })

    const timeoutAt = Date.now() + 180_000
    while (Date.now() < timeoutAt) {
      const terminal = events.find(
        ({ event }) =>
          (event.type === 'done' || event.type === 'error' || event.type === 'cancelled') &&
          event.requestId === request.requestId
      )
      if (terminal) break
      await new Promise((resolve) => setTimeout(resolve, 25))
    }

    const first = (type: ChatEvent['type']): { at: number; event: ChatEvent } | undefined =>
      events.find(({ event }) => event.type === type && event.requestId === request.requestId)
    const firstOutput = events.find(
      ({ event }) =>
        (event.type === 'delta' || event.type === 'thinking') && event.requestId === request.requestId
    )
    const done = events.find(({ event }) => event.type === 'done' && event.requestId === request.requestId)
    const failed = events.find(
      ({ event }) =>
        (event.type === 'error' || event.type === 'cancelled') && event.requestId === request.requestId
    )

    let content = ''
    let usage: { promptTokens?: number; completionTokens?: number } | undefined
    if (done && done.event.type === 'done') {
      content = done.event.content
      usage = done.event.usage
    }
    const completion = usage?.completionTokens ?? 0
    const totalMs = (done?.at ?? failed?.at ?? startedAt) - startedAt
    const toolActivities = activities.filter((a) => a.startedAt && a.endedAt)
    const toolWallMs = toolActivities.reduce((sum, a) => sum + ((a.endedAt ?? 0) - (a.startedAt ?? 0)), 0)

    const metricsEvent = events.find(
      ({ event }) => event.type === 'metrics' && event.requestId === request.requestId
    )
    const reported =
      metricsEvent && metricsEvent.event.type === 'metrics'
        ? {
            promptMs: metricsEvent.event.metrics.promptMs,
            ttftMs: metricsEvent.event.metrics.ttftMs,
            totalMs: metricsEvent.event.metrics.totalMs,
            toolMs: metricsEvent.event.metrics.toolMs,
            toolCalls: metricsEvent.event.metrics.toolCalls
          }
        : undefined

    const result: RunResult = {
      reported,
      promptMs: Math.round((first('start')?.at ?? startedAt) - startedAt),
      ttftMs: Math.round((firstOutput?.at ?? startedAt) - startedAt),
      totalMs: Math.round(totalMs),
      promptTokens: usage?.promptTokens ?? 0,
      outputChars: content.length,
      outputTokens: completion,
      tokensPerSecond: completion && totalMs > 0 ? Math.round((completion / (totalMs / 1000)) * 10) / 10 : null,
      toolCount: activities.length,
      toolWallMs: Math.round(toolWallMs),
      firstToolAtMs: toolActivities.length
        ? Math.round(toolActivities[0].startedAt! - startedAt)
        : null,
      activities,
      error: failed ? JSON.stringify(failed.event) : undefined
    }

    console.log(
      `BENCH ${label} ${JSON.stringify({
        model: MODEL,
        promptMs: result.promptMs,
        ttftMs: result.ttftMs,
        totalMs: result.totalMs,
        promptTokens: result.promptTokens,
        outputTokens: result.outputTokens,
        tokensPerSecond: result.tokensPerSecond,
        toolCalls: result.toolCount,
        toolWallMs: result.toolWallMs,
        firstToolAtMs: result.firstToolAtMs,
        outputChars: result.outputChars
      })}`
    )
    for (const activity of activities) {
      console.log(
        `BENCH-TOOL ${label} ${JSON.stringify({
          tool: activity.toolName,
          state: activity.state,
          ms: (activity.endedAt ?? 0) - (activity.startedAt ?? 0)
        })}`
      )
    }
    return result
  }

  it('warms the model, then reports cold and warm numbers', async () => {
    const cold = await runOnce('cold', PROMPT)
    const warm = await runOnce('warm', PROMPT)

    for (const [label, result] of [['cold', cold], ['warm', warm]] as const) {
      expect(result.error, `${label} run failed: ${result.error}`).toBeUndefined()
      expect(result.outputChars, `${label} run produced no output`).toBeGreaterThan(0)
      expect(result.totalMs).toBeGreaterThan(0)
      // The main process must report its own timings for a real turn: this is the
      // instrumentation the UI shows, verified against a live model.
      expect(result.reported, `${label} run reported no metrics`).toBeDefined()
      expect(result.reported!.ttftMs).toBeGreaterThan(0)
      expect(result.reported!.totalMs).toBeGreaterThanOrEqual(result.reported!.ttftMs)
    }
    // The warm run is the one that represents steady-state use, so it is the one
    // the report quotes; both are printed above.
    expect(warm.ttftMs).toBeLessThanOrEqual(warm.totalMs)
  }, 300_000)

  /**
   * Ask Ollama to drop the model from memory (`keep_alive: 0`) or to load it now
   * (`keep_alive` > 0 with an empty prompt). Both are documented API calls, and
   * they are how the app controls model-load latency.
   */
  async function unload(): Promise<void> {
    await fetch(`${BASE}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: MODEL, prompt: '', keep_alive: 0 })
    })
    await new Promise((resolve) => setTimeout(resolve, 500))
  }

  async function preload(): Promise<void> {
    await fetch(`${BASE}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: MODEL, prompt: '', keep_alive: '15m' })
    })
  }

  /**
   * Ollama reports how long it will keep a model in memory. The app now asks for
   * 15 minutes instead of Ollama's 5-minute default, so this checks the request
   * actually took effect rather than assuming it did.
   */
  async function residency(): Promise<{ model: string; expiresInSeconds: number | null }[]> {
    try {
      const res = await fetch(`${BASE}/api/ps`)
      if (!res.ok) return []
      const body = (await res.json()) as {
        models?: { name?: string; expires_at?: string }[]
      }
      return (body.models ?? []).map((entry) => {
        const expires = entry.expires_at ? Date.parse(entry.expires_at) : NaN
        return {
          model: entry.name ?? '',
          expiresInSeconds: Number.isFinite(expires) ? Math.round((expires - Date.now()) / 1000) : null
        }
      })
    } catch {
      return []
    }
  }

  it('keeps the model resident beyond Ollama\'s default eviction window', async () => {
    // A finished request has just sent `keep_alive: 15m`, so the model should be
    // listed as loaded for well over Ollama's 5-minute default.
    const running = await residency()
    console.log(`BENCH-RESIDENCY ${JSON.stringify(running)}`)
    const entry = running.find((r) => r.model.startsWith(MODEL.split(':')[0]))
    if (!entry || entry.expiresInSeconds === null) {
      console.warn('Ollama did not report a loaded model with an expiry; residency not verified.')
      return
    }
    expect(entry.expiresInSeconds).toBeGreaterThan(5 * 60)
  }, 30_000)

  it('shows what a model reload costs and what preloading saves', async () => {
    await unload()
    const afterReload = await runOnce('after-unload', 'Reply with the single word: OK')
    await unload()
    const loadStarted = Date.now()
    await preload()
    const loadMs = Date.now() - loadStarted
    const afterPreload = await runOnce('after-preload', 'Reply with the single word: OK')

    // This is the app's optimisation, measured: the same request, with the model
    // load paid before the user pressed send (preload) instead of after.
    console.log(
      `BENCH-LOAD ${JSON.stringify({
        model: MODEL,
        reloadTtftMs: afterReload.ttftMs,
        preloadCostMs: loadMs,
        preloadedTtftMs: afterPreload.ttftMs,
        ttftSavedMs: afterReload.ttftMs - afterPreload.ttftMs
      })}`
    )
    expect(afterReload.error).toBeUndefined()
    expect(afterPreload.error).toBeUndefined()
  }, 600_000)

  it('measures a request carrying a long conversation history', async () => {
    // 12 turns of ~2k tokens each: far more than the working set a local model
    // needs, and exactly the case the history budget is meant to fix.
    const seeded = seedHistory(6, 8000)
    const result = await runOnce('long-history', 'Reply with the single word: OK', seeded)
    expect(result.error, `long-history run failed: ${result.error}`).toBeUndefined()
    expect(result.outputChars + (result.outputTokens ? 1 : 0)).toBeGreaterThan(0)
    expect(result.promptTokens).toBeGreaterThan(0)
  }, 300_000)
})
