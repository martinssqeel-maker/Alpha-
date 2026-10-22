import { useState } from 'react'
import { Download, RefreshCw, X } from 'lucide-react'
import { useApp } from '../store/useApp'

/**
 * Update banner.
 *
 * Settings → Updates has the same controls, but a user who never opens Settings
 * would never learn a new version exists. The main process already checks the
 * GitHub release feed four seconds after launch; this turns that result into
 * something visible and actionable in the workspace.
 *
 * The banner only appears for states where there is something to do:
 *  - `available`   → Download
 *  - `downloading` → progress, no action
 *  - `downloaded`  → Restart & install
 * Everything else (checking, up-to-date, unsupported, error) stays silent: a
 * developer build is permanently `unsupported`, and a transient network error
 * should not nag on every launch.
 */
export default function UpdateBanner() {
  const update = useApp((s) => s.update)
  const downloadUpdate = useApp((s) => s.downloadUpdate)
  const installUpdate = useApp((s) => s.installUpdate)
  const [dismissed, setDismissed] = useState<string | null>(null)

  const state = update?.state
  if (!state || !['available', 'downloading', 'downloaded'].includes(state)) return null

  // Dismissal is keyed by version + state, so dismissing "1.0.7 available" does
  // not hide "1.0.7 downloaded".
  const key = `${update?.version ?? ''}:${state}`
  if (dismissed === key) return null

  const version = update?.version ? ` ${update.version}` : ''

  return (
    <div className="update-banner" role="status" aria-live="polite">
      <RefreshCw size={14} className={state === 'downloading' ? 'spin' : undefined} aria-hidden="true" />
      <span className="update-banner-text">
        {state === 'available' && (
          <>
            <strong>Alpha{version} is available.</strong>{' '}
            <span className="update-banner-hint">
              {update?.releaseName ? `${update.releaseName}. ` : ''}Download it now and restart when you are ready.
            </span>
          </>
        )}
        {state === 'downloading' && (
          <>
            <strong>Downloading Alpha{version}…</strong>{' '}
            <span className="update-banner-hint">{update?.percent ?? 0}%</span>
          </>
        )}
        {state === 'downloaded' && (
          <>
            <strong>Alpha{version} is ready to install.</strong>{' '}
            <span className="update-banner-hint">Restarting installs it; your chats and settings are kept.</span>
          </>
        )}
      </span>

      {state === 'available' && (
        <button type="button" className="btn primary" onClick={() => void downloadUpdate()}>
          <Download size={13} /> Download
        </button>
      )}
      {state === 'downloaded' && (
        <button type="button" className="btn primary" onClick={() => void installUpdate()}>
          Restart &amp; install
        </button>
      )}

      {state !== 'downloading' && (
        <button
          type="button"
          className="btn ghost icon"
          style={{ width: 22, height: 22, padding: 2 }}
          aria-label="Dismiss update notification"
          onClick={() => setDismissed(key)}
        >
          <X size={13} />
        </button>
      )}
    </div>
  )
}
