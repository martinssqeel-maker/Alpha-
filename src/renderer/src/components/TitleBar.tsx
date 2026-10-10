import { Cpu, FolderGit2, Shield } from 'lucide-react'
import { useApp } from '../store/useApp'

export default function TitleBar() {
  const activeProject = useApp((s) =>
    s.projects.find((p) => p.id === s.activeProjectId)
  )
  const model = useApp((s) => {
    const m = s.models.find((x) => x.providerId === s.selectedProviderId && x.id === s.selectedModelId)
    return m ? `${m.name}` : null
  })
  const mode = useApp((s) => s.settings?.permissions.mode ?? 'assist')

  return (
    <div className="titlebar">
      <div className="flex items-center gap-2 font-semibold no-drag">
        <div
          className="grid place-items-center rounded-md"
          style={{ width: 22, height: 22, background: 'var(--accent)', color: '#fff', fontSize: 12 }}
        >
          A
        </div>
        <span>Alpha AI Workspace</span>
      </div>
      <div className="flex-1" />
      <div className="flex items-center gap-3 text-xs no-drag" style={{ color: 'var(--muted)', paddingRight: 140 }}>
        {activeProject && (
          <span className="flex items-center gap-1">
            <FolderGit2 size={13} /> {activeProject.name}
          </span>
        )}
        {model && (
          <span className="flex items-center gap-1">
            <Cpu size={13} /> {model}
          </span>
        )}
        <span className="flex items-center gap-1">
          <Shield size={13} /> {mode}
        </span>
      </div>
    </div>
  )
}
