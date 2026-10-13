import { useEffect, useRef } from 'react'
import { User as UserIcon } from 'lucide-react'
import type { ChatMessage } from '@shared/types'
import { useApp } from '../store/useApp'
import Markdown from './Markdown'
import ActivityTimeline from './ActivityTimeline'
import alphaLogo from '../assets/alpha-logo.png'

export default function MessageList() {
  const messages = useApp((s) => s.messages)
  const streaming = useApp((s) => s.streaming)
  const isSending = useApp((s) => s.isSending)
  const scroll = useRef<HTMLDivElement>(null)
  const followBottom = useRef(true)

  useEffect(() => {
    const element = scroll.current
    if (element && followBottom.current) element.scrollTop = element.scrollHeight
  }, [messages.length, streaming?.text, streaming?.activities.length, isSending])

  if (messages.length === 0 && !streaming) {
    return <Empty />
  }

  const visible = messages.filter((m) => m.role !== 'tool' && m.role !== 'system')

  return (
    <div className="msg-scroll" ref={scroll} onScroll={(event) => {
      const element = event.currentTarget
      followBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 96
    }}>
      {visible.map((m) => (
        <MessageRow key={m.id} message={m} />
      ))}

      {streaming && (
        <div className="msg assistant">
          <div className="message-author assistant-author">Alpha</div>
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
                <span className="spin">◌</span> {streaming.activities.some((activity) => activity.state === 'awaiting-approval')
                  ? 'Waiting for approval…'
                  : streaming.activities.some((activity) => activity.state === 'running')
                    ? 'Running project action…'
                    : 'Waiting for model response…'}
              </span>
            )}
            {streaming.text && <span className="caret" />}
            <ActivityTimeline activities={streaming.activities} />
          </div>
        </div>
      )}

      {isSending && !streaming && (
        <div className="msg assistant">
          <div className="message-author assistant-author">Alpha</div>
          <div className="msg-body">
            <span className="text-sm" style={{ color: 'var(--muted)' }}>
                <span className="spin">◌</span> Submitting request…
            </span>
          </div>
        </div>
      )}

    </div>
  )
}

function MessageRow({ message }: { message: ChatMessage }) {
  const isUser = message.role === 'user'
  return (
    <div className={`msg ${isUser ? 'user' : 'assistant'}`}>
      {isUser ? <div className="avatar" aria-label="You"><UserIcon size={15} /></div> : <div className="message-author assistant-author">Alpha</div>}
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
      <img src={alphaLogo} alt="" width={56} height={56} draggable={false} />
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
