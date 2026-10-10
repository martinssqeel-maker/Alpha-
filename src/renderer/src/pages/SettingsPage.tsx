import type { PermissionLevel, PermissionMode, PermissionSettings, UpdateStatus } from '@shared/types'
import { permissionsForMode } from '@shared/permissions'
import { useApp } from '../store/useApp'

const PERMISSION_ROWS: { key: keyof Omit<PermissionSettings, 'mode'>; label: string; hint: string }[] = [
  { key: 'fileWrites', label: 'Edit files', hint: 'Create or modify files inside the project' },
  { key: 'fileDeletes', label: 'Delete files', hint: 'Remove files from the project' },
  { key: 'terminal', label: 'Run commands', hint: 'Execute shell commands in the project directory' },
  { key: 'packageInstall', label: 'Install packages', hint: 'npm/pip/other package managers' },
  { key: 'network', label: 'Network access', hint: 'Commands that reach the network' },
  { key: 'gitCommit', label: 'Git commits', hint: 'Stage and commit changes' },
  { key: 'githubPush', label: 'GitHub push', hint: 'Push commits to a remote' },
  { key: 'sensitiveFiles', label: 'Sensitive files', hint: '.env, keys, credentials — deny by default' }
]

const LEVELS: PermissionLevel[] = ['allow', 'ask', 'deny']
const MODES: { id: PermissionMode; label: string }[] = [
  { id: 'chat', label: 'Chat — no project access' },
  { id: 'assist', label: 'Assist — approve changes' },
  { id: 'agent', label: 'Agent — autonomous, safer defaults' }
]

