import { useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import type { DiagnosticsInfo } from '@shared/ipc'
import { api } from '../lib/api'
import { useApp } from '../store/useApp'

export default function HelpPage() {
  const [info, setInfo] = useState<DiagnosticsInfo | null>(null)
  const [busy, setBusy] = useState(false)
  const toast = useApp((s) => s.toast)

  const load = async (): Promise<void> => {
    setBusy(true)
    try {
      setInfo(await api.diagnostics())
    } catch (e) {
      toast((e as Error).message, 'error')
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    void load()
  }, [])

  return (
    <div className="page">
      <div className="page-header">
        <h1 className="page-title">Help & Diagnostics</h1>
        <div className="flex-1" />
        <button className="btn" onClick={() => void load()} disabled={busy}>
          <RefreshCw size={14} className={busy ? 'spin' : ''} /> Refresh
        </button>
      </div>

      <div className="page-scroll" style={{ maxWidth: 860 }}>
        <div className="card mb-3">
          <h2 className="text-sm font-semibold mb-2">Getting started</h2>
          <ol className="text-sm" style={{ paddingLeft: 20, color: 'var(--text-soft)' }}>
            <li>Open a project folder from the Projects tab to give the assistant controlled access to its files.</li>
            <li>Pick a model in the composer footer. Local Ollama models are used by default.</li>
            <li>Choose a mode: Chat (no changes), Assist (approve changes), or Agent (autonomous with safeguards).</li>
            <li>Watch tool activity in the inspector. Approve or deny actions when prompted.</li>
            <li>Review diffs in the Changes/Diff tabs before committing from the Git tab.</li>
          </ol>
        </div>

        <div className="card mb-3">
          <h2 className="text-sm font-semibold mb-2">Safety</h2>
          <ul className="text-sm" style={{ paddingLeft: 20, color: 'var(--text-soft)' }}>
            <li>File access is confined to the opened project root — path traversal and symlink escapes are blocked.</li>
            <li>Sensitive files (.env, keys, credentials) are denied by default.</li>
            <li>Destructive shell commands require explicit approval.</li>
            <li>Forces-push is never performed. Secrets are stored with OS-level encryption and redacted from logs.</li>
          </ul>
        </div>

        <div className="card">
          <h2 className="text-sm font-semibold mb-2">Diagnostics</h2>
          {!info && <div className="text-sm" style={{ color: 'var(--muted)' }}>Loading…</div>}
          {info && (
            <table className="diag-table">
              <tbody>
                <DiagRow k="App version" v={info.appVersion} />
                <DiagRow k="Electron" v={info.electron} />
                <DiagRow k="Chromium" v={info.chrome} />
                <DiagRow k="Node" v={info.node} />
                <DiagRow k="Platform" v={info.platform} />
                <DiagRow k="SQLite (sql.js)" v={info.sqlite ? 'available' : 'unavailable'} />
                <DiagRow k="Git" v={info.git.available ? info.git.version ?? 'available' : 'not found'} />
                <DiagRow k="GitHub CLI" v={info.gh.available ? info.gh.version ?? 'available' : 'not installed'} />
                <DiagRow k="Data path" v={info.dataPath} mono />
                <DiagRow k="Database" v={info.dbPath} mono />
                <DiagRow k="Logs" v={info.logPath} mono />
              </tbody>
            </table>
          )}
          {info && info.providers.length > 0 && (
            <div className="mt-3">
              <div className="text-xs font-semibold mb-1" style={{ color: 'var(--muted)' }}>PROVIDERS</div>
              {info.providers.map((p) => (
                <div key={p.providerId} className="flex items-center gap-2 text-xs">
                  <span className={`dot ${p.state === 'connected' ? 'running' : p.state === 'disabled' ? '' : 'failed'}`} />
                  <span className="mono">{p.providerId}</span>
                  <span style={{ color: 'var(--muted)' }}>{p.state}</span>
                  {p.message && <span style={{ color: 'var(--faint)' }}>— {p.message}</span>}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function DiagRow({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <tr>
      <td className="dk">{k}</td>
      <td className={mono ? 'mono' : ''} style={{ wordBreak: 'break-all' }}>{v}</td>
    </tr>
  )
}
