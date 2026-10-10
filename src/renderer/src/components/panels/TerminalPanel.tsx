import { useState } from 'react'
import { Play, Square, Trash2, TerminalSquare } from 'lucide-react'
import { useApp } from '../../store/useApp'

export default function TerminalPanel() {
  const [command, setCommand] = useState('')
  const terminals = useApp((s) => s.terminals)
  const runCommand = useApp((s) => s.runCommand)
  const cancelRun = useApp((s) => s.cancelRun)
  const projectId = useApp((s) => s.activeProjectId)

  const run = (): void => {
    const c = command.trim()
    if (!c) return
    void runCommand(c)
    setCommand('')
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 p-2" style={{ borderBottom: '1px solid var(--border)' }}>
        <TerminalSquare size={14} style={{ color: 'var(--muted)' }} />
        <input
          className="input mono text-xs"
          style={{ padding: '5px 9px' }}
          placeholder={projectId ? 'Run a command in the project…' : 'Open a project first'}
          value={command}
          disabled={!projectId}
          onChange={(e) => setCommand(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && run()}
        />
        <button className="btn primary icon" style={{ width: 30, height: 30 }} onClick={run} disabled={!projectId || !command.trim()}>
          <Play size={14} />
        </button>
      </div>

      <div className="flex-1 overflow-auto p-2 flex flex-col gap-2">
        {terminals.length === 0 && (
          <div className="text-xs p-2" style={{ color: 'var(--muted)' }}>
            Commands run in the project directory. Destructive commands require approval.
          </div>
        )}
        {[...terminals].reverse().map((t) => (
          <div key={t.runId} className="card tight" style={{ padding: 0, overflow: 'hidden' }}>
            <div className="flex items-center gap-2 p-2" style={{ background: 'var(--surface-2)', borderBottom: '1px solid var(--border)' }}>
              <span className={`dot ${t.running ? 'running' : t.exit ? (t.exit.code === 0 ? '' : 'failed') : ''}`} />
              <span className="mono text-xs flex-1" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {t.command}
              </span>
              {t.exit && <span className="pill" style={{ fontSize: 10, padding: '0 6px' }}>exit {t.exit.code ?? '?'} · {t.exit.durationMs}ms</span>}
              {t.running ? (
                <button className="btn danger icon" style={{ width: 22, height: 22 }} title="Cancel" onClick={() => void cancelRun(t.runId)}>
                  <Square size={12} />
                </button>
              ) : (
                <button
                  className="btn ghost icon"
                  style={{ width: 22, height: 22 }}
                  title="Clear"
                  onClick={() => useApp.setState({ terminals: useApp.getState().terminals.filter((x) => x.runId !== t.runId) })}
                >
                  <Trash2 size={12} />
                </button>
              )}
            </div>
            <pre className="terminal mono text-xs" style={{ margin: 0, maxHeight: 320, overflow: 'auto' }}>
              {t.lines.map((l) => (
                <span key={l.id} className={l.stream}>
                  {l.data}
                </span>
              ))}
              {t.running && <span className="spin">◌</span>}
            </pre>
          </div>
        ))}
      </div>
    </div>
  )
}
