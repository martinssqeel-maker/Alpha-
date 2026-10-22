/**
 * Autonomous background watchers and scheduled macros.
 *
 * A watcher is a stored trigger plus a task prompt: "every weekday at 08:00,
 * summarise what changed in this project" or "when anything under `src/`
 * changes, run the tests". When it fires the agent runs in `agent` mode and the
 * result lands in the Activity panel like any other turn.
 *
 * Three guards matter more than the feature:
 *  - one run at a time per watcher. A flaky file save produces a burst of events
 *    and must not start twenty agent turns.
 *  - nothing fires while the kill-switch is engaged or a turn is already running
 *    for that watcher; a background task must never fight the user for control.
 *  - the watcher supplies the *prompt*, never the permissions. It runs through
 *    the same permission mode the user chose.
 *
 * Pure scheduling logic lives here so it can be tested with a fake clock.
 */
import fs from 'node:fs'
import path from 'node:path'

export type TriggerKind = 'interval' | 'daily' | 'watch'

export interface IntervalTrigger {
  kind: 'interval'
  everyMinutes: number
}

export interface DailyTrigger {
  kind: 'daily'
  /** 24-hour local `HH:MM`. */
  at: string
}

export interface WatchTrigger {
  kind: 'watch'
  /** Directory (or file) to watch. Must sit under an authorized root. */
  target: string
  /** Coalescing window; a burst of writes becomes one run. */
  debounceMs?: number
}

export type Trigger = IntervalTrigger | DailyTrigger | WatchTrigger

export interface Watcher {
  id: string
  name: string
  prompt: string
  trigger: Trigger
  enabled: boolean
  /** Conversation the run continues, if the user picked one. */
  conversationId?: string
  providerId?: string
  /** Model the run should use; a watcher cannot guess one safely. */
  modelId?: string
  lastRunAt?: number
  createdAt: number
  updatedAt: number
}

export class WatcherError extends Error {
  constructor(message: string, readonly code: string) {
    super(message)
  }
}

const MIN_INTERVAL_MINUTES = 1
const MAX_INTERVAL_MINUTES = 60 * 24 * 7
const DEFAULT_DEBOUNCE_MS = 2_000
const MIN_DEBOUNCE_MS = 250
const MAX_DEBOUNCE_MS = 60_000

export function parseDailyAt(at: string): { hour: number; minute: number } {
  const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(at.trim())
  if (!match) throw new WatcherError(`Time must look like "08:30" (24-hour), got "${at}"`, 'bad_time')
  return { hour: Number(match[1]), minute: Number(match[2]) }
}

export function validateTrigger(trigger: Trigger): Trigger {
  if (trigger.kind === 'interval') {
    const minutes = Math.round(trigger.everyMinutes)
    if (!Number.isFinite(minutes) || minutes < MIN_INTERVAL_MINUTES || minutes > MAX_INTERVAL_MINUTES) {
      throw new WatcherError(`Interval must be between ${MIN_INTERVAL_MINUTES} and ${MAX_INTERVAL_MINUTES} minutes`, 'bad_interval')
    }
    return { kind: 'interval', everyMinutes: minutes }
  }
  if (trigger.kind === 'daily') {
    parseDailyAt(trigger.at)
    return { kind: 'daily', at: trigger.at.trim() }
  }
  if (trigger.kind === 'watch') {
    if (!trigger.target?.trim()) throw new WatcherError('A watch needs a folder', 'bad_target')
    const debounce = Math.round(trigger.debounceMs ?? DEFAULT_DEBOUNCE_MS)
    return {
      kind: 'watch',
      target: trigger.target.trim(),
      debounceMs: Math.min(Math.max(debounce, MIN_DEBOUNCE_MS), MAX_DEBOUNCE_MS)
    }
  }
  throw new WatcherError('Unknown trigger kind', 'bad_kind')
}

/** Next fire time in epoch ms, or null for watch triggers (event driven). */
export function nextRunAt(trigger: Trigger, lastRunAt: number | undefined, now: number): number | null {
  if (trigger.kind === 'interval') {
    const period = trigger.everyMinutes * 60_000
    if (!lastRunAt) return now
    return lastRunAt + period
  }
  if (trigger.kind === 'daily') {
    const { hour, minute } = parseDailyAt(trigger.at)
    const base = new Date(now)
    const today = new Date(base.getFullYear(), base.getMonth(), base.getDate(), hour, minute, 0, 0)
    if (today.getTime() > now && (!lastRunAt || lastRunAt < today.getTime())) return today.getTime()
    // Already passed (or ran today): next occurrence tomorrow.
    return new Date(base.getFullYear(), base.getMonth(), base.getDate() + 1, hour, minute, 0, 0).getTime()
  }
  return null
}

