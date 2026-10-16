import { FolderOpen, FolderPlus, type LucideIcon } from 'lucide-react'
import { useApp } from '../../store/useApp'

export default function ProjectContextEmpty({
  title,
  description,
  Icon = FolderOpen
}: {
  title: string
  description: string
  Icon?: LucideIcon
}) {
  const openProject = useApp((s) => s.openProject)
  const setView = useApp((s) => s.setView)

  return (
    <div className="inspector-empty-state">
      <div className="inspector-empty-mark"><Icon size={22} strokeWidth={1.7} /></div>
      <div className="inspector-empty-eyebrow">Workspace context</div>
      <h3>{title}</h3>
      <p>{description}</p>
      <button className="btn primary inspector-empty-action" onClick={() => void openProject()}>
        <FolderPlus size={14} /> Open project folder
      </button>
      <button className="inspector-empty-link" onClick={() => setView('projects')}>
        View saved projects <span aria-hidden="true">↗</span>
      </button>
      <div className="inspector-empty-footnote"><span aria-hidden="true">i</span> Alpha only shows files from a folder you choose.</div>
    </div>
  )
}
