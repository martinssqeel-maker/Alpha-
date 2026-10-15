import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, Check, Cpu, Download, HardDrive, RefreshCw, Search, Trash2, X } from 'lucide-react'
import type { HardwareInfo, ModelInfo, OllamaCatalogEntry, OllamaFit, OllamaPullProgress } from '@shared/types'
import { api } from '../lib/api'
import { useApp } from '../store/useApp'

const OLLAMA_DOWNLOAD_URL = 'https://ollama.com/download'

function formatBytes(bytes?: number): string {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes <= 0) return ''
  const gb = bytes / 1024 ** 3
  if (gb >= 1) return `${gb.toFixed(gb >= 10 ? 0 : 1)} GB`
  return `${Math.round(bytes / 1024 ** 2)} MB`
}

const FIT_LABEL: Record<OllamaFit, string> = {
  comfortable: 'Fits this machine',
  tight: 'Tight fit',
  'too-large': 'Needs more memory'
}

const FIT_CLASS: Record<OllamaFit, string> = {
  comfortable: 'pill ok',
  tight: 'pill',
  'too-large': 'pill err'
}

function PullProgressRow({
  progress,
  onCancel
}: {
  progress: OllamaPullProgress
  onCancel: () => void
}): React.JSX.Element {
  const percent = progress.percent
  const done = progress.state !== 'pulling'
  return (
    <div className="mt-2">
      <div className="flex items-center gap-2 text-xs" style={{ color: 'var(--text-tertiary)' }}>
        <span className="progress-track" style={{ flex: 1 }}>
          <span
            className="progress-fill"
            style={{ width: `${percent ?? 4}%` }}
            role="progressbar"
            aria-valuenow={percent ?? 0}
            aria-valuemin={0}
            aria-valuemax={100}
          />
        </span>
        <span className="mono" style={{ minWidth: 42, textAlign: 'right' }}>
          {percent !== undefined ? `${percent}%` : '…'}
        </span>
        {!done && (
          <button className="btn" onClick={onCancel} title="Cancel this download">
            <X size={12} /> Cancel
          </button>
        )}
      </div>
      <div className="text-xs mt-1" style={{ color: progress.state === 'error' ? 'var(--danger)' : 'var(--text-tertiary)' }}>
        {progress.message ??
          [
            progress.status,
            progress.total ? `${formatBytes(progress.completed)} of ${formatBytes(progress.total)}` : ''
          ]
            .filter(Boolean)
            .join(' · ')}
      </div>
    </div>
  )
}

function CatalogCard({
  entry,
  fit,
  reason,
  installed,
  progress,
  onInstall,
  onCancel,
  onSelect,
  onRemove
}: {
  entry: OllamaCatalogEntry
  fit?: OllamaFit
  reason?: string
  installed: boolean
  progress?: OllamaPullProgress
  onInstall: () => void
  onCancel: () => void
  onSelect: () => void
  onRemove: () => void
}): React.JSX.Element {
  const pulling = progress?.state === 'pulling'
  return (
    <div className="card" style={{ padding: 12 }}>
      <div className="flex items-center gap-2">
        <div className="font-medium text-sm" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={entry.name}>
          {entry.title}
        </div>
        {installed && <span className="pill ok">installed</span>}
      </div>
      <div className="mono text-xs" style={{ color: 'var(--text-tertiary)' }}>{entry.name}</div>
      <p className="text-xs mt-1" style={{ color: 'var(--text-secondary)', minHeight: 32 }}>{entry.description}</p>
      <div className="flex flex-wrap gap-1 mt-2">
        <span className="pill">{entry.params}</span>
        <span className="pill" title="Approximate download size — the exact figure comes from Ollama when the download starts">
          ~{formatBytes(entry.approxBytes)}
        </span>
        <span className="pill" title="Guidance, not a benchmark">needs ~{entry.minRamGb} GB RAM</span>
        {fit && <span className={FIT_CLASS[fit]} title={reason}>{FIT_LABEL[fit]}</span>}
        {entry.categories.map((category) => (
          <span key={category} className="pill">{category}</span>
        ))}
      </div>

      {progress && <PullProgressRow progress={progress} onCancel={onCancel} />}

      <div className="flex gap-2 mt-3">
        {installed ? (
          <>
            <button className="btn primary" style={{ flex: 1 }} onClick={onSelect}>
              <Check size={14} /> Use this model
            </button>
            <button className="btn danger" onClick={onRemove} title="Remove this model from disk">
              <Trash2 size={14} />
            </button>
          </>
        ) : (
          <button className="btn" style={{ flex: 1 }} onClick={onInstall} disabled={pulling}>
            <Download size={14} /> {pulling ? 'Downloading…' : 'Install'}
          </button>
        )}
      </div>
    </div>
  )
}

