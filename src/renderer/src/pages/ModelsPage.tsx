import { RefreshCw } from 'lucide-react'
import { useApp } from '../store/useApp'

export default function ModelsPage() {
  const models = useApp((s) => s.models)
  const providers = useApp((s) => s.providers)
  const statuses = useApp((s) => s.statuses)
  const selectedProviderId = useApp((s) => s.selectedProviderId)
  const selectedModelId = useApp((s) => s.selectedModelId)
  const refreshModels = useApp((s) => s.refreshModels)
  const loading = useApp((s) => s.modelsLoading)
  const selectModel = useApp((s) => s.selectModel)
  const saveSettings = useApp((s) => s.saveSettings)
  const settings = useApp((s) => s.settings)

  const grouped = new Map<string, typeof models>()
  for (const m of models) {
    const arr = grouped.get(m.providerId) ?? []
    arr.push(m)
    grouped.set(m.providerId, arr)
  }

  return (
    <div className="page">
      <div className="page-header">
        <h1 className="page-title">Models</h1>
        <div className="flex-1" />
        <button className="btn" onClick={() => void refreshModels()} disabled={loading}>
          <RefreshCw size={14} className={loading ? 'spin' : ''} /> Refresh
        </button>
      </div>

      <div className="page-scroll">
        {models.length === 0 && (
          <div className="card" style={{ color: 'var(--muted)' }}>
            No models found. Make sure Ollama is running ({settings?.ollamaUrl}) or add a cloud provider.
          </div>
        )}
        {[...grouped.entries()].map(([providerId, list]) => {
          const provider = providers.find((p) => p.id === providerId)
          const status = statuses[providerId]
          return (
            <div key={providerId} className="mb-4">
              <div className="flex items-center gap-2 mb-2">
                <h2 className="text-sm font-semibold">{provider?.name ?? providerId}</h2>
                {provider?.isLocal ? <span className="pill">local</span> : <span className="pill accent">cloud</span>}
                {status && (
                  <span className={`pill ${status.state === 'connected' ? 'ok' : status.state === 'disabled' ? '' : 'err'}`}>
                    {status.state}
                  </span>
                )}
                <span className="text-xs" style={{ color: 'var(--faint)' }}>{list.length} model(s)</span>
              </div>
              <div className="grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))' }}>
                {list.map((m) => {
                  const isSelected = m.providerId === selectedProviderId && m.id === selectedModelId
                  const isDefault = settings?.defaultModelId === m.id
                  return (
                    <div
                      key={m.id}
                      className="card"
                      style={{ borderColor: isSelected ? 'var(--accent)' : 'var(--border)', padding: 12 }}
                    >
                      <div className="flex items-center gap-2">
                        <div className="font-medium text-sm" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={m.name}>
                          {m.name}
                        </div>
                        {isDefault && <span className="pill accent">default</span>}
                      </div>
                      <div className="flex flex-wrap gap-1 mt-2">
                        {m.capabilities.tools && <span className="pill">tools</span>}
                        {m.capabilities.vision && <span className="pill">vision</span>}
                        {m.capabilities.streaming && <span className="pill">streaming</span>}
                        {m.parameterSize && <span className="pill">{m.parameterSize}</span>}
                        {m.contextLength && <span className="pill">{Math.round(m.contextLength / 1024)}k ctx</span>}
                      </div>
                      <div className="flex gap-2 mt-3">
                        <button
                          className={`btn ${isSelected ? 'primary' : ''}`}
                          style={{ flex: 1 }}
                          onClick={() => selectModel(m.providerId, m.id)}
                        >
                          {isSelected ? 'Selected' : 'Use'}
                        </button>
                        <button
                          className="btn"
                          disabled={isDefault}
                          onClick={() => void saveSettings({ defaultProviderId: m.providerId, defaultModelId: m.id })}
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
