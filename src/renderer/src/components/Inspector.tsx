import { FileCode2, GitBranch, GitCompare, ListTree, SquareTerminal, TestTube2, Activity } from 'lucide-react'
import type { InspectorTab } from '@shared/types'
import { useApp } from '../store/useApp'
import ExplorerPanel from './panels/ExplorerPanel'
import ChangesPanel from './panels/ChangesPanel'
import DiffPanel from './panels/DiffPanel'
import ActivityPanel from './panels/ActivityPanel'
import TerminalPanel from './panels/TerminalPanel'
import GitPanel from './panels/GitPanel'
import TestsPanel from './panels/TestsPanel'

const TABS: { id: InspectorTab; label: string; icon: typeof ListTree }[] = [
  { id: 'explorer', label: 'Explorer', icon: ListTree },
  { id: 'changes', label: 'Changes', icon: GitCompare },
  { id: 'diff', label: 'Diff', icon: FileCode2 },
  { id: 'activity', label: 'Activity', icon: Activity },
  { id: 'terminal', label: 'Terminal', icon: SquareTerminal },
  { id: 'tests', label: 'Tests', icon: TestTube2 },
  { id: 'git', label: 'Git', icon: GitBranch }
]

export default function Inspector() {
  const tab = useApp((s) => s.inspectorTab)
  const setTab = useApp((s) => s.setInspectorTab)

  return (
    <div className="inspector-inner">
      <div className="tabbar">
        {TABS.map((t) => (
          <button
            key={t.id}
            className={`tab ${tab === t.id ? 'active' : ''}`}
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
      </div>
    </div>
  )
}