export default function ModelsPage(): React.JSX.Element {
  const models = useApp((s) => s.models)
  const providers = useApp((s) => s.providers)
  const statuses = useApp((s) => s.statuses)
  const selectedProviderId = useApp((s) => s.selectedProviderId)
  const selectedModelId = useApp((s) => s.selectedModelId)
  const ollama = useApp((s) => s.ollama)
  const catalog = useApp((s) => s.ollamaCatalog)
  const hardware = useApp((s) => s.hardware)
  const recommendations = useApp((s) => s.recommendations)
  const pulls = useApp((s) => s.pulls)
  const refreshOllama = useApp((s) => s.refreshOllama)
  const pullModel = useApp((s) => s.pullModel)
  const cancelPull = useApp((s) => s.cancelPull)
  const removeLocalModel = useApp((s) => s.removeLocalModel)
  const selectModel = useApp((s) => s.selectModel)
  const saveSettings = useApp((s) => s.saveSettings)
  const toast = useApp((s) => s.toast)
  const settings = useApp((s) => s.settings)

  const [query, setQuery] = useState('')
  const [custom, setCustom] = useState('')
  const [loading, setLoading] = useState(false)

  // The page is a manager, so it refreshes detection on open rather than relying
  // on whatever the last screen left in the store.
  useEffect(() => {
    void refreshOllama()
  }, [refreshOllama])

  const installedIds = useMemo(
    () => new Set((ollama?.models ?? []).map((m) => m.id)),
    [ollama]
  )
  const fitByModel = useMemo(() => {
    const map = new Map<string, { fit: OllamaFit; reason: string }>()
    for (const rec of recommendations) map.set(rec.model.name, { fit: rec.fit, reason: rec.reason })
    return map
  }, [recommendations])

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return catalog
    return catalog.filter((entry) =>
      [entry.name, entry.title, entry.description, ...entry.categories]
        .join(' ')
        .toLowerCase()
        .includes(needle)
    )
  }, [catalog, query])

  // Anything the machine can actually run, best fit first — that is the useful
  // shortlist, and it is derived from the real memory figures rather than a guess.
  const shortlist = useMemo(
    () => recommendations.filter((rec) => rec.fit !== 'too-large').slice(0, 6),
    [recommendations]
  )

  const refresh = async (): Promise<void> => {
    setLoading(true)
    try {
      await refreshOllama()
    } finally {
      setLoading(false)
    }
  }

  const installCustom = async (): Promise<void> => {
    const name = custom.trim()
    if (!name) return
    setCustom('')
    await pullModel(name)
  }

  const removeModel = async (model: string): Promise<void> => {
    if (!window.confirm(`Remove ${model} from this machine? The downloaded files are deleted and re-downloading takes as long as a fresh install.`)) {
      return
    }
    await removeLocalModel(model)
  }

  const useModel = (providerId: string, modelId: string): void => {
    selectModel(providerId, modelId)
    toast(`${modelId} selected`, 'success')
  }

  const ollamaProviderId = providers.find((p) => p.kind === 'ollama')?.id
  const localProviders = providers.filter((p) => p.kind === 'ollama')
  const cloudGroups = (() => {
    const grouped = new Map<string, ModelInfo[]>()
    for (const model of models) {
      if (localProviders.some((p) => p.id === model.providerId)) continue
      const list = grouped.get(model.providerId) ?? []
      list.push(model)
      grouped.set(model.providerId, list)
    }
    return grouped
  })()

  const hw: HardwareInfo | null = hardware

  return (
    <div className="page">
      <div className="page-header">
        <h1 className="page-title">Models</h1>
        <div className="flex-1" />
        <button className="btn" onClick={() => void refresh()} disabled={loading}>
          <RefreshCw size={14} className={loading ? 'spin' : ''} /> Refresh
        </button>
      </div>

      <div className="page-scroll">
        {/* --- Ollama state ------------------------------------------------- */}
        <div className="card mb-4">
          <div className="flex items-center gap-2 flex-wrap">
            <HardDrive size={16} />
            <div className="font-medium text-sm">Local models (Ollama)</div>
            {ollama ? (
              <span className={`pill ${ollama.reachable ? 'ok' : 'err'}`}>
                {ollama.reachable ? `running${ollama.version ? ` · v${ollama.version}` : ''}` : ollama.installed ? 'not running' : 'not installed'}
              </span>
            ) : (
              <span className="pill">checking…</span>
            )}
            {ollama && <span className="text-xs mono" style={{ color: 'var(--text-tertiary)' }}>{ollama.baseUrl}</span>}
          </div>

          {ollama && !ollama.reachable && (
            <div className="flex items-start gap-2 mt-3 text-xs" style={{ color: 'var(--text-secondary)' }}>
              <AlertTriangle size={14} style={{ color: 'var(--warning, var(--danger))', flexShrink: 0, marginTop: 2 }} />
              <div>
                <div>{ollama.message}</div>
                {!ollama.installed && (
                  <div className="mt-2">
                    <button
                      className="btn primary"
                      onClick={() => void api.openExternal(ollama.installUrl || OLLAMA_DOWNLOAD_URL)}
                    >
                      <Download size={14} /> Get Ollama for Windows
                    </button>
                    <div className="mt-1" style={{ color: 'var(--text-tertiary)' }}>
                      Opens ollama.com in your browser. Alpha never runs an installer for you.
                    </div>
                  </div>
                )}
                {ollama.installed && (
                  <div className="mt-1" style={{ color: 'var(--text-tertiary)' }}>
                    Start the Ollama service (the desktop app or <code>ollama serve</code>), then Refresh.
                  </div>
                )}
              </div>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2 mt-3 text-xs" style={{ color: 'var(--text-tertiary)' }}>
            <Cpu size={13} />
            {hw ? (
              <>
                <span>{hw.cpuCount} CPU cores · {hw.cpuModel}</span>
                <span>· {hw.totalRamGb} GB RAM ({hw.freeRamGb} GB free)</span>
                <span>· {hw.gpu && hw.gpu.vramGb ? `${hw.gpu.name} (${hw.gpu.vramGb} GB VRAM)` : 'no discrete GPU detected'}</span>
              </>
            ) : (
              <span>Reading this machine's memory and CPU…</span>
            )}
          </div>
          <div className="text-xs mt-1" style={{ color: 'var(--text-disabled)' }}>
            Recommendations below compare a model's size with this memory. They are guidance, not a
            benchmark, and nothing is selected or changed automatically.
          </div>
        </div>

        {/* --- Installed ---------------------------------------------------- */}
        <div className="mb-4">
          <h2 className="text-sm font-semibold mb-2">
            Installed locally {(ollama?.models?.length ?? 0) > 0 && `(${ollama?.models.length})`}
          </h2>
          {(ollama?.models?.length ?? 0) === 0 && (
            <div className="card text-xs" style={{ color: 'var(--text-tertiary)' }}>
              No Ollama models are installed yet. Install one from the list below — the download is
              real, streams its progress here, and can be cancelled.
            </div>
          )}
          <div className="grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))' }}>
            {(ollama?.models ?? []).map((model) => {
              const isSelected = model.providerId === selectedProviderId && model.id === selectedModelId
              const isDefault = settings?.defaultModelId === model.id
              const entry = catalog.find((c) => c.name === model.id)
              return (
                <div
                  key={model.id}
                  className="card"
                  style={{ borderColor: isSelected ? 'var(--accent)' : 'var(--border)', padding: 12 }}
                >
                  <div className="flex items-center gap-2">
                    <div className="font-medium text-sm" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={model.name}>
                      {model.name}
                    </div>
                    {isDefault && <span className="pill accent">default</span>}
                  </div>
                  <div className="mono text-xs" style={{ color: 'var(--text-tertiary)' }}>
                    {entry ? entry.title : 'local model'}
                  </div>
                  <div className="flex flex-wrap gap-1 mt-2">
                    {model.parameterSize && <span className="pill">{model.parameterSize}</span>}
                    {model.quantization && <span className="pill">{model.quantization}</span>}
                    {model.capabilities.tools && <span className="pill">tools</span>}
                    {model.capabilities.vision && <span className="pill">vision</span>}
                    {model.contextLength && <span className="pill">{Math.round(model.contextLength / 1024)}k ctx</span>}
                  </div>
                  <div className="flex gap-2 mt-3">
                    <button
                      className={`btn ${isSelected ? 'primary' : ''}`}
                      style={{ flex: 1 }}
                      onClick={() => {
                        if (!model.providerId) return
                        useModel(model.providerId, model.id)
                      }}
                      disabled={!model.providerId}
                    >
                      {isSelected ? 'Selected' : 'Use'}
                    </button>
                    <button
                      className="btn"
                      disabled={isDefault || !model.providerId}
                      onClick={() =>
                        void saveSettings({ defaultProviderId: model.providerId, defaultModelId: model.id })
                      }
                      title="Set as the default model"
                    >
                      Default
                    </button>
                    <button
                      className="btn danger"
                      title="Remove this model from disk"
                      onClick={() => void removeModel(model.id)}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
        </div>

        {/* --- Shortlist ---------------------------------------------------- */}
        {shortlist.length > 0 && (
          <div className="mb-4">
            <h2 className="text-sm font-semibold mb-2">Recommended for this machine</h2>
            <div className="grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))' }}>
              {shortlist.map((rec) => (
                <CatalogCard
                  key={rec.model.name}
                  entry={rec.model}
                  fit={rec.fit}
                  reason={rec.reason}
                  installed={installedIds.has(rec.model.name)}
                  progress={pulls[rec.model.name]}
                  onInstall={() => void pullModel(rec.model.name)}
                  onCancel={() => void cancelPull(rec.model.name)}
                  onSelect={() => ollamaProviderId && useModel(ollamaProviderId, rec.model.name)}
                  onRemove={() => void removeModel(rec.model.name)}
                />
              ))}
            </div>
          </div>
        )}

        {/* --- Catalog ------------------------------------------------------ */}
        <div className="mb-4">
          <div className="flex items-center gap-2 mb-2">
            <h2 className="text-sm font-semibold">Install a model</h2>
            <div className="flex-1" />
            <div className="flex items-center gap-1" style={{ maxWidth: 240 }}>
              <Search size={13} />
              <input
                className="input text-xs"
                placeholder="Search the catalog…"
                aria-label="Search model catalog"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
          </div>

          <div className="card mb-3">
            <div className="text-xs mb-2" style={{ color: 'var(--text-secondary)' }}>
              Any model from the Ollama library by name — useful for a specific tag or size.
            </div>
            <div className="flex gap-2">
              <input
                className="input mono text-xs"
                placeholder="e.g. llama3.2:latest or qwen2.5-coder:7b"
                aria-label="Model name to install"
                value={custom}
                onChange={(e) => setCustom(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void installCustom()
                }}
              />
              <button className="btn" onClick={() => void installCustom()} disabled={!custom.trim()}>
                <Download size={14} /> Install
              </button>
            </div>
            {custom.trim() && pulls[custom.trim()] && (
              <PullProgressRow progress={pulls[custom.trim()]} onCancel={() => void cancelPull(custom.trim())} />
            )}
          </div>

          <div className="grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))' }}>
            {filtered.map((entry) => (
              <CatalogCard
                key={entry.name}
                entry={entry}
                fit={fitByModel.get(entry.name)?.fit}
                reason={fitByModel.get(entry.name)?.reason}
                installed={installedIds.has(entry.name)}
                progress={pulls[entry.name]}
                onInstall={() => void pullModel(entry.name)}
                onCancel={() => void cancelPull(entry.name)}
                onSelect={() => ollamaProviderId && useModel(ollamaProviderId, entry.name)}
                onRemove={() => void removeModel(entry.name)}
              />
            ))}
            {filtered.length === 0 && (
              <div className="card text-xs" style={{ color: 'var(--text-tertiary)' }}>
                Nothing in the catalog matches “{query}”. Install it by name above instead.
              </div>
            )}
          </div>
          <div className="text-xs mt-2" style={{ color: 'var(--text-disabled)' }}>
            Sizes are approximate default (Q4) downloads; the real total is reported during the
            download. Removing a model deletes its files from disk.
          </div>
        </div>

        {/* --- Cloud / other providers -------------------------------------- */}
        {[...cloudGroups.entries()].map(([providerId, list]) => {
          const provider = providers.find((p) => p.id === providerId)
          const status = statuses[providerId]
          return (
            <div key={providerId} className="mb-4">
              <div className="flex items-center gap-2 mb-2">
                <h2 className="text-sm font-semibold">{provider?.name ?? providerId}</h2>
                <span className="pill accent">cloud</span>
                {status && (
                  <span className={`pill ${status.state === 'connected' ? 'ok' : status.state === 'disabled' ? '' : 'err'}`}>
                    {status.state}
                  </span>
                )}
                <span className="text-xs" style={{ color: 'var(--text-tertiary)' }}>{list.length} model(s)</span>
              </div>
              <div className="grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))' }}>
                {list.map((model) => {
                  const isSelected = model.providerId === selectedProviderId && model.id === selectedModelId
                  const isDefault = settings?.defaultModelId === model.id
                  return (
                    <div
                      key={`${model.providerId}:${model.id}`}
                      className="card"
                      style={{ borderColor: isSelected ? 'var(--accent)' : 'var(--border)', padding: 12 }}
                    >
                      <div className="flex items-center gap-2">
                        <div className="font-medium text-sm" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={model.name}>
                          {model.name}
                        </div>
                        {isDefault && <span className="pill accent">default</span>}
                      </div>
                      <div className="flex flex-wrap gap-1 mt-2">
                        {model.capabilities.tools && <span className="pill">tools</span>}
                        {model.capabilities.vision && <span className="pill">vision</span>}
                        {model.capabilities.streaming && <span className="pill">streaming</span>}
                        {model.parameterSize && <span className="pill">{model.parameterSize}</span>}
                        {model.contextLength && <span className="pill">{Math.round(model.contextLength / 1024)}k ctx</span>}
                      </div>
                      <div className="flex gap-2 mt-3">
                        <button
                          className={`btn ${isSelected ? 'primary' : ''}`}
                          style={{ flex: 1 }}
                          onClick={() => useModel(model.providerId, model.id)}
                        >
                          {isSelected ? 'Selected' : 'Use'}
                        </button>
                        <button
                          className="btn"
                          disabled={isDefault}
                          onClick={() => void saveSettings({ defaultProviderId: model.providerId, defaultModelId: model.id })}
                          title="Set as default model"
                        >
                          Default
                        </button>
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
