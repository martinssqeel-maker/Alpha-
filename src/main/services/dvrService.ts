/**
 * Live terminal and UI replay ("DVR").
 *
 * A bounded ring buffer of what the agent actually did — tool calls, terminal
 * output, UI snapshots — so a run can be scrubbed step by step instead of
 * reconstructed from a chat transcript that omits the interesting parts.
 *
 * Two hard rules, both about restraint:
 *  - memory only. Frames are never persisted; a screenshot of a user's screen
 *    has no business on disk, and the buffer must not grow into a leak.
 *  - byte budget, not frame count. One 4K screenshot is worth thousands of log
 *    lines, so eviction is driven by retained bytes.
 *
 * No `electron` import: this module is unit-tested directly.
 */

export type FrameKind = 'tool' | 'terminal' | 'snapshot' | 'note'

export interface DvrFrameInput {
  kind: FrameKind
  /** Short label: tool name, command, or window title. */
  label?: string
  /** Text payload: command output, tool result summary, user note. */
  text?: string
  /** Base64 PNG for UI snapshots. Held in memory only. */
  image?: string
  /** Extra structured detail, already truncated by the caller. */
  detail?: Record<string, unknown>
  at?: number
}

export interface DvrFrame extends DvrFrameInput {
  id: number
  at: number
  bytes: number
}

export interface DvrDeps {
  /** Retained-byte budget. Defaults to 64 MB. */
  budgetBytes?: number
  /** Hard cap on frame count, independent of bytes. */
  maxFrames?: number
  now?: () => number
}

const DEFAULT_BUDGET = 64 * 1024 * 1024
const DEFAULT_MAX_FRAMES = 2_000
/** Per-frame text cap so a runaway build log cannot evict everything else. */
export const MAX_TEXT_CHARS = 8_000
/** Per-frame image cap; anything larger is stored as a marker, not the payload. */
export const MAX_IMAGE_CHARS = 1_500_000

export function frameBytes(frame: Pick<DvrFrameInput, 'label' | 'text' | 'image' | 'detail'>): number {
  let bytes = 64
  if (frame.label) bytes += frame.label.length * 2
  if (frame.text) bytes += Math.min(frame.text.length, MAX_TEXT_CHARS) * 2
  if (frame.image) bytes += Math.min(frame.image.length, MAX_IMAGE_CHARS)
  if (frame.detail) {
    try {
      bytes += JSON.stringify(frame.detail).length * 2
    } catch {
      bytes += 128
    }
  }
  return bytes
}

export function truncateFrameText(text: string, max = MAX_TEXT_CHARS): string {
  if (text.length <= max) return text
  const head = Math.floor(max * 0.7)
  const tail = max - head
  return `${text.slice(0, head)}\n… ${text.length - max} chars omitted …\n${text.slice(-tail)}`
}

export class DvrService {
  private frames: DvrFrame[] = []
  private nextId = 1
  private retained = 0
  private budget: number
  private maxFrames: number
  private now: () => number

  constructor(deps: DvrDeps = {}) {
    // Floors are small on purpose: they guard against a nonsense value, not
    // against a caller that deliberately wants a tiny buffer.
    this.budget = Math.max(deps.budgetBytes ?? DEFAULT_BUDGET, 1_024)
    this.maxFrames = Math.max(deps.maxFrames ?? DEFAULT_MAX_FRAMES, 2)
    this.now = deps.now ?? (() => Date.now())
  }

  /** Append a frame, evicting oldest until both limits hold. */
  push(input: DvrFrameInput): DvrFrame {
    const text = input.text ? truncateFrameText(input.text) : undefined
    const image = input.image && input.image.length <= MAX_IMAGE_CHARS ? input.image : undefined
    const detail = input.image && !image
      ? { ...(input.detail ?? {}), imageOmitted: true, imageChars: input.image.length }
      : input.detail
    const frame: DvrFrame = {
      ...input,
      text,
      image,
      detail,
      id: this.nextId++,
      at: input.at ?? this.now(),
      bytes: frameBytes({ label: input.label, text, image, detail })
    }
    this.frames.push(frame)
    this.retained += frame.bytes
    while ((this.retained > this.budget || this.frames.length > this.maxFrames) && this.frames.length > 1) {
      const evicted = this.frames.shift()
      if (evicted) this.retained -= evicted.bytes
    }
    return frame
  }

  /** Ordered timeline, optionally restricted to a window of frame ids. */
  timeline(options: { fromId?: number; toId?: number; limit?: number } = {}): DvrFrame[] {
    let frames = this.frames
    if (options.fromId !== undefined) frames = frames.filter((f) => f.id >= options.fromId!)
    if (options.toId !== undefined) frames = frames.filter((f) => f.id <= options.toId!)
    if (options.limit !== undefined && options.limit >= 0) frames = frames.slice(-options.limit)
    return frames.map((frame) => ({ ...frame }))
  }

  get(id: number): DvrFrame | null {
    const frame = this.frames.find((f) => f.id === id)
    return frame ? { ...frame } : null
  }

  /** Neighbour by ordinal step, which is what a scrubber arrow needs. */
  step(id: number, delta: number): DvrFrame | null {
    const index = this.frames.findIndex((f) => f.id === id)
    if (index === -1) return null
    const target = this.frames[index + delta]
    return target ? { ...target } : null
  }

  size(): { frames: number; bytes: number; budget: number; firstId: number | null; lastId: number | null } {
    return {
      frames: this.frames.length,
      bytes: this.retained,
      budget: this.budget,
      firstId: this.frames[0]?.id ?? null,
      lastId: this.frames[this.frames.length - 1]?.id ?? null
    }
  }

  clear(): void {
    this.frames = []
    this.retained = 0
  }

  /**
   * A copy safe to show to a model or write to a log: snapshot payloads are
   * dropped, everything else is kept.
   */
  exportRedacted(): DvrFrame[] {
    return this.frames.map(({ image, ...rest }) => ({
      ...rest,
      detail: image ? { ...(rest.detail ?? {}), imageOmitted: true } : rest.detail
    }))
  }
}
