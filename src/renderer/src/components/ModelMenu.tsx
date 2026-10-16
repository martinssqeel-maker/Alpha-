import { useState } from 'react'
import { ChevronDown, Cloud, Cpu, RefreshCw } from 'lucide-react'
import { useApp } from '../store/useApp'

export default function ModelMenu() {
  const [open, setOpen] = useState(false)
  const models = useApp((s) => s.models)
  const providers = useApp((s) => s.providers)
  const statuses = useApp((s) => s.statuses)
  const selectedProviderId = useApp((s) => s.selectedProviderId)
  const selectedModelId = useApp((s) => s.selectedModelId)
  const selectModel = useApp((s) => s.selectModel)
  const refresh = useApp((s) => s.refreshModels)
  const loading = useApp((s) => s.modelsLoading)

  const current = models.find((m) => m.providerId === selectedProviderId && m.id === selectedModelId)

  const grouped = new Map<string, typeof models>()
  for (const m of models) {
    const arr = grouped.get(m.providerId) ?? []
    arr.push(m)
    grouped.set(m.providerId, arr)
  }

  return (
    <div style={{ position: 'relative' }}>
      <button className="btn ghost" onClick={() => setOpen((o) => !o)} title="Select model">
        {current?.local ? <Cpu size={14} /> : <Cloud size={14} />}
        <span className="text-xs" style={{ maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {current ? current.name : 'Select model'}
        </span>
        <ChevronDown size={13} />
      </button>
      {open && (
        <>
          <div style={{ position: 'fixed', inset: 0, zIndex: 40 }} onClick={() => setOpen(false)} />
          <div
            className="card tight model-menu"
            style={{
              position: 'absolute',
              bottom: 42,
              left: 0,
              width: 340,
              maxHeight: 380,
              overflowY: 'auto',
              zIndex: 50,
              boxShadow: 'var(--shadow)'
            }}
          >
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-semibold" style={{ color: 'var(--muted)' }}>
                MODELS ({models.length})
              </span>
              <button className="btn ghost icon" style={{ width: 24, height: 24 }} title="Refresh" onClick={() => refresh()}>
                <RefreshCw size={13} className={loading ? 'spin' : ''} />
              </button>
            </div>
            {models.length === 0 && (
              <div className="text-xs" style={{ color: 'var(--faint)' }}>
                No models found. Check Ollama or add a provider.
              </div>
            )}
            {[...grouped.entries()].map(([providerId, list]) => {
              const provider = providers.find((p) => p.id === providerId)
              const status = statuses[providerId]
              return (
                <div key={providerId} className="mb-2">
                  <div className="flex items-center gap-2 text-xs mb-1" style={{ color: 'var(--muted)' }}>
                    <span className="font-semibold">{provider?.name ?? providerId}</span>
                    {provider?.isLocal ? (
                      <span className="pill" style={{ fontSize: 10, padding: '0 6px' }}>
                        local
                      </span>
                    ) : (
                      <span className="pill accent" style={{ fontSize: 10, padding: '0 6px' }}>
                        cloud
                      </span>
                    )}
                    {status && (
                      <span
                        className={`pill ${status.state === 'connected' ? 'ok' : status.state === 'disabled' ? '' : 'err'}`}
                        style={{ fontSize: 10, padding: '0 6px' }}
                      >
                        {status.state}
                      </span>
                    )}
                  </div>
                  {list.map((m) => (
                    <button
                      key={m.id}
                      className={`nav-item ${m.providerId === selectedProviderId && m.id === selectedModelId ? 'active' : ''}`}
                      style={{ padding: '5px 8px' }}
                      onClick={() => {
                        selectModel(m.providerId, m.id)
                        setOpen(false)
                      }}
                    >
                      <span className="label text-xs">{m.name}</span>
                      <div className="flex-1" />
                      {m.capabilities.tools && (
                        <span className="pill" style={{ fontSize: 9, padding: '0 5px' }} title="Tool calling">
                          tools
                        </span>
                      )}
                      {m.capabilities.vision && (
                        <span className="pill" style={{ fontSize: 9, padding: '0 5px' }} title="Vision">
                          vision
                        </span>
                      )}
                    </button>
                  ))}
                </div>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}
