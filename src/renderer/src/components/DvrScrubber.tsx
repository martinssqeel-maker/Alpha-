import { useCallback, useEffect, useMemo, useState } from 'react'
import { ChevronLeft, ChevronRight, RefreshCw, Rewind } from 'lucide-react'
import { api } from '../lib/api'
import type { DvrFrameView, DvrTimeline } from '@shared/types'

/**
 * Timeline scrubber over the in-memory replay buffer.
 *
 * The buffer is bounded and lives only for the session, so the empty state says
 * so rather than implying a history that was pruned. Snapshot payloads are
 * fetched per frame instead of with the timeline: dragging the slider must not
 * pull megabytes of base64 over IPC on every step.
 *
 * "Rewind to here" re-positions the inspector. It does not restore files — a
 * button that silently reverted code would be a destructive action wearing a
 * navigation label.
 */
export default function DvrScrubber({ revision = 0 }: { revision?: number }) {
  const [timeline, setTimeline] = useState<DvrTimeline | null>(null)
  const [windowed, setWindowed] = useState<DvrTimeline | null>(null)
  const [index, setIndex] = useState(0)
  const [image, setImage] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const active = windowed ?? timeline

  const load = useCallback(async () => {
    try {
      const next = await api.dvr.timeline({ limit: 200 })
      setTimeline(next)
      setIndex((current) => Math.min(current, Math.max(next.frames.length - 1, 0)))
    } catch {
      setTimeline({ frames: [], firstId: null, lastId: null, total: 0, bytes: 0, budget: 0 })
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load, revision])

  // A rewind narrows the window to the frames up to the chosen step; leaving it
  // would hide newer frames permanently, so it clears when the buffer grows.
  useEffect(() => {
    setWindowed(null)
  }, [revision])

  const frames = active?.frames ?? []
  const selected: DvrFrameView | null = frames[index] ?? null

  useEffect(() => {
    let cancelled = false
    setImage(null)
    if (!selected?.hasImage) return
    setLoading(true)
    void api.dvr
      .frame(selected.id)
      .then((result) => {
        if (!cancelled && result?.image) setImage(result.image)
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [selected?.id, selected?.hasImage])

  const sizeLabel = useMemo(() => {
    if (!active) return ''
    const mb = (bytes: number) => `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    return `${active.total} frame${active.total === 1 ? '' : 's'} · ${mb(active.bytes)} of ${mb(active.budget)}`
  }, [active])

  const rewind = async () => {
    if (!selected) return
    try {
      const next = await api.dvr.rollback(selected.id)
      setWindowed(next)
      setIndex(Math.max(next.frames.length - 1, 0))
    } catch {
      /* the buffer may have moved on; the next refresh will show it */
    }
  }

  if (!active) {
    return (
      <div className="dvr-scrubber text-xs" style={{ color: 'var(--muted)' }}>
        Loading replay…
      </div>
    )
  }

  if (frames.length === 0) {
    return (
      <div className="dvr-scrubber text-xs" style={{ color: 'var(--muted)' }}>
        No replay frames yet. Finished tool steps are recorded here for this session only.
      </div>
    )
  }

  const kindColor: Record<DvrFrameView['kind'], string> = {
    tool: 'var(--accent, #60a5fa)',
    terminal: 'var(--warning, #fbbf24)',
    snapshot: 'var(--success, #34d399)',
    note: 'var(--muted)'
  }

  return (
    <div className="dvr-scrubber">
      <div className="dvr-head">
        <span className="dvr-title">Replay</span>
        <span className="text-xs" style={{ color: 'var(--muted)' }}>
          {sizeLabel}
          {windowed ? ' · rewound' : ''}
        </span>
        <div className="dvr-actions">
          <button className="btn icon" onClick={() => setIndex((i) => Math.max(i - 1, 0))} disabled={index === 0} title="Previous step" aria-label="Previous step">
            <ChevronLeft size={13} />
          </button>
          <button
            className="btn icon"
            onClick={() => setIndex((i) => Math.min(i + 1, frames.length - 1))}
            disabled={index >= frames.length - 1}
            title="Next step"
            aria-label="Next step"
          >
            <ChevronRight size={13} />
          </button>
          <button className="btn icon" onClick={() => void rewind()} disabled={index >= frames.length - 1} title="Rewind the inspector to this step" aria-label="Rewind to this step">
            <Rewind size={13} />
          </button>
          <button
            className="btn icon"
            onClick={() => {
              setWindowed(null)
              void load()
            }}
            title="Refresh"
            aria-label="Refresh replay"
          >
            <RefreshCw size={13} />
          </button>
        </div>
      </div>

      <input
        className="dvr-range"
        type="range"
        min={0}
        max={Math.max(frames.length - 1, 0)}
        value={index}
        onChange={(event) => setIndex(Number(event.target.value))}
        aria-label="Replay position"
      />

      {selected ? (
        <div className="dvr-frame">
          <div className="dvr-frame-head">
            <span className="dvr-dot" style={{ background: kindColor[selected.kind] }} />
            <strong>{selected.label ?? selected.kind}</strong>
            <span className="text-xs" style={{ color: 'var(--muted)' }}>
              step {index + 1} of {frames.length} · {new Date(selected.at).toLocaleTimeString()}
            </span>
            {selected.detail?.autoApproved === true ? (
              <span className="dvr-badge" title="This step skipped the approval dialog under a session grant">
                auto-approved
              </span>
            ) : null}
            {typeof selected.detail?.state === 'string' && selected.detail.state !== 'completed' ? (
              <span className="dvr-badge bad">{String(selected.detail.state)}</span>
            ) : null}
          </div>
          {selected.text ? <pre className="dvr-text">{selected.text}</pre> : null}
          {loading ? (
            <div className="text-xs" style={{ color: 'var(--muted)' }}>
              Loading snapshot…
            </div>
          ) : null}
          {image ? (
            <img className="dvr-image" src={`data:image/png;base64,${image}`} alt={`Screen at step ${index + 1}`} />
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
