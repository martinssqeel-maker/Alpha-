import { useEffect, useRef, useState } from 'react'
import { Archive, RotateCcw, Trash2 } from 'lucide-react'
import type { PermissionLevel, PermissionMode, PermissionSettings, UpdateStatus } from '@shared/types'
import { permissionsForMode } from '@shared/permissions'
import type { Conversation } from '@shared/types'
import { THEME_OPTIONS } from '@shared/theme'
import { api } from '../lib/api'
import { relativeTime } from '../lib/relativeTime'
import { useApp } from '../store/useApp'
import ThemeGallery from '../components/ThemeGallery'
import ShortcutList from '../components/ShortcutList'

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

const SETTINGS_SECTIONS = [
  { id: 'settings-appearance', label: 'Appearance' },
  { id: 'settings-models', label: 'Models & providers' },
  { id: 'settings-permissions', label: 'Permissions & safety' },
  { id: 'settings-skills', label: 'Agent skills' },
  { id: 'settings-project', label: 'Project settings' },
  { id: 'settings-voice', label: 'Voice' },
  { id: 'settings-git', label: 'Git & publishing' },
  { id: 'settings-privacy', label: 'Privacy & logs' },
  { id: 'settings-shortcuts', label: 'Keyboard shortcuts' },
  { id: 'settings-browser', label: 'Browser preview' },
  { id: 'settings-external-browser', label: 'External browsers' },
  { id: 'settings-mcp', label: 'MCP' },
  { id: 'settings-platform', label: 'Alpha Cloud' },
  { id: 'settings-updates', label: 'Updates' },
  { id: 'settings-archived', label: 'Archived conversations' }
]

export default function SettingsPage() {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [activeSection, setActiveSection] = useState(SETTINGS_SECTIONS[0].id)
  const settings = useApp((s) => s.settings)
  const activeProject = useApp((s) => s.projects.find((project) => project.id === s.activeProjectId) ?? null)
  const providers = useApp((s) => s.providers)
  const save = useApp((s) => s.saveSettings)
  const models = useApp((s) => s.models)
  const refreshModels = useApp((s) => s.refreshModels)
  const update = useApp((s) => s.update)
  const checkForUpdates = useApp((s) => s.checkForUpdates)
  const downloadUpdate = useApp((s) => s.downloadUpdate)
  const installUpdate = useApp((s) => s.installUpdate)

  useEffect(() => {
    const root = scrollRef.current
    if (!root) return
    const targets = SETTINGS_SECTIONS.map(({ id }) => document.getElementById(id)).filter((node): node is HTMLElement => Boolean(node))
    const observer = new IntersectionObserver((entries) => {
      const visible = entries
        .filter((entry) => entry.isIntersecting)
        .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0]
      if (visible) setActiveSection(visible.target.id)
    }, { root, rootMargin: '-8px 0px -72% 0px', threshold: 0 })
    for (const target of targets) observer.observe(target)
    return () => observer.disconnect()
  }, [])

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

      <div className="page-scroll settings-scroll" ref={scrollRef}>
        <div className="settings-layout">
          <nav className="settings-nav" aria-label="Settings sections">
            {SETTINGS_SECTIONS.map((section) => (
              <button
                key={section.id}
                className={`nav-item ${activeSection === section.id ? 'active' : ''}`}
                aria-current={activeSection === section.id ? 'page' : undefined}
                onClick={() => {
                  setActiveSection(section.id)
                  document.getElementById(section.id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
                }}
              >{section.label}</button>
            ))}
          </nav>
          <div className="settings-sections">
        <Section id="settings-appearance" title="Appearance" note="Pick a preset. Every card previews the real palette and applies immediately across the workspace.">
          <ThemeGallery
            value={settings.theme}
            onChange={(theme) => void save({ theme })}
            appearance={settings.appearance}
            onAppearanceChange={(patch) => void save({ appearance: patch })}
          />
          <div className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
            {THEME_OPTIONS.filter((theme) => theme.id !== 'system').length} curated palettes · preferences are saved to this device.
          </div>
        </Section>

        <Section id="settings-skills" title="Agent skills" note="Skills add focused guidance to the assistant's instructions.">
          <Row label="Manage skills" hint="Enabled skills apply to new requests and can be changed any time.">
            <button className="btn" onClick={() => useApp.getState().setView('skills')}>Browse agent skills</button>
          </Row>
        </Section>

        <Section id="settings-project" title="Project settings" note="Project-scoped instructions and overrides are not available yet.">
          <div className="text-sm" style={{ color: 'var(--text-tertiary)' }}>
            {activeProject
              ? <>Current project: <span className="mono">{activeProject.rootPath}</span>. Alpha does not currently save separate project instructions or model overrides.</>
              : 'Open or select a project to see its scope. Alpha does not currently save separate project instructions or model overrides.'}
          </div>
        </Section>

        <Section id="settings-models" title="Local models">
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
          <Row label="AI provider accounts" hint="Configure and test cloud providers in their dedicated page.">
            <button className="btn" onClick={() => useApp.getState().setView('providers')}>Manage AI providers</button>
          </Row>
        </Section>

        <Section id="settings-permissions" title="Permissions & safety" note="Approval prompts respect the current mode.">
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

        <Section id="settings-voice" title="Voice">
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

        <Section id="settings-git" title="Git & publishing">
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

        <Section id="settings-privacy" title="Privacy & logs">
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
        <Section id="settings-shortcuts" title="Keyboard shortcuts" note="These are the shortcuts Alpha actually handles in the running app. Nothing is listed that is not wired up.">
          <ShortcutList />
          <div className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
            Key labels follow your operating system. Alpha does not register system-wide global hotkeys, so shortcuts only apply while the window is focused.
          </div>
        </Section>
        <Section id="settings-browser" title="Browser preview" note="The Browser panel is available in the workspace inspector.">
          <Row label="Local preview" hint="Enter a local dev-server URL in the Browser panel. The preview has an isolated session.">
            <button className="btn" onClick={() => {
              const state = useApp.getState()
              state.setInspectorOpen(true)
              state.setInspectorTab('browser')
              state.setView('chat')
            }}>Open browser preview</button>
          </Row>
          <div className="text-xs" style={{ color: 'var(--text-tertiary)' }}>Alpha does not discover or start project dev servers automatically.</div>
        </Section>
        <Section id="settings-external-browser" title="External browsers" note="External browser profile integration is not available.">
          <div className="text-sm" style={{ color: 'var(--text-tertiary)' }}>Alpha does not inspect or import Chrome, Edge, or other browser profiles. Use the Browser panel’s Open externally action when you want to continue in your default browser.</div>
        </Section>
        <Section id="settings-mcp" title="MCP" note="Model Context Protocol servers are not supported yet.">
          <div className="text-sm" style={{ color: 'var(--text-tertiary)' }}>Alpha does not connect to MCP servers or store MCP configurations.</div>
        </Section>
        <Section id="settings-platform" title="Alpha Cloud (platform)" note="Connects the app to the Alpha backend — accounts, plans and cloud models via the AI gateway.">
          <Row label="Enabled" hint="Turn the platform connection on/off.">
            <Toggle
              checked={settings.platform.enabled}
              onChange={(v) => {
                void save({ platform: { enabled: v } }).then(() => useApp.getState().refreshPlatform())
              }}
            />
          </Row>
          <Row label="API base URL" hint="Alpha Cloud API endpoint (Neon Function URL).">
            <input
              className="input mono"
              defaultValue={settings.platform.apiBaseUrl}
              onBlur={(e) =>
                void save({ platform: { apiBaseUrl: e.target.value.trim() } }).then(() =>
                  useApp.getState().refreshPlatform()
                )
              }
            />
          </Row>
        </Section>

        <Section id="settings-updates" title="Updates" note="Checks the release channel for a newer version.">
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
        <ArchivedConversations />
          </div>
        </div>
      </div>
    </div>
  )
}

