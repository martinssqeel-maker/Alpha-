import { useEffect, useRef, useState } from 'react'
import { Check, Copy } from 'lucide-react'
import type { ActivityItem, ChatMessage } from '@shared/types'
import { useApp } from '../store/useApp'
import Markdown from './Markdown'
import ActivityTimeline, { deriveRunStatus } from './ActivityTimeline'
import alphaLogo from '../assets/alpha-logo.png'

/** Format a running duration as a compact, machine-readable clock. */
function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`
}

/** Epoch-based elapsed clock for a live run; re-renders once per second. */
function useElapsed(startedAt: number | null): string | null {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (startedAt === null) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [startedAt])
  if (startedAt === null) return null
  return formatElapsed(now - startedAt)
}

function CopyButton({ text, label = 'Copy response' }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      className="msg-action"
      title={label}
      aria-label={label}
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true)
          window.setTimeout(() => setCopied(false), 1400)
        })
      }}
    >
      {copied ? <Check size={13} /> : <Copy size={13} />}
      <span>{copied ? 'Copied' : 'Copy'}</span>
    </button>
  )
}

export default function MessageList() {
  const messages = useApp((s) => s.messages)
  const streaming = useApp((s) => s.streaming)
  const isSending = useApp((s) => s.isSending)
  const scroll = useRef<HTMLDivElement>(null)
  const followBottom = useRef(true)

  // A stable run start per request, so the elapsed clock counts the real
  // duration instead of restarting on every streamed token.
  const requestId = streaming?.requestId ?? null
  const [runStartedAt, setRunStartedAt] = useState<number | null>(null)
  useEffect(() => {
    setRunStartedAt(requestId ? Date.now() : null)
  }, [requestId])

  useEffect(() => {
    const element = scroll.current
    if (element && followBottom.current) element.scrollTop = element.scrollHeight
  }, [messages.length, streaming?.text, streaming?.activities.length, isSending])

  if (messages.length === 0 && !streaming) {
    return <Empty />
  }

  const visible = messages.filter((m) => m.role !== 'tool' && m.role !== 'system')

  return (
    <div
      className="msg-scroll"
      ref={scroll}
      onScroll={(event) => {
        const element = event.currentTarget
        followBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 96
      }}
    >
      {visible.map((m) => (
        <MessageRow key={m.id} message={m} />
      ))}

      {streaming && <LiveTurn streaming={streaming} startedAt={runStartedAt} />}

      {isSending && !streaming && (
        <div className="msg assistant">
          <RunStrip tone="working" label="Submitting request" />
          <div className="msg-body">
            <span className="exec-hint">Preparing the request…</span>
          </div>
        </div>
      )}
    </div>
  )
}

interface LiveState {
  text: string
  thinking: string
  activities: ActivityItem[]
}

function LiveTurn({ streaming, startedAt }: { streaming: LiveState; startedAt: number | null }) {
  const status = deriveRunStatus(streaming.activities)
  const elapsed = useElapsed(startedAt)

  return (
    <div className="msg assistant live">
      <RunStrip tone={status.tone} label={status.label} hint={status.hint} elapsed={elapsed} />
      <div className="msg-body">
        {/* Keep progress visible through the run strip and real activity events;
            never render private model reasoning in the conversation. */}
        <ActivityTimeline activities={streaming.activities} />
        {streaming.text ? (
          <>
            <Markdown content={streaming.text} />
            <span className="caret" />
          </>
        ) : (
          !streaming.activities.length && <span className="exec-hint">Waiting for the model…</span>
        )}
      </div>
    </div>
  )
}

function RunStrip({
  tone,
  label,
  hint,
  elapsed
}: {
  tone: 'working' | 'approval' | 'failed' | 'idle'
  label: string
  hint?: string
  elapsed?: string | null
}) {
  return (
    <div className={`run-strip ${tone}`} role="status" aria-live="polite">
      <span className={`run-pulse ${tone}`} aria-hidden="true" />
      <span className="run-label">{label}</span>
      {hint && <span className="run-hint">{hint}</span>}
      <span className="flex-1" />
      {elapsed && <span className="run-elapsed mono">{elapsed}</span>}
    </div>
  )
}

function MessageRow({ message }: { message: ChatMessage }) {
  const isUser = message.role === 'user'
  if (isUser) {
    return (
      <div className="msg user">
        <div className="msg-body user-body">
          {message.attachments && message.attachments.length > 0 && (
            <div className="flex flex-wrap gap-2 mb-2">
              {message.attachments.map((a) => (
                <div key={a.id} className="attachment-chip">{a.name}</div>
              ))}
            </div>
          )}
          <div className="user-text">{message.content}</div>
          <div className="msg-tools">
            <CopyButton text={message.content} label="Copy message" />
          </div>
        </div>
      </div>
    )
  }
  return (
    <div className="msg assistant">
      <div className="msg-body">
        {message.activity && message.activity.length > 0 && <ActivityTimeline activities={message.activity} />}
        <Markdown content={message.content} />
        <div className="msg-tools">
          <CopyButton text={message.content} />
        </div>
      </div>
    </div>
  )
}

function Empty() {
  const project = useApp((s) => s.projects.find((p) => p.id === s.activeProjectId))
  const setText = useApp((s) => s.setDraft)
  const suggestions = [
    'Explain the structure of this project',
    'Find and fix likely bugs in the main entry point',
    'Write unit tests for the core modules',
    'Summarize the README and propose improvements'
  ]
  return (
    <div className="chat-empty">
      <img src={alphaLogo} alt="" width={52} height={52} draggable={false} />
      <div>
        <h2 className="chat-empty-title">Alpha AI Workspace</h2>
        <p className="chat-empty-sub">
          {project ? `Working in ${project.name}` : 'Open a project or just start chatting'}
        </p>
      </div>
      <div className="chat-suggestions">
        {suggestions.map((s) => (
          <button key={s} type="button" className="chat-suggestion" onClick={() => setText(s)}>
            {s}
          </button>
        ))}
      </div>
    </div>
  )
}