export function isDue(trigger: Trigger, lastRunAt: number | undefined, now: number): boolean {
  const next = nextRunAt(trigger, lastRunAt, now)
  return next !== null && now >= next
}

/** Debounce window for a watch trigger, clamped. */
export function debounceMs(trigger: Trigger): number {
  if (trigger.kind !== 'watch') return 0
  return Math.min(Math.max(trigger.debounceMs ?? DEFAULT_DEBOUNCE_MS, MIN_DEBOUNCE_MS), MAX_DEBOUNCE_MS)
}

export interface WatcherServiceDeps {
  /** Persistence. Defaults to one JSON file under userData. */
  file?: string
  load?: () => Watcher[]
  save?: (watchers: Watcher[]) => void
  now?: () => number
  /** Fires the agent. Rejections are logged, not thrown at the timer. */
  run: (watcher: Watcher, reason: 'schedule' | 'change') => Promise<void>
  emit?: (event: { type: 'fired' | 'skipped' | 'error'; watcherId: string; detail?: string }) => void
  log?: (message: string) => void
}

/**
 * Owns the timers and file handles. `tick()` is exposed so tests (and a manual
 * "run now") can drive it deterministically instead of waiting on wall time.
 */
export class WatcherService {
  private watchers: Watcher[] = []
  private running = new Set<string>()
  private watchHandles = new Map<string, fs.FSWatcher>()
  private debounceTimers = new Map<string, NodeJS.Timeout>()
  private tickTimer: NodeJS.Timeout | null = null
  private paused = false
  private now: () => number

  constructor(private deps: WatcherServiceDeps) {
    this.now = deps.now ?? (() => Date.now())
  }

  list(): Watcher[] {
    this.load()
    return [...this.watchers]
  }

  private load(): void {
    if (this.watchers.length) return
    if (this.deps.load) {
      this.watchers = this.deps.load()
      return
    }
    if (!this.deps.file) return
    try {
      if (!fs.existsSync(this.deps.file)) return
      const raw = JSON.parse(fs.readFileSync(this.deps.file, 'utf8'))
      if (Array.isArray(raw)) this.watchers = raw.filter((w) => w && typeof w.id === 'string')
    } catch (error) {
      this.deps.log?.(`watchers unreadable: ${(error as Error).message}`)
    }
  }

  private persist(): void {
    if (this.deps.save) {
      this.deps.save(this.watchers)
      return
    }
    if (!this.deps.file) return
    try {
      fs.mkdirSync(path.dirname(this.deps.file), { recursive: true })
      fs.writeFileSync(this.deps.file, JSON.stringify(this.watchers, null, 2), 'utf8')
    } catch (error) {
      this.deps.log?.(`could not save watchers: ${(error as Error).message}`)
    }
  }

