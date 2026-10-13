import { ArrowRight, Clock3, FolderOpen, FolderPlus, MessageSquare, MessageSquarePlus } from 'lucide-react'
import { relativeTime } from '../lib/relativeTime'
import { useApp } from '../store/useApp'

export default function HomePage() {
  const conversations = useApp((s) => s.conversations)
  const projects = useApp((s) => s.projects)
  const activeConversationId = useApp((s) => s.activeConversationId)
  const newConversation = useApp((s) => s.newConversation)
  const openConversation = useApp((s) => s.openConversation)
  const openProject = useApp((s) => s.openProject)
  const selectProject = useApp((s) => s.selectProject)

  const recent = conversations.slice(0, 6)
  const active = conversations.find((conversation) => conversation.id === activeConversationId)

  return (
    <div className="page">
      <div className="page-header">
        <h1 className="page-title">Home</h1>
        <div className="flex-1" />
        <button className="btn" onClick={() => void openProject()}><FolderPlus size={14} /> Open project</button>
        <button className="btn primary" onClick={() => void newConversation(null)}><MessageSquarePlus size={14} /> New chat</button>
      </div>
      <div className="page-scroll home-scroll">
        <section className="home-welcome">
          <div>
            <p className="eyebrow">ALPHA WORKSPACE</p>
            <h2>Pick up where you left off.</h2>
            <p className="text-sm" style={{ color: 'var(--text-secondary)', maxWidth: 520 }}>
              Your projects and conversations stay on this device. Open a project to work with its files, or start a chat without one.
            </p>
          </div>
          {active && (
            <button className="home-resume" onClick={() => void openConversation(active.id)}>
              <span className="home-resume-icon"><MessageSquare size={17} /></span>
              <span className="min-w-0 text-left">
                <span className="block text-xs" style={{ color: 'var(--text-tertiary)' }}>CONTINUE RECENT CHAT</span>
                <span className="block text-sm font-medium truncate">{active.title}</span>
              </span>
              <ArrowRight size={16} />
            </button>
          )}
        </section>

        <div className="home-columns">
          <section className="home-section">
            <div className="home-section-header">
              <div><h3>Projects</h3><p>Folders you have opened in Alpha</p></div>
              <button className="btn ghost" onClick={() => void openProject()}><FolderPlus size={14} /> Add</button>
            </div>
            {projects.length === 0 ? (
              <div className="home-empty"><FolderOpen size={18} /><span>No projects yet</span><button className="btn" onClick={() => void openProject()}>Choose a folder</button></div>
            ) : (
              <div className="home-list">
                {projects.slice(0, 8).map((project) => (
                  <button key={project.id} className="home-list-row" onClick={() => void selectProject(project.id)} title={project.rootPath}>
                    <span className="home-row-icon"><FolderOpen size={15} /></span>
                    <span className="min-w-0 flex-1 text-left"><span className="block text-sm font-medium truncate">{project.name}</span><span className="block text-xs truncate" style={{ color: 'var(--text-tertiary)' }}>{project.rootPath}</span></span>
                    <ArrowRight size={14} />
                  </button>
                ))}
              </div>
            )}
          </section>

          <section className="home-section">
            <div className="home-section-header">
              <div><h3>Recent conversations</h3><p>Continue a conversation from this workspace</p></div>
              <Clock3 size={15} style={{ color: 'var(--text-tertiary)' }} />
            </div>
            {recent.length === 0 ? (
              <div className="home-empty"><MessageSquare size={18} /><span>Conversations you start will appear here</span><button className="btn" onClick={() => void newConversation(null)}>Start a chat</button></div>
            ) : (
              <div className="home-list">
                {recent.map((conversation) => {
                  const project = projects.find((item) => item.id === conversation.projectId)
                  return (
                    <button key={conversation.id} className="home-list-row" onClick={() => void openConversation(conversation.id)}>
                      <span className="home-row-icon"><MessageSquare size={15} /></span>
                      <span className="min-w-0 flex-1 text-left"><span className="block text-sm font-medium truncate">{conversation.title}</span><span className="block text-xs truncate" style={{ color: 'var(--text-tertiary)' }}>{project?.name ?? 'General'} · {relativeTime(conversation.updatedAt)}</span></span>
                      <ArrowRight size={14} />
                    </button>
                  )
                })}
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  )
}
