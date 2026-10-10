import { useState } from 'react'
import { Check, Plus, RefreshCw, Trash2, Wifi } from 'lucide-react'
import type { ProviderConfig, ProviderKind } from '@shared/types'
import { api } from '../lib/api'
import { useApp } from '../store/useApp'

interface Preset {
  id: string
  name: string
  kind: ProviderKind
  baseUrl: string
  needsKey: boolean
  local: boolean
  note: string
}

const PRESETS: Preset[] = [
  { id: 'ollama', name: 'Ollama (local)', kind: 'ollama', baseUrl: 'http://127.0.0.1:11434', needsKey: false, local: true, note: 'Your existing local Ollama installation.' },
  { id: 'openai', name: 'OpenAI', kind: 'openai-compatible', baseUrl: 'https://api.openai.com/v1', needsKey: true, local: false, note: 'Cloud. Sends prompts to OpenAI.' },
  { id: 'openrouter', name: 'OpenRouter', kind: 'openai-compatible', baseUrl: 'https://openrouter.ai/api/v1', needsKey: true, local: false, note: 'Cloud gateway to many models.' },
  { id: 'groq', name: 'Groq', kind: 'openai-compatible', baseUrl: 'https://api.groq.com/openai/v1', needsKey: true, local: false, note: 'Cloud. Fast hosted inference.' },
  { id: 'deepseek', name: 'DeepSeek', kind: 'openai-compatible', baseUrl: 'https://api.deepseek.com/v1', needsKey: true, local: false, note: 'Cloud OpenAI-compatible API.' },
  { id: 'together', name: 'Together AI', kind: 'openai-compatible', baseUrl: 'https://api.together.xyz/v1', needsKey: true, local: false, note: 'Cloud OpenAI-compatible API.' },
  { id: 'lmstudio', name: 'LM Studio (local)', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:1234/v1', needsKey: false, local: true, note: 'Local server exposing an OpenAI-compatible API.' },
  { id: 'custom', name: 'Custom OpenAI-compatible', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:8000/v1', needsKey: false, local: true, note: 'Any endpoint implementing /chat/completions and /models.' }
]

export default function ProvidersPage() {
  const providers = useApp((s) => s.providers)
  const statuses = useApp((s) => s.statuses)
  const refreshProviders = useApp((s) => s.refreshProviders)
  const refreshModels = useApp((s) => s.refreshModels)
  const toast = useApp((s) => s.toast)
  const [editing, setEditing] = useState<ProviderConfig | 'new' | null>(null)
  const [busy, setBusy] = useState(false)

  const reload = async (): Promise<void> => {
    await refreshProviders()
    await refreshModels()
  }

  const remove = async (id: string): Promise<void> => {
    if (!window.confirm('Remove this provider? Its saved API key will be deleted.')) return
    setBusy(true)
    try {
      await api.providers.remove(id)
      await reload()
      toast('Provider removed', 'success')
    } catch (e) {
      toast((e as Error).message, 'error')
    } finally {
      setBusy(false)
    }
  }

  const toggle = async (p: ProviderConfig): Promise<void> => {
    await api.providers.save({
      id: p.id,
      kind: p.kind,
      name: p.name,
      baseUrl: p.baseUrl,
      enabled: !p.enabled,
      isLocal: p.isLocal,
      preset: p.preset
    })
    await reload()
  }

  const test = async (p: ProviderConfig): Promise<void> => {
    setBusy(true)
    try {
      const status = await api.providers.test({ id: p.id, kind: p.kind, baseUrl: p.baseUrl })
      toast(`${p.name}: ${status.state}${status.message ? ` — ${status.message}` : ''}`, status.state === 'connected' ? 'success' : 'error')
    } catch (e) {
      toast((e as Error).message, 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="page">
      <div className="page-header">
        <h1 className="page-title">AI Providers</h1>
        <div className="flex-1" />
        <button className="btn" onClick={() => void reload()} disabled={busy}>
          <RefreshCw size={14} /> Refresh
        </button>
        <button className="btn primary" onClick={() => setEditing('new')}>
          <Plus size={14} /> Add provider
        </button>
      </div>

      <div className="page-scroll">
        {providers.map((p) => {
          const status = statuses[p.id]
          const state = status?.state ?? (p.enabled ? 'unknown' : 'disabled')
          return (
            <div key={p.id} className="card mb-3">
              <div className="flex items-center gap-2">
                <div className="font-medium">{p.name}</div>
                {p.isLocal ? <span className="pill">local</span> : <span className="pill accent">cloud</span>}
                <span className={`pill ${state === 'connected' ? 'ok' : state === 'disabled' ? '' : 'err'}`}>{state}</span>
                {p.hasApiKey && <span className="pill">key saved</span>}
                <div className="flex-1" />
                <label className="flex items-center gap-1 text-xs" style={{ color: 'var(--muted)' }}>
                  <input type="checkbox" checked={p.enabled} onChange={() => void toggle(p)} /> enabled
                </label>
              </div>
              <div className="mono text-xs mt-1" style={{ color: 'var(--faint)' }}>{p.baseUrl}</div>
              {status?.message && (
                <div className="text-xs mt-1" style={{ color: state === 'connected' ? 'var(--success)' : 'var(--danger)' }}>
                  {status.message}
                </div>
              )}
              <div className="flex items-center gap-2 mt-3">
                <button className="btn" onClick={() => void test(p)} disabled={busy}>
                  <Wifi size={14} /> Test
                </button>
                <button className="btn" onClick={() => setEditing(p)}>Edit</button>
                <div className="flex-1" />
                <button className="btn danger" onClick={() => void remove(p.id)} disabled={busy}>
                  <Trash2 size={14} /> Remove
                </button>
              </div>
            </div>
          )
        })}
        {providers.length === 0 && <div className="card" style={{ color: 'var(--muted)' }}>No providers configured.</div>}
      </div>

      {editing && (
        <ProviderForm
          preset={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null)
            await reload()
            toast('Provider saved', 'success')
          }}
        />
      )}
    </div>
  )
}

function ProviderForm({
  preset,
  onClose,
  onSaved
}: {
  preset: ProviderConfig | null
  onClose: () => void
  onSaved: () => void
}) {
  const toast = useApp((s) => s.toast)
  const existing = preset && 'id' in preset ? (preset as ProviderConfig) : null
  const [chosenPreset, setChosenPreset] = useState<string>(existing?.preset ?? 'openai')
  const def = PRESETS.find((p) => p.id === chosenPreset) ?? PRESETS[0]
  const [name, setName] = useState(existing?.name ?? def.name)
  const [baseUrl, setBaseUrl] = useState(existing?.baseUrl ?? def.baseUrl)
  const [kind, setKind] = useState<ProviderKind>(existing?.kind ?? def.kind)
  const [isLocal, setIsLocal] = useState(existing?.isLocal ?? def.local)
  const [apiKey, setApiKey] = useState('')
  const [saving, setSaving] = useState(false)

  const applyPreset = (id: string): void => {
    const p = PRESETS.find((x) => x.id === id)
    if (!p) return
    setChosenPreset(id)
    setName(p.name)
    setBaseUrl(p.baseUrl)
    setKind(p.kind)
    setIsLocal(p.local)
  }

  const save = async (): Promise<void> => {
    setSaving(true)
    try {
      await api.providers.save({
        id: existing?.id,
        kind,
        name,
        baseUrl,
        enabled: true,
        isLocal,
        preset: chosenPreset,
        apiKey: apiKey || undefined
      })
      onSaved()
    } catch (e) {
      toast((e as Error).message, 'error')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="modal-backdrop">
      <div className="card" style={{ width: 520, maxWidth: '92vw' }}>
        <h3 className="text-base font-semibold mb-3">{existing ? 'Edit provider' : 'Add provider'}</h3>

        {!existing && (
          <label className="field">
            <span>Preset</span>
            <select className="select" value={chosenPreset} onChange={(e) => applyPreset(e.target.value)}>
              {PRESETS.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
            <span className="hint">{def.note}</span>
          </label>
        )}

        <label className="field">
          <span>Name</span>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
        </label>

        <label className="field">
          <span>Type</span>
          <select className="select" value={kind} onChange={(e) => setKind(e.target.value as ProviderKind)}>
            <option value="ollama">Ollama</option>
            <option value="openai-compatible">OpenAI-compatible</option>
          </select>
        </label>

        <label className="field">
          <span>Base URL</span>
          <input className="input mono" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
        </label>

        <label className="field">
          <span>API key {existing?.hasApiKey ? '(leave blank to keep current)' : ''}</span>
          <input
            className="input mono"
            type="password"
            placeholder={def.needsKey ? 'required for this provider' : 'optional'}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
          />
          <span className="hint">Stored with OS-level encryption where available; never included in logs.</span>
        </label>

        <label className="flex items-center gap-2 text-sm mt-1">
          <input type="checkbox" checked={isLocal} onChange={(e) => setIsLocal(e.target.checked)} />
          This is a local provider (no data leaves this machine)
        </label>

        <div className="flex justify-end gap-2 mt-4">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" onClick={() => void save()} disabled={saving || !name || !baseUrl}>
            <Check size={14} /> Save
          </button>
        </div>
      </div>
    </div>
  )
}