function ArchivedConversations() {
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const load = async (): Promise<void> => {
    setLoading(true)
    try {
      setConversations(await api.conversations.archived())
      setError('')
    } catch (cause) {
      setError((cause as Error).message || 'Could not load archived conversations.')
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { void load() }, [])

  return (
    <Section id="settings-archived" title="Archived conversations" note="Archived conversations stay in your local history until you delete them.">
      {loading ? <div className="text-sm" style={{ color: 'var(--text-tertiary)' }}>Loading archive…</div> : error ? (
        <div className="flex items-center gap-3 text-sm" style={{ color: 'var(--danger)' }}><span>{error}</span><button className="btn" onClick={() => void load()}>Retry</button></div>
      ) : conversations.length === 0 ? <div className="text-sm" style={{ color: 'var(--text-tertiary)' }}>No archived conversations.</div> : (
        <div className="flex flex-col">
          {conversations.map((conversation) => <div key={conversation.id} className="flex items-center gap-3 py-2" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
            <Archive size={14} style={{ color: 'var(--text-tertiary)', flexShrink: 0 }} />
            <div className="min-w-0 flex-1"><div className="text-sm truncate">{conversation.title}</div><div className="text-xs" style={{ color: 'var(--text-tertiary)' }}>{relativeTime(conversation.archivedAt ?? conversation.updatedAt)}</div></div>
            <button className="btn" onClick={async () => {
              try {
                await useApp.getState().unarchiveConversation(conversation.id)
                await load()
              } catch (cause) { setError((cause as Error).message) }
            }}><RotateCcw size={13} /> Unarchive</button>
            <button className="btn danger" onClick={async () => {
              if (!window.confirm(`Delete “${conversation.title}” and its conversation history?`)) return
              try {
                await api.conversations.remove(conversation.id)
                await load()
              } catch (cause) { setError((cause as Error).message) }
            }}><Trash2 size={13} /> Delete</button>
          </div>)}
        </div>
      )}
    </Section>
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

function Section({ id, title, note, children }: { id?: string; title: string; note?: string; children: React.ReactNode }) {
  return (
    <div id={id} className="card mb-3 settings-section">
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
