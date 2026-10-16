import { useState } from 'react'
import {
  AlertTriangle,
  ChevronRight,
  FileEdit,
  FilePlus2,
  FileSearch,
  GitBranch,
  Globe2,
  ListChecks,
  SquareTerminal,
  Wrench,
  X
} from 'lucide-react'
import type { ActivityItem } from '@shared/types'
import { redactSensitiveText, redactSensitiveValue } from '@shared/redactSensitive'

export interface RunStatus {
  label: string
  hint?: string
  tone: 'working' | 'approval' | 'failed' | 'idle'
}

const STATE_LABEL: Record<ActivityItem['state'], string> = {
  proposed: 'Proposed',
  'awaiting-approval': 'Approval',
  running: 'Running',
  completed: 'Done',
  failed: 'Failed',
  cancelled: 'Cancelled'
}

/**
 * Derive a single, honest run status from the real activity stream. Only states
 * the execution layer actually reports are produced — nothing is invented, and
 * an empty stream means "thinking", not a fabricated percentage.
 */
export function deriveRunStatus(activities: ActivityItem[]): RunStatus {
  const awaiting = activities.find((a) => a.state === 'awaiting-approval')
  if (awaiting) {
    return { label: 'Waiting for approval', hint: awaiting.title, tone: 'approval' }
  }
  const running = [...activities].reverse().find((a) => a.state === 'running')
  if (running) {
    const label =
      running.kind === 'command'
        ? 'Running command'
        : running.kind === 'edit'
          ? 'Editing files'
          : running.kind === 'git'
            ? 'Reviewing changes'
            : running.kind === 'status'
              ? 'Working'
              : 'Running tool'
    return { label, hint: running.title, tone: 'working' }
  }
  if (activities.length) {
    const last = activities[activities.length - 1]
    if (last.state === 'failed') return { label: 'Last step failed', hint: last.title, tone: 'failed' }
    return { label: 'Working', hint: 'Continuing with the next step', tone: 'working' }
  }
  return { label: 'Thinking', tone: 'working' }
}

function iconFor(activity: ActivityItem) {
  if (activity.kind === 'command') return SquareTerminal
  if (activity.kind === 'edit') {
    return /creat|add|new/i.test(activity.title) ? FilePlus2 : FileEdit
  }
  if (activity.kind === 'git') return GitBranch
  if (activity.kind === 'status') return ListChecks
  const name = `${activity.toolName ?? ''} ${activity.title}`.toLowerCase()
  if (/read|open|view/.test(name)) return FileSearch
  if (/browser|preview|http|url/.test(name)) return Globe2
  return Wrench
}

function formatDuration(activity: ActivityItem): string | null {
  if (activity.endedAt === undefined) return null
  const ms = activity.endedAt - activity.startedAt
  if (ms < 0) return null
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.floor(ms / 60_000)}m ${String(Math.round((ms % 60_000) / 1000)).padStart(2, '0')}s`
}

export default function ActivityTimeline({ activities }: { activities: ActivityItem[] }) {
  if (!activities.length) return null
  return (
    <div className="activity-list">
      {activities.map((a) => (
        <ActivityRow key={a.id} activity={a} />
      ))}
    </div>
  )
}

function ActivityRow({ activity }: { activity: ActivityItem }) {
  const [open, setOpen] = useState(false)
  const Icon = iconFor(activity)
  const detail = activity.error || activity.detail
  const hasDetail = Boolean(detail) || activity.result !== undefined || activity.args !== undefined
  const duration = formatDuration(activity)

  return (
    <div className={`activity-card ${activity.state}`}>
      <button
        type="button"
        className="activity-head"
        aria-expanded={hasDetail ? open : undefined}
        aria-label={`${activity.title}, ${STATE_LABEL[activity.state]}${hasDetail ? ', show details' : ''}`}
        onClick={() => hasDetail && setOpen((o) => !o)}
      >
        <span className="activity-icon" aria-hidden="true">
          <Icon size={14} />
        </span>
        <span className="activity-title mono">{activity.title}</span>
        <span className={`activity-pill ${activity.state}`}>{STATE_LABEL[activity.state]}</span>
        <span className="flex-1" />
        {duration && <span className="activity-duration mono">{duration}</span>}
        {activity.state === 'awaiting-approval' && <AlertTriangle size={13} style={{ color: 'var(--warning)' }} />}
        {activity.state === 'failed' && <X size={13} style={{ color: 'var(--danger)' }} />}
        {hasDetail && (
          <ChevronRight
            size={14}
            className={`activity-chevron ${open ? 'open' : ''}`}
            style={{ color: 'var(--text-tertiary)' }}
          />
        )}
      </button>
      {open && (
        <div className="activity-body">
          {detail && <pre className="activity-pre">{redactSensitiveText(detail)}</pre>}
          {activity.args !== undefined && (
            <details>
              <summary className="activity-summary">Inputs</summary>
              <pre className="activity-pre block">{formatActivityValue(activity.args)}</pre>
            </details>
          )}
          {activity.result !== undefined && (
            <details open>
              <summary className="activity-summary">Result</summary>
              <pre className="activity-pre block">{formatActivityValue(activity.result)}</pre>
            </details>
          )}
        </div>
      )}
    </div>
  )
}

function formatActivityValue(value: unknown): string {
  try {
    return JSON.stringify(redactSensitiveValue(value), null, 2).slice(0, 4000)
  } catch {
    return '[Output could not be displayed]'
  }
}
