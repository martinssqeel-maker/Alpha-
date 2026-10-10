import { useEffect, useRef } from 'react'
import { Bot, User as UserIcon } from 'lucide-react'
import type { ChatMessage } from '@shared/types'
import { useApp } from '../store/useApp'
import Markdown from './Markdown'
import ActivityTimeline from './ActivityTimeline'

export default function MessageList() {
  const messages = useApp((s) => s.messages)
  const streaming = useApp((s) => s.streaming)
  const isSending = useApp((s) => s.isSending)
  const bottom = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [messages.length, streaming?.text, streaming?.activities.length])

  if (messages.length === 0 && !streaming) {
    return <Empty />
  }

  const visible = messages.filter((m) => m.role !== 'tool' && m.role !== 'system')

  return (
    <div className="msg-scroll">
      {visible.map((m) => (
        <MessageRow key={m.id} message={m} />
      ))}

      {streaming && (
        <div className="msg assistant">
          <div className="avatar">
            <Bot size={15} />
          </div>
          <div className="msg-body">
            {streaming.thinking && (
              <details className="mb-2">
                <summary className="text-xs cursor-pointer" style={{ color: 'var(--muted)' }}>
                  Reasoning
                </summary>
                <pre
                  className="mono text-xs whitespace-pre-wrap mt-1 rounded p-2 max-h-60 overflow-auto"
                  style={{ background: 'var(--code-bg)', color: 'var(--text-soft)' }}
                >
                  {streaming.thinking}
                </pre>
              </details>
            )}
            {streaming.text ? (
              <Markdown content={streaming.text} />
            ) : (
              <span className="text-sm" style={{ color: 'var(--muted)' }}>
                <span className="spin">◌</span> Thinking…
              </span>
            )}
            {streaming.text && <span className="caret" />}
            <ActivityTimeline activities={streaming.activities} />
          </div>
        </div>
      )}

      {isSending && !streaming && (
        <div className="msg assistant">
          <div className="avatar">
            <Bot size={15} />
          </div>
          <div className="msg-body">
            <span className="text-sm" style={{ color: 'var(--muted)' }}>
              <span className="spin">◌</span> Starting…
            </span>
          </div>
        </div>
      )}

      <div ref={bottom} />
    </div>
  )
}

function MessageRow({ message }: { message: ChatMessage }) {
  const isUser = message.role === 'user'
  return (
    <div className={`msg ${isUser ? 'user' : 'assistant'}`}>
      <div className="avatar">
        {isUser ? <UserIcon size={15} /> : <Bot size={15} />}
      </div>
      <div className="msg-body">
        {message.attachments && message.attachments.length > 0 && (
          <div className="flex flex-wrap gap-2 mb-2">
            {message.attachments.map((a) => (
              <div key={a.id} className="card tight text-xs" style={{ padding: '3px 8px' }}>
                📎 {a.name}
              </div>
            ))}
          </div>
        )}
        {message.role === 'assistant' ? (
          <Markdown content={message.content} />
        ) : (
          <div className="whitespace-pre-wrap text-sm">{message.content}</div>
        )}
        {message.activity && message.activity.length > 0 && (
          <ActivityTimeline activities={message.activity} />
        )}
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
    <div className="flex flex-col items-center justify-center h-full gap-4 px-6 text-center">
      <div
        className="grid place-items-center rounded-xl"
        style={{ width: 56, height: 56, background: 'var(--accent)', color: '#fff', fontSize: 26 }}
      >
        A
      </div>
      <div>
        <h2 className="text-lg font-semibold">Alpha AI Workspace</h2>
        <p className="text-sm" style={{ color: 'var(--muted)' }}>
          {project ? `Working in ${project.name}` : 'Open a project or just start chatting'}
        </p>
      </div>
      <div className="grid gap-2" style={{ maxWidth: 520, width: '100%' }}>
        {suggestions.map((s) => (
          <button
            key={s}
            className="card tight text-left text-sm"
            style={{ padding: '10px 12px', cursor: 'pointer' }}
            onClick={() => setText(s)}
          >
            {s}
          </button>
        ))}
      </div>
    </div>
  )
}
