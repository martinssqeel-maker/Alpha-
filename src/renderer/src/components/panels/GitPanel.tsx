import { useEffect, useState } from 'react'
import { ArrowDown, ArrowUp, GitBranch, GitCommitHorizontal, Plus, RefreshCw } from 'lucide-react'
import { api } from '../../lib/api'
import { useApp } from '../../store/useApp'
import ProjectContextEmpty from './ProjectContextEmpty'

export default function GitPanel() {
  const projectId = useApp((s) => s.activeProjectId)
  const git = useApp((s) => s.gitStatus)
  const refreshGit = useApp((s) => s.refreshGit)
  const toast = useApp((s) => s.toast)
  const [message, setMessage] = useState('')
  const [push, setPush] = useState(false)
  const [branches, setBranches] = useState<{ local: string[]; remote: string[]; current?: string } | null>(null)
  const [newBranch, setNewBranch] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!projectId || !git?.isRepo) return
    api.git
      .branches(projectId)
      .then(setBranches)
      .catch(() => setBranches(null))
  }, [projectId, git?.isRepo, git?.branch])

  if (!projectId) return <ProjectContextEmpty title="Connect a project to Git" description="Open a project to inspect its branch, stage changes, and use the repository's existing Git remotes." Icon={GitBranch} />

  if (!git?.isRepo) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3 p-6 text-center">
        <GitBranch size={22} style={{ color: 'var(--muted)' }} />
        <div className="text-sm" style={{ color: 'var(--muted)' }}>This project is not a Git repository.</div>
        <button
          className="btn primary"
          onClick={async () => {
            try {
              await api.git.init(projectId)
              toast('Initialized Git repository', 'success')
              await refreshGit()
            } catch (e) {
              toast((e as Error).message, 'error')
            }
          }}
        >
          Initialize repository
        </button>
      </div>
    )
  }

  const run = async (fn: () => Promise<unknown>, successMsg?: string): Promise<void> => {
    setBusy(true)
    try {
      await fn()
      if (successMsg) toast(successMsg, 'success')
      await refreshGit()
    } catch (e) {
      toast((e as Error).message, 'error')
    } finally {
      setBusy(false)
    }
  }

  const commit = async (): Promise<void> => {
    if (!message.trim()) return
    await run(async () => {
      const res = await api.git.commit({ projectId, message: message.trim(), push })
      if (!res.ok && res.message) throw new Error(res.message)
      setMessage('')
    }, push ? 'Committed and pushed' : 'Committed')
  }

  return (
    <div className="flex flex-col h-full overflow-auto">
      <div className="flex items-center gap-2 p-2 text-xs" style={{ borderBottom: '1px solid var(--border)' }}>
        <GitBranch size={13} />
        <span className="font-medium">{git.branch ?? '(detached)'}</span>
        {(git.ahead ?? 0) > 0 && <span className="pill" style={{ fontSize: 10, padding: '0 6px' }}>↑{git.ahead}</span>}
        {(git.behind ?? 0) > 0 && <span className="pill" style={{ fontSize: 10, padding: '0 6px' }}>↓{git.behind}</span>}
        <div className="flex-1" />
        <button className="btn ghost icon" style={{ width: 24, height: 24 }} title="Refresh" onClick={() => void refreshGit()}>
          <RefreshCw size={13} />
        </button>
      </div>

      <div className="p-2 flex flex-col gap-2">
        <textarea
          className="textarea text-xs"
          rows={3}
          placeholder="Commit message"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
        />
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-1 text-xs" style={{ color: 'var(--muted)' }}>
            <input type="checkbox" checked={push} onChange={(e) => setPush(e.target.checked)} /> push after commit
          </label>
          <div className="flex-1" />
          <button className="btn primary" disabled={busy || !message.trim()} onClick={() => void commit()}>
            <GitCommitHorizontal size={14} /> Commit
          </button>
        </div>
        <div className="flex items-center gap-2">
          <button className="btn flex-1" disabled={busy || !git.upstream} onClick={() => void run(() => api.git.pull(projectId), 'Pulled')}>
            <ArrowDown size={14} /> Pull
          </button>
          <button className="btn flex-1" disabled={busy || !git.upstream} onClick={() => void run(() => api.git.push(projectId), 'Pushed')}>
            <ArrowUp size={14} /> Push
          </button>
        </div>
        {!git.upstream && (
          <div className="text-xs" style={{ color: 'var(--faint)' }}>
            No upstream configured. Add a remote in the GitHub tab or set one below.
          </div>
        )}
      </div>

      <div className="p-2" style={{ borderTop: '1px solid var(--border)' }}>
        <div className="text-xs font-semibold mb-1" style={{ color: 'var(--muted)' }}>BRANCHES</div>
        <div className="flex gap-1 mb-1">
          <input
            className="input text-xs"
            style={{ padding: '4px 8px' }}
            placeholder="new-branch-name"
            value={newBranch}
            onChange={(e) => setNewBranch(e.target.value)}
          />
          <button
            className="btn icon"
            style={{ width: 28, height: 28 }}
            title="Create branch"
            disabled={!newBranch.trim()}
            onClick={() =>
              void run(async () => {
                await api.git.createBranch(projectId, newBranch.trim(), true)
                setNewBranch('')
              }, 'Branch created')
            }
          >
            <Plus size={14} />
          </button>
        </div>
        <div className="flex flex-col">
          {branches?.local.map((b) => (
            <button
              key={b}
              className={`tree-item ${b === git.branch ? 'active' : ''}`}
              onClick={() => b !== git.branch && void run(() => api.git.checkout(projectId, b), `Checked out ${b}`)}
            >
              <GitBranch size={13} />
              <span className="label text-xs">{b}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="p-2" style={{ borderTop: '1px solid var(--border)' }}>
        <div className="text-xs font-semibold mb-1" style={{ color: 'var(--muted)' }}>REMOTES</div>
        {git.remotes.length === 0 && <div className="text-xs" style={{ color: 'var(--faint)' }}>No remotes configured.</div>}
        {git.remotes.map((r) => (
          <div key={r.name} className="text-xs mono" style={{ color: 'var(--text-soft)' }}>
            {r.name} → {r.url}
          </div>
        ))}
      </div>
    </div>
  )
}
