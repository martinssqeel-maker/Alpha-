import { useState } from 'react'
import {
  Boxes,
  FolderGit2,
  Github,
  LifeBuoy,
  MessageSquarePlus,
  PanelLeftClose,
  PanelLeftOpen,
  Plug,
  Search,
  Settings as SettingsIcon,
  Trash2
} from 'lucide-react'
import { useApp, type View } from '../store/useApp'

const NAV: { view: View; label: string; icon: typeof Boxes }[] = [
  { view: 'models', label: 'Models', icon: Boxes },
  { view: 'providers', label: 'AI Providers', icon: Plug },
  { view: 'github', label: 'GitHub', icon: Github },
  { view: 'settings', label: 'Settings', icon: SettingsIcon },
  { view: 'help', label: 'Help & Diagnostics', icon: LifeBuoy }
]

export default function Sidebar() {
  const collapsed = useApp((s) => s.sidebarCollapsed)
  const toggle = useApp((s) => s.toggleSidebar)
  const setView = useApp((s) => s.setView)
  const view = useApp((s) => s.view)
  const [query, setQuery] = useState('')

  if (collapsed) {
    return (
      <div className="sidebar collapsed items-center py-3 gap-2">
        <button className="btn ghost icon" title="Expand sidebar" onClick={toggle}>
          <PanelLeftOpen size={16} />
        </button>
        <button className="btn ghost icon" title="New chat" onClick={() => newChat()}>
          <MessageSquarePlus size={16} />
        </button>
        {NAV.map((n) => (
          <button
            key={n.view}
            className={`btn ghost icon ${view === n.view ? 'primary' : ''}`}
            title={n.label}
            onClick={() => setView(n.view)}
          >
            <n.icon size={16} />
          </button>
        ))}
      </div>
    )
  }

  const list = useApp((s) => s.conversations)
  const activeId = useApp((s) => s.activeConversationId)
  const projects = useApp((s) => s.projects)
  const activeProjectId = useApp((s) => s.activeProjectId)
  const openProject = useApp((s) => s.openProjectByPath)
  const del = useApp((s) => s.deleteConversation)

  const filtered = query
    ? list.filter((c) => c.title.toLowerCase().includes(query.toLowerCase()))
    : list

  const newChat = (): void => {
    void useApp.getState().newConversation()
  }

  return (
    <div className="sidebar">
      <div className="p-3">
        <button className="btn primary w-full" onClick={newChat}>
          <MessageSquarePlus size={15} /> New chat
        </button>
      </div>

      <div className="px-3 pb-2">
        <div className="flex items-center gap-1 mb-1 text-xs font-semibold" style={{ color: 'var(--muted)' }}>
          <FolderGit2 size={12} /> PROJECTS
          <div className="flex-1" />
          <button className="btn ghost icon" style={{ width: 22, height: 22 }} title="Open project" onClick={() => useApp.getState().openProject()}>
            +
          </button>
        </div>
        {projects.slice(0, 4).map((p) => (
          <button
            key={p.id}
            className={`nav-item ${activeProjectId === p.id ? 'active' : ''}`}
            style={{ padding: '5px 8px' }}
            onClick={() => setView('projects')}
            onDoubleClick={() => void openProject(p.rootPath)}
            title={p.rootPath}
          >
            <FolderGit2 size={13} />
            <span className="label text-xs">{p.name}</span>
          </button>
        ))}
        {projects.length === 0 && (
          <div className="text-xs px-2 py-1" style={{ color: 'var(--faint)' }}>
            No projects yet
          </div>
        )}
      </div>

      <div className="px-3 pb-2">
        <div className="flex items-center gap-2 text-xs font-semibold mb-1" style={{ color: 'var(--muted)' }}>
          <Search size={12} /> CONVERSATIONS
        </div>
        <input
          className="input text-xs mb-1"
          placeholder="Search chats…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          style={{ padding: '5px 9px' }}
        />
      </div>

      <div className="sidebar-scroll px-2">
        {filtered.map((c) => (
          <div key={c.id} className={`nav-item ${activeId === c.id ? 'active' : ''}`} style={{ padding: '6px 8px' }}>
            <button
              className="flex-1 text-left label text-xs"
              style={{ background: 'none', border: 'none', padding: 0 }}
              onClick={() => useApp.getState().openConversation(c.id)}
              title={c.title}
            >
              {c.title}
            </button>
            <button
              className="btn ghost icon"
              style={{ width: 20, height: 20, padding: 2 }}
              title="Delete"
              onClick={(e) => {
                e.stopPropagation()
                void del(c.id)
              }}
            >
              <Trash2 size={12} />
            </button>
          </div>
        ))}
        {filtered.length === 0 && (
          <div className="text-xs px-2 py-1" style={{ color: 'var(--faint)' }}>
            {query ? 'No matches' : 'No conversations yet'}
          </div>
        )}
      </div>

      <div className="p-2" style={{ borderTop: '1px solid var(--border)' }}>
        {NAV.map((n) => (
          <button
            key={n.view}
            className={`nav-item ${view === n.view ? 'active' : ''}`}
            onClick={() => setView(n.view)}
          >
            <n.icon size={16} />
            <span className="label text-xs">{n.label}</span>
          </button>
        ))}
        <button className="nav-item" onClick={toggle} title="Collapse sidebar">
          <PanelLeftClose size={16} />
          <span className="label text-xs">Collapse</span>
        </button>
      </div>
    </div>
  )
}
