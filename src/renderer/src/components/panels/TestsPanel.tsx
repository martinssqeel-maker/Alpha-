import { useEffect, useState } from 'react'
import { Play, TestTube2 } from 'lucide-react'
import { api } from '../../lib/api'
import { useApp } from '../../store/useApp'

interface Script {
  label: string
  command: string
}

export default function TestsPanel() {
  const projectId = useApp((s) => s.activeProjectId)
  const runCommand = useApp((s) => s.runCommand)
  const [scripts, setScripts] = useState<Script[]>([])
  const [custom, setCustom] = useState('')

  useEffect(() => {
    if (!projectId) return
    setScripts([])
    void detect(projectId, setScripts)
  }, [projectId])

  if (!projectId) return <Empty text="Open a project to run tests." />

  const run = (command: string): void => {
    void runCommand(command)
  }

  return (
    <div className="flex flex-col h-full">
      <div className="p-2 flex items-center gap-2" style={{ borderBottom: '1px solid var(--border)' }}>
        <TestTube2 size={14} style={{ color: 'var(--muted)' }} />
        <span className="text-xs" style={{ color: 'var(--muted)' }}>Detected checks</span>
      </div>
      <div className="flex-1 overflow-auto p-2 flex flex-col gap-2">
        {scripts.length === 0 && (
          <div className="text-xs" style={{ color: 'var(--faint)' }}>
            No scripts detected. Run a command below.
          </div>
        )}
        {scripts.map((s) => (
          <div key={s.command} className="card tight flex items-center gap-2" style={{ padding: '8px 10px' }}>
            <div className="flex-1 min-w-0">
              <div className="text-xs font-medium">{s.label}</div>
              <div className="mono text-xs" style={{ color: 'var(--faint)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {s.command}
              </div>
            </div>
            <button className="btn primary icon" style={{ width: 28, height: 28 }} title="Run" onClick={() => run(s.command)}>
              <Play size={13} />
            </button>
          </div>
        ))}

        <div className="flex gap-1 mt-1">
          <input
            className="input mono text-xs"
            style={{ padding: '5px 9px' }}
            placeholder="Custom test command…"
            value={custom}
            onChange={(e) => setCustom(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && custom.trim() && run(custom.trim())}
          />
          <button className="btn icon" style={{ width: 30, height: 30 }} disabled={!custom.trim()} onClick={() => run(custom.trim())}>
            <Play size={14} />
          </button>
        </div>
        <div className="text-xs" style={{ color: 'var(--faint)' }}>
          Commands run in the Terminal tab. Runs stream live and can be cancelled.
        </div>
      </div>
    </div>
  )
}

async function detect(projectId: string, setScripts: (s: Script[]) => void): Promise<void> {
  try {
    const file = await api.projects.read(projectId, 'package.json')
    const pkg = JSON.parse(file.content) as { scripts?: Record<string, string>; packageManager?: string }
    const pm = pkg.packageManager?.startsWith('pnpm')
      ? 'pnpm'
      : pkg.packageManager?.startsWith('yarn')
        ? 'yarn'
        : 'npm'
    const out: Script[] = []
    const scripts = pkg.scripts ?? {}
    const priority = ['test', 'test:unit', 'test:e2e', 'lint', 'typecheck', 'type-check', 'build']
    for (const name of priority) {
      if (scripts[name]) {
        out.push({
          label: name,
          command: pm === 'npm' ? (name === 'test' ? 'npm test' : `npm run ${name}`) : `${pm} ${name}`
        })
      }
    }
    for (const [name] of Object.entries(scripts)) {
      if (!priority.includes(name)) {
        out.push({ label: name, command: pm === 'npm' ? `npm run ${name}` : `${pm} ${name}` })
      }
    }
    setScripts(out.slice(0, 12))
  } catch {
    setScripts([])
  }
}

function Empty({ text }: { text: string }) {
  return (
    <div className="flex items-center justify-center h-full p-6 text-center text-sm" style={{ color: 'var(--muted)' }}>
      {text}
    </div>
  )
}
