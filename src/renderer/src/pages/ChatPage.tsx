import { useState } from 'react'
import { PanelRightClose, PanelRightOpen, Plus, Trash2 } from 'lucide-react'
import { useApp } from '../store/useApp'
import MessageList from '../components/MessageList'
import Composer from '../components/Composer'

/** Durations as a person reads them: 240ms, 2.4s, 1m 24s. */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const minutes = Math.floor(ms / 60_000)
  const seconds = Math.round((ms % 60_000) / 1000)
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`
}

/**
 * What the last reply actually cost.
 *
 * Every figure is measured in the main process (see `ChatMetrics`): the first
 * token is what the user waits for, and on a CPU-only machine it is worth seeing
 * whether a slow answer was the model loading or the model thinking.
 */
function RunMetrics(): React.JSX.Element | null {
  const lastRun = useApp((s) => s.lastRun)
  const streaming = useApp((s) => s.streaming)
  if (!lastRun || streaming) return null
  const { metrics } = lastRun
  const parts = [`first token ${formatDuration(metrics.ttftMs)}`]
  if (metrics.tokensPerSecond) parts.push(`${metrics.tokensPerSecond} tok/s`)
  parts.push(`total ${formatDuration(metrics.totalMs)}`)
  if (metrics.promptTokens) parts.push(`${metrics.promptTokens} prompt tokens`)
  if (metrics.toolCalls > 0) parts.push(`${metrics.toolCalls} tool${metrics.toolCalls === 1 ? '' : 's'} in ${formatDuration(metrics.toolMs)}`)
  return (
    <div className="run-metrics mono" title="Measured in the main process for the last reply">
      last reply · {parts.join(' · ')}
    </div>
  )
}

export default function ChatPage() {
  const conversation = useApp((s) =>
    s.conversations.find((c) => c.id === s.activeConversationId)
  )
  const inspectorOpen = useApp((s) => s.inspectorOpen)
  const toggleInspector = (): void => useApp.getState().setInspectorOpen(!inspectorOpen)
  const rename = useApp((s) => s.renameConversation)
  const [editing, setEditing] = useState(false)
  const [title, setTitle] = useState('')

  return (
    <div className="chat-page">
      <div className="page-header">
        {editing ? (
          <input
            className="input"
            style={{ maxWidth: 320, padding: '4px 10px' }}
            value={title}
            autoFocus
            onChange={(e) => setTitle(e.target.value)}
            onBlur={() => {
              if (conversation && title.trim()) void rename(conversation.id, title.trim())
              setEditing(false)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur()
              if (e.key === 'Escape') setEditing(false)
            }}
          />
        ) : (
          <button
            className="text-sm font-medium"
            style={{ background: 'none', border: 'none', color: 'var(--text)' }}
            onDoubleClick={() => {
              if (conversation) {
                setTitle(conversation.title)
                setEditing(true)
              }
            }}
            title="Double-click to rename"
          >
            {conversation?.title ?? 'New chat'}
          </button>
        )}
        <div className="flex-1" />
        <button className="btn ghost icon" title="New chat" onClick={() => void useApp.getState().newConversation()}>
          <Plus size={15} />
        </button>
        {conversation && (
          <button
            className="btn ghost icon"
            title="Delete chat"
            onClick={() => void useApp.getState().deleteConversation(conversation.id)}
          >
            <Trash2 size={15} />
          </button>
        )}
        <button className="btn ghost icon" title="Toggle inspector" onClick={toggleInspector}>
          {inspectorOpen ? <PanelRightClose size={15} /> : <PanelRightOpen size={15} />}
        </button>
      </div>
      <MessageList />
      <RunMetrics />
      <Composer />
    </div>
  )
}
