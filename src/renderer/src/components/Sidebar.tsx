import { useEffect, useMemo, useState } from 'react'
import {
  Archive,
  Boxes,
  ChevronDown,
  ChevronRight,
  FolderGit2,
  FolderOpen,
  Github,
  Home,
  LifeBuoy,
  MessageSquarePlus,
  MoreHorizontal,
  Pencil,
  Plug,
  Search,
  Settings as SettingsIcon,
  Trash2,
  UserRound
} from 'lucide-react'
import { api } from '../lib/api'
import { relativeTime } from '../lib/relativeTime'
import { useApp, type View } from '../store/useApp'
import type { Conversation } from '@shared/types'
import AccountModal from './AccountModal'

const NAV: { view: View; label: string; icon: typeof Boxes }[] = [
  { view: 'home', label: 'Home', icon: Home },
  { view: 'models', label: 'Models', icon: Boxes },
  { view: 'providers', label: 'AI Providers', icon: Plug },
  { view: 'github', label: 'GitHub', icon: Github },
  { view: 'settings', label: 'Settings', icon: SettingsIcon },
  { view: 'help', label: 'Help & Diagnostics', icon: LifeBuoy }
]

export default function Sidebar() {
  const setView = useApp((s) => s.setView)
  const view = useApp((s) => s.view)
  const platform = useApp((s) => s.platform)
  const [query, setQuery] = useState('')
  const [searchResults, setSearchResults] = useState<Conversation[]>([])
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState('')
  const [showAccount, setShowAccount] = useState(false)
  const [expanded, setExpanded] = useState<string[]>([])
  const [projectMenuId, setProjectMenuId] = useState<string | null>(null)

  const list = useApp((s) => s.conversations)
  const activeId = useApp((s) => s.activeConversationId)
  const projects = useApp((s) => s.projects)
  const activeProjectId = useApp((s) => s.activeProjectId)

  useEffect(() => {
    if (!query.trim()) {
      setSearchResults([])
      setSearching(false)
      setSearchError('')
      return
    }
    let current = true
    setSearching(true)
    const timer = window.setTimeout(() => {
      api.conversations.search(query.trim()).then((items) => {
        if (current) {
          setSearchResults(items)
          setSearching(false)
          setSearchError('')
        }
      }).catch((error: unknown) => {
        if (current) {
          setSearching(false)
          setSearchError((error as Error).message || 'Search is unavailable.')
        }
      })
    }, 180)
    return () => {
      current = false
      window.clearTimeout(timer)
    }
  }, [query])

  const filtered = useMemo(() => query.trim() ? searchResults : list, [list, query, searchResults])
  const newChat = (): void => { void useApp.getState().newConversation() }
  const toggleProject = (id: string): void => setExpanded((items) => items.includes(id) ? items.filter((item) => item !== id) : [...items, id])

  const openConversation = (id: string): void => {
    void useApp.getState().openConversation(id).catch((error: unknown) => {
      useApp.getState().toast(`Could not open conversation: ${(error as Error).message}`, 'error')
    })
  }

  const conversationRows = (items: Conversation[]) => items.map((conversation) => {
    const project = projects.find((item) => item.id === conversation.projectId)
    return (
      <div key={conversation.id} className={`nav-item conversation-item ${activeId === conversation.id ? 'active' : ''}`}>
        <button className="conversation-title flex-1 text-left label text-xs" onClick={() => openConversation(conversation.id)} title={`${conversation.title}${project ? ` · ${project.name}` : ''}`}>
          <span className="block truncate">{conversation.title}</span>
          <span className="block conversation-meta truncate">{project?.name ?? 'General'} · {relativeTime(conversation.updatedAt)}</span>
        </button>
        {!query.trim() && <div className="conversation-actions">
          <button className="btn ghost icon compact" title="Archive conversation" onClick={() => void useApp.getState().archiveConversation(conversation.id)}><Archive size={12} /></button>
          <button className="btn ghost icon compact" title="Delete conversation" onClick={() => {
            if (window.confirm(`Delete “${conversation.title}” and its conversation history?`)) void useApp.getState().deleteConversation(conversation.id)
          }}><Trash2 size={12} /></button>
        </div>}
      </div>
    )
  })

  return (
    <div className="sidebar">
      <div className="p-3">
        <button className="btn primary w-full" onClick={newChat}><MessageSquarePlus size={15} /> New chat</button>
      </div>

      <div className="sidebar-projects px-3 pb-2">
        <div className="flex items-center gap-1 mb-1 text-xs font-semibold" style={{ color: 'var(--text-tertiary)' }}>
          <FolderGit2 size={12} /> PROJECTS
          <div className="flex-1" />
          <button className="btn ghost icon" style={{ width: 22, height: 22 }} title="Open project folder" onClick={() => void useApp.getState().openProject()}><span aria-hidden="true">+</span></button>
        </div>
        {projects.map((project) => {
          const chats = list.filter((conversation) => conversation.projectId === project.id)
          const isExpanded = expanded.includes(project.id) || activeProjectId === project.id
          return <div key={project.id} className="project-group">
            <div className={`nav-item sidebar-project-item ${activeProjectId === project.id ? 'active' : ''}`}>
              <button className="project-disclosure btn ghost icon compact" aria-label={`${isExpanded ? 'Collapse' : 'Expand'} ${project.name} conversations`} onClick={() => toggleProject(project.id)}>
                {isExpanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
              </button>
              <button className="project-label flex-1 min-w-0" onClick={() => void useApp.getState().selectProject(project.id)} title={project.rootPath}>
                <FolderGit2 size={13} /> <span className="label text-xs truncate">{project.name}</span>
              </button>
              <button className="btn ghost icon compact project-more" aria-label={`Project actions for ${project.name}`} title="Project actions" aria-expanded={projectMenuId === project.id} onClick={() => setProjectMenuId((current) => current === project.id ? null : project.id)}><MoreHorizontal size={14} /></button>
            </div>
            {projectMenuId === project.id && <div className="project-actions-menu" role="menu">
              <button role="menuitem" onClick={() => { setProjectMenuId(null); void api.revealPath(project.rootPath) }}><FolderOpen size={13} /> Open folder</button>
              <button role="menuitem" onClick={() => {
                setProjectMenuId(null)
                const name = window.prompt('Project label', project.name)?.trim()
                if (name) void useApp.getState().renameProject(project.id, name)
              }}><Pencil size={13} /> Rename label…</button>
              <button role="menuitem" className="danger-action" onClick={() => {
                setProjectMenuId(null)
                if (window.confirm(`Remove “${project.name}” from Alpha? Its files and folder will not be deleted.`)) void useApp.getState().removeProject(project.id)
              }}><Trash2 size={13} /> Remove from workspace</button>
            </div>}
            {isExpanded && chats.length > 0 && <div className="project-chats">{conversationRows(chats)}</div>}
          </div>
        })}
        {projects.length === 0 && <div className="text-xs px-2 py-1" style={{ color: 'var(--text-disabled)' }}>No projects yet</div>}
      </div>

      <div className="px-3 pb-2">
        <div className="flex items-center gap-2 text-xs font-semibold mb-1" style={{ color: 'var(--text-tertiary)' }}><Search size={12} /> CONVERSATIONS</div>
        <input className="input text-xs mb-1" placeholder="Search title or message…" aria-label="Search conversations" value={query} onChange={(e) => setQuery(e.target.value)} style={{ padding: 'var(--space-1) var(--space-2)' }} />
      </div>

      <div className="sidebar-scroll px-2">
        {query.trim() ? conversationRows(filtered) : <>
          {conversationRows(filtered.filter((conversation) => !conversation.projectId))}
          {filtered.length === 0 && <div className="text-xs px-2 py-1" style={{ color: 'var(--text-disabled)' }}>No conversations yet</div>}
        </>}
        {query.trim() && searching && <div className="text-xs px-2 py-1" style={{ color: 'var(--text-tertiary)' }}>Searching conversations…</div>}
        {query.trim() && searchError && <div className="text-xs px-2 py-1" style={{ color: 'var(--danger)' }}>{searchError}</div>}
        {query.trim() && !searching && !searchError && filtered.length === 0 && <div className="text-xs px-2 py-1" style={{ color: 'var(--text-disabled)' }}>No matching conversations</div>}
      </div>

      <div className="p-2 sidebar-footer" style={{ borderTop: '1px solid var(--border-subtle)' }}>
        {NAV.map((item) => <button key={item.view} className={`nav-item ${view === item.view ? 'active' : ''}`} onClick={() => setView(item.view)}><item.icon size={16} /><span className="label text-xs">{item.label}</span></button>)}
        <button className={`nav-item ${showAccount ? 'active' : ''}`} onClick={() => setShowAccount(true)}>
          <UserRound size={16} /><span className="label text-xs flex-1">Account</span>
          {platform.enabled && <span className="status-dot" title={platform.authenticated ? (platform.config?.account?.email ?? 'Signed in') : 'Not signed in'} style={{ background: platform.authenticated ? 'var(--accent)' : 'var(--text-disabled)', borderRadius: 'var(--radius-pill)', width: 8, height: 8 }} />}
        </button>
      </div>
      <AccountModal open={showAccount} onClose={() => setShowAccount(false)} />
    </div>
  )
}
