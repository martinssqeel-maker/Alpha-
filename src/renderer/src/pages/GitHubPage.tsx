import { useEffect, useState } from 'react'
import { Github, Link2, Plus, RefreshCw, Unplug } from 'lucide-react'
import { api } from '../lib/api'
import { useApp } from '../store/useApp'

type Status = { connected: boolean; login?: string; method?: string; scopes?: string[]; message?: string }
type Repo = { fullName: string; name: string; private: boolean; cloneUrl: string; defaultBranch: string; updatedAt: string }

export default function GitHubPage() {
  const toast = useApp((s) => s.toast)
  const activeProjectId = useApp((s) => s.activeProjectId)
  const refreshGit = useApp((s) => s.refreshGit)
  const [status, setStatus] = useState<Status | null>(null)
  const [token, setToken] = useState('')
  const [repos, setRepos] = useState<Repo[]>([])
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)
  const [creating, setCreating] = useState(false)
  const [repoName, setRepoName] = useState('')
  const [repoPrivate, setRepoPrivate] = useState(true)

  const loadStatus = async (): Promise<void> => {
    try {
      setStatus(await api.github.status())
    } catch (e) {
      toast((e as Error).message, 'error')
    }
  }

  useEffect(() => {
    void loadStatus()
  }, [])

  const connect = async (): Promise<void> => {
    if (!token.trim()) return
    setBusy(true)
    try {
      const res = await api.github.connect({ token: token.trim(), method: 'token' })
      if (!res.ok) throw new Error(res.message ?? 'Connection failed')
      setToken('')
      toast(`Connected as ${res.login ?? 'user'}`, 'success')
      await loadStatus()
      void loadRepos()
    } catch (e) {
      toast((e as Error).message, 'error')
    } finally {
      setBusy(false)
    }
  }

  const disconnect = async (): Promise<void> => {
    await api.github.disconnect()
    setRepos([])
    await loadStatus()
    toast('Disconnected from GitHub', 'success')
  }

  const loadRepos = async (q?: string): Promise<void> => {
    if (!status?.connected) return
    setBusy(true)
    try {
      setRepos(await api.github.repos(q))
    } catch (e) {
      toast((e as Error).message, 'error')
    } finally {
      setBusy(false)
    }
  }

  const createRepo = async (): Promise<void> => {
    if (!repoName.trim()) return
    setBusy(true)
    try {
      const res = await api.github.createRepo({ name: repoName.trim(), private: repoPrivate })
      if (!res.ok) throw new Error(res.message ?? 'Create failed')
      toast(`Created ${res.fullName}`, 'success')
      if (activeProjectId && res.cloneUrl) {
        await api.git.setRemote(activeProjectId, 'origin', res.cloneUrl)
        toast('Set origin remote for the active project', 'success')
        await refreshGit()
      }
      setCreating(false)
      setRepoName('')
      void loadRepos()
    } catch (e) {
      toast((e as Error).message, 'error')
    } finally {
      setBusy(false)
    }
  }

  const attachRemote = async (repo: Repo): Promise<void> => {
    if (!activeProjectId) {
      toast('Open a project first.', 'error')
      return
    }
    setBusy(true)
    try {
      await api.git.setRemote(activeProjectId, 'origin', repo.cloneUrl)
      toast(`Set origin → ${repo.fullName}`, 'success')
      await refreshGit()
    } catch (e) {
      toast((e as Error).message, 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="page">
      <div className="page-header">
        <Github size={18} />
        <h1 className="page-title">GitHub</h1>
        <div className="flex-1" />
        {status?.connected && (
          <button className="btn" onClick={() => void loadRepos(query)} disabled={busy}>
            <RefreshCw size={14} className={busy ? 'spin' : ''} /> Refresh repos
          </button>
        )}
      </div>

      <div className="page-scroll">
        <div className="card mb-3">
          <div className="flex items-center gap-2">
            <span className={`dot ${status?.connected ? 'running' : 'failed'}`} />
            <span className="font-medium text-sm">
              {status?.connected ? `Connected as ${status.login ?? 'unknown'}` : 'Not connected'}
            </span>
            {status?.method && <span className="pill">{status.method}</span>}
            <div className="flex-1" />
            {status?.connected && (
              <button className="btn danger" onClick={() => void disconnect()}>
                <Unplug size={14} /> Disconnect
              </button>
            )}
          </div>
          {!status?.connected && (
            <div className="mt-3">
              <label className="field">
                <span>Personal access token</span>
                <input
                  className="input mono"
                  type="password"
                  placeholder="ghp_…  (repo + workflow scopes)"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && void connect()}
                />
                <span className="hint">
                  Stored with OS-level encryption. If the GitHub CLI (<span className="mono">gh</span>) is installed and authenticated,
                  it will be used automatically when no token is set.
                </span>
              </label>
              <button className="btn primary mt-2" onClick={() => void connect()} disabled={busy || !token.trim()}>
                <Link2 size={14} /> Connect
              </button>
            </div>
          )}
          {status?.message && (
            <div className="text-xs mt-2" style={{ color: 'var(--muted)' }}>{status.message}</div>
          )}
        </div>

        {status?.connected && (
          <>
            <div className="card mb-3">
              <div className="flex items-center gap-2 mb-2">
                <input
                  className="input text-sm"
                  placeholder="Search your repositories…"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && void loadRepos(query)}
                />
                <button className="btn" onClick={() => void loadRepos(query)} disabled={busy}>Search</button>
                <button className="btn" onClick={() => void loadRepos()} disabled={busy}>List all</button>
              </div>
              <div className="flex items-center gap-2">
                <button className="btn primary" onClick={() => setCreating((c) => !c)}>
                  <Plus size={14} /> New repository
                </button>
              </div>
              {creating && (
                <div className="mt-3 flex flex-col gap-2">
                  <input className="input" placeholder="repository-name" value={repoName} onChange={(e) => setRepoName(e.target.value)} />
                  <label className="flex items-center gap-2 text-xs" style={{ color: 'var(--muted)' }}>
                    <input type="checkbox" checked={repoPrivate} onChange={(e) => setRepoPrivate(e.target.checked)} /> private
                  </label>
                  <button className="btn primary" onClick={() => void createRepo()} disabled={busy || !repoName.trim()}>
                    Create
                  </button>
                </div>
              )}
            </div>

            <div className="grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))' }}>
              {repos.map((r) => (
                <div key={r.fullName} className="card">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-sm" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {r.fullName}
                    </span>
                    {r.private && <span className="pill">private</span>}
                  </div>
                  <div className="text-xs mt-1" style={{ color: 'var(--faint)' }}>
                    {r.defaultBranch} · updated {new Date(r.updatedAt).toLocaleDateString()}
                  </div>
                  <button className="btn mt-2" onClick={() => void attachRemote(r)} disabled={busy || !activeProjectId}>
                    <Link2 size={13} /> Set as origin for active project
                  </button>
                </div>
              ))}
              {repos.length === 0 && <div className="text-xs" style={{ color: 'var(--faint)' }}>No repositories loaded.</div>}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