export default function SettingsPage() {
  const settings = useApp((s) => s.settings)
  const providers = useApp((s) => s.providers)
  const save = useApp((s) => s.saveSettings)
  const models = useApp((s) => s.models)
  const refreshModels = useApp((s) => s.refreshModels)
  const update = useApp((s) => s.update)
  const checkForUpdates = useApp((s) => s.checkForUpdates)
  const downloadUpdate = useApp((s) => s.downloadUpdate)
  const installUpdate = useApp((s) => s.installUpdate)

  if (!settings) return null
  const perms = settings.permissions

  const setPerm = (key: keyof PermissionSettings, value: PermissionLevel | PermissionMode): void => {
    void save({ permissions: { ...perms, [key]: value } })
  }

  const setMode = (mode: PermissionMode): void => {
    void save({ permissions: permissionsForMode(mode, perms) })
  }

  return (
    <div className="page">
      <div className="page-header">
        <h1 className="page-title">Settings</h1>
      </div>

      <div className="page-scroll" style={{ maxWidth: 860 }}>
        <Section title="Appearance">
          <Row label="Theme" hint="Applies to the whole workspace.">
            <select className="select" value={settings.theme} onChange={(e) => void save({ theme: e.target.value })}>
              <option value="dark">Dark</option>
              <option value="light">Light</option>
            </select>
          </Row>
        </Section>

        <Section title="Local models">
          <Row label="Ollama URL" hint="The running Ollama endpoint on this machine.">
            <input
              className="input mono"
              defaultValue={settings.ollamaUrl}
              onBlur={(e) => void save({ ollamaUrl: e.target.value.trim() })}
            />
          </Row>
          <Row label="Default model" hint="Used for new conversations.">
            <select
              className="select"
              value={settings.defaultModelId ?? ''}
              onChange={(e) => {
                const m = models.find((x) => x.id === e.target.value)
                void save({ defaultModelId: e.target.value || null, defaultProviderId: m?.providerId ?? null })
              }}
            >
              <option value="">(none)</option>
              {models.map((m) => (
                <option key={`${m.providerId}:${m.id}`} value={m.id}>
                  {m.providerName} · {m.name}
                </option>
              ))}
            </select>
            <button className="btn" onClick={() => void refreshModels()}>Refresh models</button>
          </Row>
        </Section>

        <Section title="Permissions & safety" note="Approval prompts respect the current mode.">
          <Row label="Mode" hint="Chat disables all project actions.">
            <select className="select" value={perms.mode} onChange={(e) => setMode(e.target.value as PermissionMode)}>
              {MODES.map((m) => (
                <option key={m.id} value={m.id}>{m.label}</option>
              ))}
            </select>
          </Row>
          <div className="perm-grid">
            {PERMISSION_ROWS.map((r) => (
              <div key={r.key} className="perm-row">
                <div>
                  <div className="text-sm">{r.label}</div>
                  <div className="text-xs" style={{ color: 'var(--faint)' }}>{r.hint}</div>
                </div>
                <select
                  className="select"
                  style={{ width: 110 }}
                  value={perms[r.key]}
                  disabled={perms.mode === 'chat'}
                  onChange={(e) => setPerm(r.key, e.target.value as PermissionLevel)}
                >
                  {LEVELS.map((l) => (
                    <option key={l} value={l}>{l}</option>
                  ))}
                </select>
              </div>
            ))}
          </div>
        </Section>

        <Section title="Voice">
          <Row label="Enable voice input" hint="Dictate prompts using your microphone.">
            <Toggle checked={settings.voice.enabled} onChange={(v) => void save({ voice: { enabled: v } })} />
          </Row>
          <Row label="Transcription provider" hint="A cloud provider with audio support.">
            <select
              className="select"
              value={settings.voice.transcriptionProviderId ?? ''}
              onChange={(e) => void save({ voice: { transcriptionProviderId: e.target.value || null } })}
            >
              <option value="">(none)</option>
              {providers.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </Row>
          <Row label="Transcription model">
            <input
              className="input mono"
              defaultValue={settings.voice.transcriptionModel}
              onBlur={(e) => void save({ voice: { transcriptionModel: e.target.value.trim() } })}
            />
          </Row>
          <Row label="Language" hint="ISO code, e.g. en, fr, de. Blank = auto.">
            <input
              className="input mono"
              defaultValue={settings.voice.language}
              onBlur={(e) => void save({ voice: { language: e.target.value.trim() } })}
            />
          </Row>
          <Row label="Speak replies aloud" hint="Uses the system voice.">
            <Toggle checked={settings.voice.autoSpeak} onChange={(v) => void save({ voice: { autoSpeak: v } })} />
          </Row>
        </Section>

        <Section title="Git & publishing">
          <Row label="After committing" hint="Whether to publish automatically.">
            <select className="select" value={settings.git.publishBehavior} onChange={(e) => void save({ git: { publishBehavior: e.target.value } })}>
              <option value="never">Never push automatically</option>
              <option value="ask">Ask every time</option>
              <option value="auto">Push automatically</option>
            </select>
          </Row>
          <Row label="Require verified remote" hint="Only push to remotes you have confirmed.">
            <Toggle checked={settings.git.requireVerifiedRemote} onChange={(v) => void save({ git: { requireVerifiedRemote: v } })} />
          </Row>
        </Section>

        <Section title="Privacy & logs">
          <Row label="Log level" hint="Diagnostics verbosity. Secrets are always redacted.">
            <select className="select" value={settings.privacy.logLevel} onChange={(e) => void save({ privacy: { logLevel: e.target.value } })}>
              <option value="error">error</option>
              <option value="warn">warn</option>
              <option value="info">info</option>
              <option value="debug">debug</option>
            </select>
          </Row>
          <Row label="Cloud context disclosure" hint="You understand non-local models receive your prompts.">
            <Toggle
              checked={settings.privacy.sendContextDisclosureAccepted}
              onChange={(v) => void save({ privacy: { sendContextDisclosureAccepted: v } })}
            />
          </Row>
        </Section>
        <Section title="Updates" note="Checks the release channel for a newer version.">
          <Row label="Current version">
            <span className="mono text-sm">{update?.currentVersion ?? '—'}</span>
          </Row>
          <Row label="Status">
            <span className="text-sm" style={{ color: 'var(--muted)' }}>{updateHint(update)}</span>
          </Row>
          <Row label="">
            <button
              className="btn"
              onClick={() => void checkForUpdates()}
              disabled={update?.state === 'checking' || update?.state === 'downloading'}
            >
              Check for updates
            </button>
            {update?.state === 'available' && (
              <button className="btn primary" onClick={() => void downloadUpdate()}>
                Download {update.version}
              </button>
            )}
            {update?.state === 'downloaded' && (
              <button className="btn primary" onClick={() => void installUpdate()}>
                Restart &amp; install
              </button>
            )}
          </Row>
        </Section>
      </div>
    </div>
  )
}

function updateHint(update: UpdateStatus | null): string {
  if (!update) return 'Not checked yet.'
  switch (update.state) {
    case 'unsupported':
      return 'Updates are only available in packaged builds.'
    case 'idle':
      return 'Ready to check.'
    case 'checking':
      return 'Checking for updates…'
    case 'available':
      return `Version ${update.version ?? ''} is available.`
    case 'up-to-date':
      return 'You are on the latest version.'
    case 'downloading':
      return `Downloading… ${update.percent ?? 0}%`
    case 'downloaded':
      return `Version ${update.version ?? ''} downloaded. Restart to install.`
    case 'installing':
      return 'Installing update…'
    case 'error':
      return update.message ?? 'Update error.'
    default:
      return 'Ready.'
  }
}

function Section({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <div className="card mb-3">
      <div className="mb-2">
        <h2 className="text-sm font-semibold">{title}</h2>
        {note && <div className="text-xs" style={{ color: 'var(--faint)' }}>{note}</div>}
      </div>
      <div className="flex flex-col gap-3">{children}</div>
    </div>
  )
}

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3">
      <div style={{ minWidth: 200 }}>
        <div className="text-sm">{label}</div>
        {hint && <div className="text-xs" style={{ color: 'var(--faint)' }}>{hint}</div>}
      </div>
      <div className="flex items-center gap-2 flex-1">{children}</div>
    </div>
  )
}

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="switch">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="slider" />
    </label>
  )
}
