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
import { useApp } from '../store/useApp'
import { buildMacroDraft, suggestMacroName } from '@shared/macroDraft'
import { diffStats, looksLikeUnifiedDiff, parseDiffLines } from '@shared/diffText'

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
      <SaveSequenceAsMacro activities={activities} />
      {activities.map((a) => (
        <ActivityRow key={a.id} activity={a} />
      ))}
    </div>
  )
}

/**
 * Capture a finished multi-step run as a replayable `.alpha` macro.
 *
 * The offered button only appears when at least two replayable steps completed:
 * a single tool call is already one click in the composer, and saving it as a
 * script adds a file without saving any work. Only completed steps are captured,
 * and the proposal-based tools are skipped because their ids do not outlive the
 * run — a macro containing them would fail every time.
 */
function SaveSequenceAsMacro({ activities }: { activities: ActivityItem[] }) {
  const toast = useApp((s) => s.toast)
  const bumpMacros = useApp((s) => s.bumpMacros)
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved'>('idle')

  const draft = buildMacroDraft(activities)
  if (draft.steps.length < 2) return null

  const suggested = suggestMacroName(activities)

  async function onSave(): Promise<void> {
    setStatus('saving')
    try {
      const result = await api.macros.save({
        name: (name.trim() || suggested).slice(0, 80),
        description: `Captured from ${draft.steps.length} completed step(s).`,
        triggers: [],
        params: draft.params,
        steps: draft.steps
      })
      if (!result.ok) {
        toast(result.error ?? 'Could not save that macro.', 'error')
        setStatus('idle')
        return
      }
      setStatus('saved')
      setOpen(false)
      bumpMacros()
      toast(`Macro saved successfully: ${result.macro?.name ?? (name.trim() || suggested)}`, 'success')
    } catch (error) {
      toast(`Could not save that macro: ${(error as Error).message}`, 'error')
      setStatus('idle')
    }
  }

  return (
    <div className="activity-capture">
      {!open ? (
        <button type="button" onClick={() => setOpen(true)} disabled={status === 'saved'}>
          <BookmarkPlus size={13} />
          {status === 'saved' ? 'Saved as Macro' : 'Save as Macro'}
        </button>
      ) : (
        <div className="activity-capture-form">
          <input
            className="input"
            value={name}
            placeholder={suggested}
            onChange={(event) => setName(event.target.value)}
            aria-label="Macro name"
          />
          <button type="button" onClick={() => void onSave()} disabled={status === 'saving'}>
            {status === 'saving' ? 'Saving…' : 'Save'}
          </button>
          <button type="button" onClick={() => setOpen(false)} disabled={status === 'saving'}>
            Cancel
          </button>
          <span className="activity-save-note">
            {draft.steps.length} step{draft.steps.length === 1 ? '' : 's'}
            {draft.params.length ? ` · ${draft.params.length} parameter(s)` : ''}
            {draft.skipped.length ? ` · ${draft.skipped.length} skipped` : ''}
          </span>
        </div>
      )}
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
        {activity.state === 'running' && (
          <span className="activity-status" aria-hidden="true">
            <span className="activity-spinner spin" />
            <span className="eco-static-indicator" />
          </span>
        )}
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
          {detail && <ActivityOutput text={redactSensitiveText(detail)} />}
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
              <ActivityOutput text={formatActivityValue(activity.result)} />
            </details>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * Render tool output, promoting a real unified diff to a highlighted block.
 *
 * Anything that is not a diff stays a plain `<pre>`: guessing would turn ordinary
 * log output into fake additions, and a mislabelled change is worse than none.
 */
function ActivityOutput({ text }: { text: string }) {
  const isDiff = looksLikeUnifiedDiff(text)
  const parsed = isDiff ? parseDiffLines(text) : null

  if (!parsed) {
    return <pre className="activity-pre block">{text}</pre>
  }

  const stats = diffStats(parsed.lines)
  return (
    <div className="activity-diff">
      <div className="activity-diff-head">
        <span className="activity-diff-plus mono">+{stats.added}</span>
        <span className="activity-diff-minus mono">&minus;{stats.removed}</span>
        {parsed.truncated && <span className="activity-diff-note">truncated</span>}
      </div>
      <pre className="activity-diff-body">
        {parsed.lines.map((line, index) => (
          <span key={index} className={`diff-line ${line.kind}`}>
            <span className="diff-sign" aria-hidden="true">
              {line.kind === 'added' ? '+' : line.kind === 'removed' ? '-' : line.kind === 'context' ? ' ' : ''}
            </span>
            <span className="diff-text">{line.text || ' '}</span>
          </span>
        ))}
      </pre>
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
