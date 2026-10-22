import { useState } from 'react'
import {
  AlertTriangle,
  BookmarkPlus,
  CheckCircle2,
  ChevronRight,
  FileEdit,
  FilePlus2,
  FileSearch,
  GitBranch,
  Globe2,
  ListChecks,
  ShieldAlert,
  SquareTerminal,
  Wrench,
  X
} from 'lucide-react'
import type { ActivityItem } from '@shared/types'
import { redactSensitiveText, redactSensitiveValue } from '@shared/redactSensitive'
import { api } from '../lib/api'

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
        {activity.verification && (
          <span
            className={`activity-pill verification ${activity.verification.verified ? 'ok' : 'bad'}`}
            title={activity.verification.note}
          >
            {activity.verification.verified ? <CheckCircle2 size={11} /> : <ShieldAlert size={11} />}
            {activity.verification.verified ? 'Verified' : 'Unverified'}
          </span>
        )}
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
          {activity.verification && (
            <p
              className="activity-verification"
              style={{ color: activity.verification.verified ? 'var(--success, #34d399)' : 'var(--warning, #fbbf24)' }}
            >
              {activity.verification.verified ? '✓ ' : '! '}
              {redactSensitiveText(activity.verification.note)}
            </p>
          )}
          {activity.state === 'completed' && activity.toolName && <SaveAsSkill activity={activity} />}
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


/**
 * Turn one completed action into a reusable skill.
 *
 * The instructions are generated from what actually happened — the tool, its
 * arguments and the verified outcome — not from the model's description of it.
 * That way a saved "skill" is a factual recipe the next run can follow.
 */
function SaveAsSkill({ activity }: { activity: ActivityItem }) {
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [message, setMessage] = useState<string | null>(null)

  async function onSave(): Promise<void> {
    setStatus('saving')
    setMessage(null)
    try {
      const id = skillIdFor(activity)
      const result = await api.skills.save({
        id,
        name: activity.title.slice(0, 100) || activity.toolName || 'Saved workflow',
        description: (activity.detail ?? `Runs ${activity.toolName}`).slice(0, 180),
        category: 'Saved workflows',
        instructions: describeAsInstructions(activity)
      })
      setStatus('saved')
      setMessage(result.path)
    } catch (error) {
      setStatus('error')
      setMessage((error as Error).message)
    }
  }

  return (
    <div className="activity-save">
      <button type="button" onClick={onSave} disabled={status === 'saving' || status === 'saved'}>
        <BookmarkPlus size={13} />
        {status === 'saved' ? 'Saved as skill' : status === 'saving' ? 'Saving…' : 'Save as Skill'}
      </button>
      {message && (
        <span className="activity-save-note" title={message}>
          {status === 'error' ? message : 'Added to Skills'}
        </span>
      )}
    </div>
  )
}

function skillIdFor(activity: ActivityItem): string {
  const base = `saved-${activity.toolName ?? 'workflow'}-${activity.title}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 58)
  // Must match the skills parser: starts alphanumeric, 2–64 chars.
  return base.length >= 2 ? base : 'saved-workflow'
}

function describeAsInstructions(activity: ActivityItem): string {
  const lines = [
    `Use this workflow when the task looks like: "${activity.title}".`,
    '',
    `1. Call \`${activity.toolName ?? 'the tool'}\` with these arguments:`,
    '```json',
    safeJson(activity.args),
    '```',
    `2. The verified outcome was: ${activity.verification?.note ?? activity.detail ?? 'completed'}.`,
    '',
    'Adapt the arguments to the current request. Confirm the result with the tool\'s',
    'verification field before reporting success.'
  ]
  return lines.join('\n')
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(redactSensitiveValue(value), null, 2).slice(0, 1500)
  } catch {
    return '{}'
  }
}
