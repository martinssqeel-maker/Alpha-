import { useState } from 'react'
import {
  AlertTriangle,
  Check,
  ChevronRight,
  FileEdit,
  GitBranch,
  SquareTerminal,
  Wrench,
  X
} from 'lucide-react'
import type { ActivityItem } from '@shared/types'

function iconFor(a: ActivityItem) {
  switch (a.kind) {
    case 'command':
      return SquareTerminal
    case 'edit':
      return FileEdit
    case 'git':
      return GitBranch
    default:
      return Wrench
  }
}

export default function ActivityTimeline({ activities }: { activities: ActivityItem[] }) {
  if (!activities.length) return null
  return (
    <div className="flex flex-col gap-1 mt-2">
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
  const hasDetail = Boolean(detail) || activity.result !== undefined
  return (
    <div className={`activity ${activity.state}`}>
      <span className="dot" />
      <Icon size={13} style={{ marginTop: 2, color: 'var(--muted)', flexShrink: 0 }} />
      <div className="flex-1 min-w-0">
        <button
          className="flex items-center gap-1 w-full text-left"
          style={{ background: 'none', border: 'none', padding: 0 }}
          onClick={() => hasDetail && setOpen((o) => !o)}
        >
          <span className="font-medium mono text-xs" style={{ color: 'var(--text)' }}>
            {activity.title}
          </span>
          <span className="pill" style={{ fontSize: 10, padding: '0 6px' }}>
            {activity.state}
          </span>
          {hasDetail && <ChevronRight size={13} className={open ? 'rotate-90' : ''} style={{ transition: 'transform .12s' }} />}
          <div className="flex-1" />
          {activity.state === 'completed' && <Check size={12} style={{ color: 'var(--success)' }} />}
          {activity.state === 'failed' && <X size={12} style={{ color: 'var(--danger)' }} />}
          {activity.state === 'awaiting-approval' && (
            <AlertTriangle size={12} style={{ color: 'var(--warn)' }} />
          )}
        </button>
        {open && (
          <div className="mt-1">
            {detail && (
              <pre className="mono text-xs whitespace-pre-wrap m-0" style={{ color: 'var(--text-soft)' }}>
                {detail}
              </pre>
            )}
            {activity.result !== undefined && (
              <pre
                className="mono text-xs whitespace-pre-wrap m-0 mt-1 max-h-64 overflow-auto rounded p-2"
                style={{ background: 'var(--code-bg)', color: 'var(--text-soft)' }}
              >
                {JSON.stringify(activity.result, null, 2).slice(0, 4000)}
              </pre>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
