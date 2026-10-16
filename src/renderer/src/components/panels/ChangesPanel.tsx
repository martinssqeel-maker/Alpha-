import { RefreshCw } from 'lucide-react'
import type { DiffFile } from '@shared/types'
import { api } from '../../lib/api'
import { useApp } from '../../store/useApp'
import { useWorkspace } from '../../store/useWorkspace'
import ProjectContextEmpty from './ProjectContextEmpty'

const STATUS_COLOR: Record<DiffFile['status'], string> = {
  modified: 'var(--warn)',
  added: 'var(--success)',
  untracked: 'var(--success)',
  deleted: 'var(--danger)',
  renamed: 'var(--accent)'
}

const STATUS_LABEL: Record<DiffFile['status'], string> = {
  modified: 'M',
  added: 'A',
  untracked: 'U',
  deleted: 'D',
  renamed: 'R'
}

export default function ChangesPanel() {
  const projectId = useApp((s) => s.activeProjectId)
  const git = useApp((s) => s.gitStatus)
  const refreshGit = useApp((s) => s.refreshGit)
  const toast = useApp((s) => s.toast)
  const openDiff = useWorkspace((s) => s.openDiff)
  const setTab = useApp((s) => s.setInspectorTab)

  if (!projectId) return <ProjectContextEmpty title="Review project changes" description="Open a project to see its real working-tree changes, inspect diffs, and stage files." />

  const files = git?.files ?? []

  const showDiff = async (file: DiffFile, staged = false): Promise<void> => {
    try {
      const { patch } = await api.git.diff(projectId, file.path, staged)
      openDiff({
        title: `${file.path}${staged ? ' (staged)' : ''}`,
        patch: patch || '(no textual diff — possibly a binary file)',
        mode: 'git',
        path: file.path,
        staged
      })
      setTab('diff')
    } catch (e) {
      toast(`Diff failed: ${(e as Error).message}`, 'error')
    }
  }

  const stage = async (paths: string[], unstage = false): Promise<void> => {
    try {
      if (unstage) await api.git.unstage(projectId, paths)
      else await api.git.stage(projectId, paths)
      await refreshGit()
    } catch (e) {
      toast(`Git failed: ${(e as Error).message}`, 'error')
    }
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 p-2 text-xs" style={{ borderBottom: '1px solid var(--border)' }}>
        <span style={{ color: 'var(--muted)' }}>
          {git?.isRepo ? `${files.length} changed file${files.length === 1 ? '' : 's'}` : 'Not a git repository'}
        </span>
        <div className="flex-1" />
        {files.length > 0 && (
          <>
            <button className="btn ghost" style={{ padding: '2px 8px' }} onClick={() => void stage(files.map((f) => f.path))}>
              Stage all
            </button>
            <button className="btn ghost" style={{ padding: '2px 8px' }} onClick={() => void stage(files.map((f) => f.path), true)}>
              Unstage
            </button>
          </>
        )}
        <button className="btn ghost icon" style={{ width: 24, height: 24 }} title="Refresh" onClick={() => void refreshGit()}>
          <RefreshCw size={13} />
        </button>
      </div>
      <div className="flex-1 overflow-auto p-1">
        {files.map((f) => (
          <div key={f.path} className="changes-row">
            <button className="changes-file-button" title={`Open diff for ${f.path}`} onClick={() => void showDiff(f)}>
              <span className="changes-file-status" style={{ color: STATUS_COLOR[f.status] }} title={f.status} aria-label={f.status}>{STATUS_LABEL[f.status]}</span>
              <span className="changes-file-path">{f.path}</span>
              <span className="changes-line-count added">+{f.additions}</span>
              <span className="changes-line-count deleted">-{f.deletions}</span>
            </button>
            <button
              className="btn ghost icon"
              style={{ width: 22, height: 22 }}
              title="Stage"
              aria-label={`Stage ${f.path}`}
              onClick={(e) => {
                e.stopPropagation()
                void stage([f.path])
              }}
            >
              +
            </button>
          </div>
        ))}
        {git?.isRepo && files.length === 0 && <Empty text="Working tree clean" />}
      </div>
    </div>
  )
}

function Empty({ text }: { text: string }) {
  return (
    <div className="flex items-center justify-center h-full p-6 text-center text-sm" style={{ color: 'var(--muted)' }}>
      {text}
    </div>
  )
}
