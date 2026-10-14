import { useEffect, useState } from 'react'
import { Check, Copy, Github, Link2, Plus, RefreshCw, Unplug } from 'lucide-react'
import { api } from '../lib/api'
import { useApp } from '../store/useApp'

type Status = {
  connected: boolean
  login?: string
  method?: string
  scopes?: string[]
  message?: string
  oauthConfigured?: boolean
}
type Repo = { fullName: string; name: string; private: boolean; cloneUrl: string; defaultBranch: string; updatedAt: string }

/** A Device Flow sign-in that is waiting for the user to approve in the browser. */
type Device = { userCode: string; verificationUri: string; interval: number; expiresAt: number }

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
  const [device, setDevice] = useState<Device | null>(null)
  const [deviceStatus, setDeviceStatus] = useState('')
  const [copied, setCopied] = useState(false)
  const [now, setNow] = useState(Date.now())

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

  // Device Flow polling. Each tick performs a single poll in the main process;
  // the delay comes from GitHub's returned interval and is bumped on `slow_down`.
  // The effect tears down on cancel / completion / unmount, so polling always stops.
  useEffect(() => {
    if (!device) return
    let cancelled = false
    let timer: number | undefined

    const schedule = (delayMs: number): void => {
      timer = window.setTimeout(() => void tick(), delayMs)
    }

    const tick = async (): Promise<void> => {
      if (cancelled) return
      try {
        const res = await api.github.devicePoll()
        if (cancelled) return
        if (res.status === 'pending') {
          setDeviceStatus('Waiting for you to authorize in the browser…')
          schedule((res.interval ?? device.interval) * 1000)
          return
        }
        if (res.status === 'slow_down') {
          setDeviceStatus('Waiting… GitHub asked us to poll a little more slowly.')
          schedule((res.interval ?? device.interval) * 1000)
          return
        }
        if (res.status === 'success') {
          setDevice(null)
          setDeviceStatus('')
          toast(`Connected as ${res.login ?? 'GitHub user'}`, 'success')
          await loadStatus()
          void loadRepos(undefined, true)
          return
        }
        // denied / expired / error / not-started
        setDevice(null)
        setDeviceStatus('')
        toast(res.message ?? 'GitHub sign-in did not complete.', 'error')
      } catch (e) {
        if (!cancelled) {
          setDevice(null)
          setDeviceStatus('')
          toast((e as Error).message, 'error')
        }
      }
    }

    setDeviceStatus('Waiting for you to authorize in the browser…')
    schedule(device.interval * 1000)

    return () => {
      cancelled = true
      if (timer) window.clearTimeout(timer)
    }
  }, [device])

  // Cheap 1s tick so the "expires in" countdown stays honest.
  useEffect(() => {
    if (!device) return
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [device])

  const startDevice = async (): Promise<void> => {
    setBusy(true)
    try {
      const res = await api.github.deviceStart()
      if (!res.ok || !res.userCode) throw new Error(res.message ?? 'Could not start GitHub sign-in.')
      setCopied(false)
      setNow(Date.now())
      setDevice({
        userCode: res.userCode,
        verificationUri: res.verificationUri ?? 'https://github.com/login/device',
        interval: res.interval ?? 5,
        expiresAt: Date.now() + (res.expiresIn ?? 900) * 1000
      })
      // The main process has already opened the default browser at the code page.
    } catch (e) {
      toast((e as Error).message, 'error')
    } finally {
      setBusy(false)
    }
  }

  const cancelDevice = async (): Promise<void> => {
    try {
      await api.github.deviceCancel()
    } catch {
      /* cancel is best-effort; clearing local state still stops polling */
    }
    setDevice(null)
    setDeviceStatus('')
    toast('GitHub sign-in cancelled.', 'info')
  }

  const reopenBrowser = async (): Promise<void> => {
    try {
      await api.github.deviceOpen()
    } catch (e) {
      toast((e as Error).message, 'error')
    }
  }

  const copyCode = async (): Promise<void> => {
    if (!device) return
    try {
      await navigator.clipboard.writeText(device.userCode)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2000)
    } catch {
      toast('Could not copy the code — select it manually.', 'error')
    }
  }

  const connect = async (): Promise<void> => {
    if (!token.trim()) return
    setBusy(true)
    try {
      const res = await api.github.connect({ token: token.trim(), method: 'token' })
      if (!res.ok) throw new Error(res.message ?? 'Connection failed')
      setToken('')
      toast(`Connected as ${res.login ?? 'user'}`, 'success')
      await loadStatus()
      void loadRepos(undefined, true)
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

  const loadRepos = async (q?: string, force = false): Promise<void> => {
    if (!force && !status?.connected) return
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

  const methodLabel = (method?: string): string =>
    method === 'device' ? 'browser' : method === 'gh' ? 'GitHub CLI' : 'token'
  const secondsLeft = device ? Math.max(0, Math.round((device.expiresAt - now) / 1000)) : 0
  const minutesLeft = Math.max(1, Math.ceil(secondsLeft / 60))

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
            {status?.method && <span className="pill">{methodLabel(status.method)}</span>}
            <div className="flex-1" />
            {status?.connected && (
              <button className="btn danger" onClick={() => void disconnect()}>
                <Unplug size={14} /> Disconnect
              </button>
            )}
          </div>

          {/* Browser sign-in (Device Flow) — waiting for approval in the browser. */}
          {!status?.connected && device && (
            <div className="mt-3 flex flex-col gap-2">
              <div className="text-sm">
                In the browser that just opened, enter this code and approve Alpha:
              </div>
              <div
                className="mono"
                style={{ fontSize: 30, letterSpacing: '0.12em', fontWeight: 700, userSelect: 'all' }}
              >
                {device.userCode}
              </div>
              <div className="flex items-center gap-2">
                <button className="btn" onClick={() => void copyCode()}>
                  {copied ? <Check size={14} /> : <Copy size={14} />} {copied ? 'Copied' : 'Copy code'}
                </button>
                <button className="btn" onClick={() => void reopenBrowser()}>
                  <Link2 size={14} /> Open GitHub again
                </button>
                <button className="btn danger" onClick={() => void cancelDevice()}>
                  Cancel
                </button>
              </div>
              <div className="text-xs" style={{ color: 'var(--muted)' }}>{deviceStatus}</div>
              <div className="text-xs" style={{ color: 'var(--faint)' }}>
                This code expires in about {minutesLeft} minute{minutesLeft === 1 ? '' : 's'}. Nothing
                is stored until you approve in the browser.
              </div>
            </div>
          )}

          {!status?.connected && !device && (
            <div className="mt-3 flex flex-col gap-2">
              <button
                className="btn primary"
                onClick={() => void startDevice()}
                disabled={busy || !status?.oauthConfigured}
              >
                <Github size={14} /> Connect with browser
              </button>
              {!status?.oauthConfigured && (
                <div className="text-xs" style={{ color: 'var(--faint)' }}>
                  Browser sign-in needs a GitHub OAuth Client ID configured for this app (see
                  HANDOVER.md). A personal access token still works below.
                </div>
              )}
              <div className="text-xs" style={{ color: 'var(--faint)' }}>or connect with a token</div>
              <label className="field">
                <span>Personal access token</span>
                <input
                  className="input mono"
                  type="password"
                  placeholder="ghp_…  (repo scope)"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && void connect()}
                />
                <span className="hint">
                  Stored with OS-level encryption. If the GitHub CLI (<span className="mono">gh</span>) is
                  installed and authenticated, it is used automatically when no token is set.
                </span>
              </label>
              <button
                className="btn"
                style={{ alignSelf: 'flex-start' }}
                onClick={() => void connect()}
                disabled={busy || !token.trim()}
              >
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