  save(input: Omit<Watcher, 'id' | 'createdAt' | 'updatedAt'> & { id?: string }): Watcher {
    this.load()
    const trigger = validateTrigger(input.trigger)
    if (!input.prompt?.trim()) throw new WatcherError('A watcher needs a task prompt', 'no_prompt')
    const now = this.now()
    const existing = input.id ? this.watchers.find((w) => w.id === input.id) : undefined
    const watcher: Watcher = {
      ...existing,
      id: existing?.id ?? input.id ?? `w_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      name: input.name?.trim() || 'Watcher',
      prompt: input.prompt.trim(),
      trigger,
      enabled: input.enabled !== false,
      conversationId: input.conversationId,
      providerId: input.providerId,
      lastRunAt: existing?.lastRunAt,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    }
    this.watchers = existing
      ? this.watchers.map((w) => (w.id === watcher.id ? watcher : w))
      : [...this.watchers, watcher]
    this.persist()
    this.arm()
    return watcher
  }

  remove(id: string): boolean {
    this.load()
    const before = this.watchers.length
    this.watchers = this.watchers.filter((w) => w.id !== id)
    if (this.watchers.length === before) return false
    this.disarm(id)
    this.persist()
    return true
  }

  setEnabled(id: string, enabled: boolean): Watcher | null {
    this.load()
    const watcher = this.watchers.find((w) => w.id === id)
    if (!watcher) return null
    watcher.enabled = enabled
    watcher.updatedAt = this.now()
    this.persist()
    this.arm()
    return watcher
  }

  /** Kill-switch integration: pause stops new runs, including file events. */
  pause(): void {
    this.paused = true
  }

  resume(): void {
    this.paused = false
  }

  /**
   * One scheduling pass. Returns the watchers that fired, which makes the
   * behaviour observable in tests without waiting on wall-clock time.
   */
  async tick(): Promise<string[]> {
    this.load()
    if (this.paused) return []
    const fired: string[] = []
    for (const watcher of this.watchers) {
      if (!watcher.enabled) continue
      if (watcher.trigger.kind === 'watch') continue
      if (!isDue(watcher.trigger, watcher.lastRunAt, this.now())) continue
      if (this.running.has(watcher.id)) {
        this.deps.emit?.({ type: 'skipped', watcherId: watcher.id, detail: 'previous run still in flight' })
        continue
      }
      fired.push(watcher.id)
      await this.fire(watcher, 'schedule')
    }
    return fired
  }

  private async fire(watcher: Watcher, reason: 'schedule' | 'change'): Promise<void> {
    if (this.paused || this.running.has(watcher.id)) return
    this.running.add(watcher.id)
    watcher.lastRunAt = this.now()
    this.persist()
    this.deps.emit?.({ type: 'fired', watcherId: watcher.id, detail: reason })
    try {
      await this.deps.run(watcher, reason)
    } catch (error) {
      this.deps.emit?.({ type: 'error', watcherId: watcher.id, detail: (error as Error).message })
      this.deps.log?.(`watcher ${watcher.id} failed: ${(error as Error).message}`)
    } finally {
      this.running.delete(watcher.id)
    }
  }

  /** Arm every timer/watch handle. Safe to call repeatedly. */
  arm(): void {
    this.load()
    if (this.tickTimer) clearInterval(this.tickTimer)
    this.tickTimer = setInterval(() => {
      void this.tick()
    }, 30_000)
    this.tickTimer.unref?.()

    const wanted = new Set(this.watchers.filter((w) => w.enabled && w.trigger.kind === 'watch').map((w) => w.id))
    for (const [id, handle] of this.watchHandles) {
      if (!wanted.has(id)) {
        handle.close()
        this.watchHandles.delete(id)
      }
    }
    for (const watcher of this.watchers) {
      if (!watcher.enabled || watcher.trigger.kind !== 'watch') continue
      if (this.watchHandles.has(watcher.id)) continue
      this.armWatch(watcher)
    }
  }

  private armWatch(watcher: Watcher): void {
    if (watcher.trigger.kind !== 'watch') return
    const target = watcher.trigger.target
    try {
      if (!fs.existsSync(target)) {
        this.deps.log?.(`watcher ${watcher.id}: ${target} does not exist yet`)
        return
      }
      const handle = fs.watch(target, { persistent: false }, () => {
        // Coalesce: a save often produces several events in a row.
        const existing = this.debounceTimers.get(watcher.id)
        if (existing) clearTimeout(existing)
        const timer = setTimeout(() => {
          this.debounceTimers.delete(watcher.id)
          void this.fire(this.current(watcher.id) ?? watcher, 'change')
        }, debounceMs(watcher.trigger))
        timer.unref?.()
        this.debounceTimers.set(watcher.id, timer)
      })
      handle.on('error', (error) => this.deps.log?.(`watcher ${watcher.id} error: ${error.message}`))
      this.watchHandles.set(watcher.id, handle)
    } catch (error) {
      this.deps.log?.(`watcher ${watcher.id} could not start: ${(error as Error).message}`)
    }
  }

  private current(id: string): Watcher | undefined {
    return this.watchers.find((w) => w.id === id)
  }

  private disarm(id: string): void {
    this.watchHandles.get(id)?.close()
    this.watchHandles.delete(id)
    const timer = this.debounceTimers.get(id)
    if (timer) clearTimeout(timer)
    this.debounceTimers.delete(id)
  }

  /** Stop timers and release handles. Called on app quit. */
  dispose(): void {
    if (this.tickTimer) clearInterval(this.tickTimer)
    this.tickTimer = null
    for (const id of [...this.watchHandles.keys()]) this.disarm(id)
  }
}
