import { Activity, FileCode2, FolderOpen, GitBranch, GitCompare, Globe2, ListTree, PanelRightClose, SquareTerminal, TestTube2 } from 'lucide-react'
import type { InspectorTab } from '@shared/types'
import { useApp } from '../store/useApp'
import ExplorerPanel from './panels/ExplorerPanel'
import ChangesPanel from './panels/ChangesPanel'
import DiffPanel from './panels/DiffPanel'
import ActivityPanel from './panels/ActivityPanel'
import TerminalPanel from './panels/TerminalPanel'
import GitPanel from './panels/GitPanel'
import TestsPanel from './panels/TestsPanel'
import BrowserPanel from './panels/BrowserPanel'

const TABS: { id: InspectorTab; label: string; icon: typeof ListTree }[] = [
  { id: 'explorer', label: 'Explorer', icon: ListTree },
  { id: 'changes', label: 'Changes', icon: GitCompare },
  { id: 'diff', label: 'Diff', icon: FileCode2 },
  { id: 'activity', label: 'Activity', icon: Activity },
  { id: 'terminal', label: 'Terminal', icon: SquareTerminal },
  { id: 'tests', label: 'Tests', icon: TestTube2 },
  { id: 'git', label: 'Git', icon: GitBranch },
  { id: 'browser', label: 'Browser', icon: Globe2 }
]

export default function Inspector() {
  const tab = useApp((s) => s.inspectorTab)
  const blocked = useApp((s) => s.pendingApprovals.length > 0)
  const isSending = useApp((s) => s.isSending)
  const project = useApp((s) => s.projects.find((p) => p.id === s.activeProjectId))
  const setTab = useApp((s) => s.setInspectorTab)
  const setOpen = useApp((s) => s.setInspectorOpen)
  const activeTab = TABS.find((item) => item.id === tab) ?? TABS[0]
  const ActiveIcon = activeTab.icon
  const status = blocked ? 'Approval needed' : isSending ? 'Agent working' : project ? 'Workspace ready' : 'No project open'

  return (
    <div className="inspector-inner">
      <div className="inspector-heading">
        <div className="inspector-heading-main">
          <div className="inspector-eyebrow">Developer workspace</div>
          <div className="inspector-title-row">
            <ActiveIcon size={16} aria-hidden="true" />
            <h2 className="inspector-title">{activeTab.label}</h2>
            {project && <span className="inspector-project-name" title={project.rootPath}>{project.name}</span>}
          </div>
        </div>
        <span className={`inspector-status${blocked ? ' needs-approval' : isSending ? ' working' : ''}`}>
          <span className="inspector-status-dot" aria-hidden="true" />
          {status}
        </span>
        <button
          className="btn ghost icon inspector-collapse"
          title="Collapse developer workspace"
          aria-label="Collapse developer workspace"
          onClick={() => setOpen(false)}
        >
          <PanelRightClose size={15} />
        </button>
      </div>
      <div className="tabbar" role="tablist" aria-label="Workspace panels">
        {TABS.map((t) => (
          <button
            key={t.id}
            className={`tab ${tab === t.id ? 'active' : ''}`}
            role="tab"
            aria-label={t.label}
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
            title={t.label}
          >
            <t.icon size={14} />
            <span className="text-xs">{t.label}</span>
          </button>
        ))}
      </div>
      <div className="inspector-content">
        {tab === 'explorer' && <ExplorerPanel />}
        {tab === 'changes' && <ChangesPanel />}
        {tab === 'diff' && <DiffPanel />}
        {tab === 'activity' && <ActivityPanel />}
        {tab === 'terminal' && <TerminalPanel />}
        {tab === 'tests' && <TestsPanel />}
        {tab === 'git' && <GitPanel />}
        {tab === 'browser' && <BrowserPanel blocked={blocked} />}
      </div>
    </div>
  )
}
