import { FolderOpen, FolderPlus, History, Trash2 } from 'lucide-react'
import { api } from '../lib/api'
import { useApp } from '../store/useApp'

export default function ProjectsPage() {
  const projects = useApp((s) => s.projects)
  const activeProjectId = useApp((s) => s.activeProjectId)
  const openProject = useApp((s) => s.openProject)
  const selectProject = useApp((s) => s.selectProject)
  const removeProject = useApp((s) => s.removeProject)
  const setView = useApp((s) => s.setView)

  return (
    <div className="page">
      <div className="page-header">
        <h1 className="page-title">Projects</h1>
        <div className="flex-1" />
        <button className="btn primary" onClick={() => void openProject()}>
          <FolderPlus size={14} /> Open folder
        </button>
      </div>

      <div className="page-scroll">
        {projects.length === 0 && (
          <div className="card" style={{ color: 'var(--muted)' }}>
            No projects yet. Open a folder to give the assistant controlled access to its files.
          </div>
        )}
        {projects.map((p) => (
          <div
            key={p.id}
            className="card mb-3"
            style={{ borderColor: activeProjectId === p.id ? 'var(--accent)' : 'var(--border)' }}
          >
            <div className="flex items-center gap-2">
              <FolderOpen size={16} style={{ color: 'var(--accent)' }} />
              <div className="font-medium">{p.name}</div>
              {p.isGitRepo && <span className="pill">git</span>}
              {activeProjectId === p.id && <span className="pill accent">active</span>}
              <div className="flex-1" />
              <span className="text-xs" style={{ color: 'var(--faint)' }}>
                <History size={11} /> {new Date(p.lastOpenedAt).toLocaleDateString()}
              </span>
            </div>
            <div className="mono text-xs mt-1" style={{ color: 'var(--faint)' }}>{p.rootPath}</div>
            {(p.frameworks?.length || p.languageHints?.length) && (
              <div className="flex flex-wrap gap-1 mt-2">
                {p.frameworks?.map((f) => (
                  <span key={f} className="pill accent">{f}</span>
                ))}
                {p.languageHints?.map((l) => (
                  <span key={l} className="pill">{l}</span>
                ))}
              </div>
            )}
            <div className="flex items-center gap-2 mt-3">
              <button
                className="btn primary"
                onClick={async () => {
                  await selectProject(p.id)
                  setView('chat')
                }}
              >
                Use in chat
              </button>
              <button
                className="btn"
                onClick={async () => {
                  await selectProject(p.id)
                  useApp.getState().setInspectorOpen(true)
                  useApp.getState().setInspectorTab('explorer')
                }}
              >
                Browse files
              </button>
              <button className="btn" onClick={() => void api.revealPath(p.rootPath)}>
                Reveal
              </button>
              <div className="flex-1" />
              <button
                className="btn danger"
                onClick={() => void removeProject(p.id)}
                title="Remove from list (files are not deleted)"
              >
                <Trash2 size={14} /> Remove
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
