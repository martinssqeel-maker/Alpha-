import { AlertCircle, CheckCircle2, CircleHelp, Cpu, FolderGit2, LoaderCircle, Shield } from 'lucide-react'
import { useApp } from '../store/useApp'
import alphaLogo from '../assets/alpha-logo.png'
import TitleBarSearch from './TitleBarSearch'
import TitleBarTheme from './TitleBarTheme'

export default function TitleBar() {
  const activeProject = useApp((s) =>
    s.projects.find((p) => p.id === s.activeProjectId)
  )
  const model = useApp((s) => {
    const m = s.models.find((x) => x.providerId === s.selectedProviderId && x.id === s.selectedModelId)
    return m ? `${m.name}` : null
  })
  const mode = useApp((s) => s.settings?.permissions.mode ?? 'assist')
  const providerId = useApp((s) => s.selectedProviderId)
  const provider = useApp((s) => s.providers.find((item) => item.id === providerId))
  const providerStatus = useApp((s) => providerId ? s.statuses[providerId] : undefined)
  const providerState = providerStatus?.state ?? 'unknown'
  const ProviderIcon = providerState === 'connected'
    ? CheckCircle2
    : providerState === 'checking'
      ? LoaderCircle
      : providerState === 'unknown'
        ? CircleHelp
        : AlertCircle
  const providerLabel = providerState === 'unreachable' ? 'Offline' : providerState === 'unknown' ? 'Unknown' : providerState[0].toUpperCase() + providerState.slice(1)

  return (
    <div className="titlebar">
      <div className="flex items-center gap-2 font-semibold no-drag">
        <img src={alphaLogo} alt="" width={22} height={22} draggable={false} />
        <span className="titlebar-brand-label">Alpha AI Workspace</span>
      </div>
      <TitleBarSearch />
      <div className="flex-1" />
      <div className="titlebar-context flex items-center gap-3 text-xs no-drag" style={{ color: 'var(--text-tertiary)', paddingRight: 'var(--titlebar-control-space)' }}>
        {activeProject && (
          <span className="titlebar-context-item" title={`Project: ${activeProject.name}`}>
            <FolderGit2 size={13} /> <span className="titlebar-project-label">{activeProject.name}</span>
          </span>
        )}
        {model && (
          <span className="titlebar-context-item" title={`Model: ${model}${provider ? ` · ${provider.name}` : ''}`}>
            <Cpu size={13} /> <span className="titlebar-model-label">{model}</span>
          </span>
        )}
        {provider && (
          <span className={`titlebar-provider-state ${providerState}`} title={`Last provider check for ${provider.name}: ${providerLabel}`} aria-label={`${provider.name}: ${providerLabel}`}>
            <ProviderIcon size={13} aria-hidden="true" /> <span>{providerLabel}</span>
          </span>
        )}
        <span className="titlebar-mode" title={`Agent permission mode: ${mode}`}>
          <Shield size={13} /> <span>{mode === 'assist' ? 'Assist' : 'Auto'}</span>
        </span>
        <TitleBarTheme />
      </div>
    </div>
  )
}
