import { useState } from 'react'
import { PanelRightClose, PanelRightOpen, Plus, Trash2 } from 'lucide-react'
import { useApp } from '../store/useApp'
import MessageList from '../components/MessageList'
import Composer from '../components/Composer'

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
      <Composer />
    </div>
  )
}
