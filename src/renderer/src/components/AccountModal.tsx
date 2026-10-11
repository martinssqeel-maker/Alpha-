import { useEffect, useState } from 'react'
import { CheckCircle2, Cloud, DollarSign, Info, LogIn, LogOut, RefreshCw, User } from 'lucide-react'
import { useApp } from '../store/useApp'
import { api } from '../lib/api'

interface Props {
  open: boolean
  onClose: () => void
}

export default function AccountModal({ open, onClose }: Props) {
  const platform = useApp((s) => s.platform)
  const refreshPlatform = useApp((s) => s.refreshPlatform)
  const signInToPlatform = useApp((s) => s.signInToPlatform)
  const signOutOfPlatform = useApp((s) => s.signOutOfPlatform)
  const toast = useApp((s) => s.toast)

  const [email, setEmail] = useState('')
  const [busy, setBusy] = useState(false)
  const [appVersion, setAppVersion] = useState('')

  useEffect(() => {
    if (!open) return
    void api.diagnostics().then((d) => setAppVersion(d.appVersion ?? '')).catch(() => undefined)
  }, [open])

  if (!open) return null

  const cfg = platform.config
  const forced = cfg?.desktop.forced
  const blocked = forced ? compareVersions(appVersion, forced) < 0 : false
  const min = cfg?.desktop.minVersion
  const minNotice = min ? compareVersions(appVersion, min) < 0 : false

  const account = (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <div className="avatar" style={{ background: 'var(--accent)', padding: 8 }}>
          <User size={16} />
        </div>
        <div className="flex-1">
          <div className="text-sm font-semibold">{cfg?.account?.fullName || cfg?.account?.email}</div>
          <div className="text-xs" style={{ color: 'var(--muted)' }}>
            {cfg?.account?.email}
          </div>
        </div>
        <button className="btn ghost icon" title="Refresh" onClick={() => void refreshPlatform()}>
          <RefreshCw size={15} />
        </button>
      </div>

      <div className="card p-3">
        <div className="flex items-center gap-2 text-sm">
          <DollarIcon size={15} />
          <span className="flex-1">
            {cfg?.plan ? cfg.plan.name : 'Free plan'}
            {cfg?.plan?.isTrial ? <span className="text-xs ml-2" style={{ color: 'var(--faint)' }}>trial</span> : null}
          </span>
          {cfg?.subscription?.status ? <span className="text-xs" style={{ color: 'var(--muted)' }}>{cfg.subscription.status}</span> : null}
        </div>
        {cfg?.subscription?.endsAt ? (
          <div className="text-xs mt-1" style={{ color: 'var(--muted)' }}>
            Active until {new Date(cfg.subscription.endsAt).toLocaleDateString()}
          </div>
        ) : null}
      </div>

      {cfg && cfg.usage.filter((u) => !u.unlimited).length > 0 && (
        <div>
          <div className="text-xs font-semibold mb-1" style={{ color: 'var(--muted)' }}>
            USAGE THIS PERIOD
          </div>
          {cfg.usage
            .filter((u) => !u.unlimited)
            .map((u) => {
              const pct = u.limit && u.limit > 0 ? Math.min(100, (u.used / u.limit) * 100) : 0
              return (
                <div key={u.resource} className="mb-1">
                  <div className="flex justify-between text-xs mb-0.5">
                    <span style={{ color: 'var(--muted)' }}>{labelFor(u.resource)}</span>
                    <span>
                      {u.used}{u.limit ? ` / ${u.limit}` : ''}
                    </span>
                  </div>
                  <div className="usage-bar">
                    <div className="usage-fill" style={{ width: `${pct}%`, background: pct >= 90 ? 'var(--danger)' : 'var(--accent)' }} />
                  </div>
                </div>
              )
            })}
          {cfg.usage.filter((u) => u.unlimited).map((u) => (
            <div key={u.resource} className="flex justify-between text-xs">
              <span style={{ color: 'var(--muted)' }}>{labelFor(u.resource)}</span>
              <span>{u.used}</span>
            </div>
          ))}
        </div>
      )}

      {cfg && cfg.models.filter((m) => !m.allowed).length > 0 && (
        <div className="text-xs" style={{ color: 'var(--muted)' }}>
          {cfg.models.filter((m) => !m.allowed).length} model{cfg.models.filter((m) => !m.allowed).length === 1 ? '' : 's'} in the catalog are not included in your plan.
        </div>
      )}

      {cfg && cfg.announcements.length > 0 && (
        <div>
          {cfg.announcements.map((a) => (
            <div key={a.id} className="card p-3 text-sm mb-1" style={{ borderColor: a.level === 'critical' ? 'var(--danger)' : undefined }}>
              <div className="font-semibold">{a.title}</div>
              <div className="text-xs" style={{ color: 'var(--muted)' }}>{a.body}</div>
            </div>
          ))}
        </div>
      )}

      <div className="flex justify-end gap-2">
        <button className="btn" onClick={() => void signOutOfPlatform()}>
          <LogOut size={14} /> Sign out
        </button>
      </div>
    </div>
  )

  const signIn = (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2 text-sm" style={{ color: 'var(--muted)' }}>
        <Cloud size={15} /> Connect with the same account you use on the website.
      </div>
      {platform.pendingSignIn ? (
        <div className="card p-3 text-sm" style={{ borderColor: 'var(--accent)' }}>
          <CheckCircle2 size={15} /> A sign-in link was sent. Check your email, then return to Alpha automatically.
        </div>
      ) : (
        <>
          <label className="field">
            <span>Email</span>
            <input
              className="input"
              type="email"
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
            <span className="hint">We send a secure one-time sign-in link to this address.</span>
          </label>
          <div className="flex justify-end gap-2">
            <button
              className="btn primary"
              disabled={busy || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)}
              onClick={async () => {
                setBusy(true)
                try {
                  const res = await signInToPlatform(email)
                  if (!res.ok) toast(res.message ?? 'Could not send the sign-in link.', 'error')
                } finally {
                  setBusy(false)
                }
              }}
            >
              <LogIn size={14} /> Send sign-in link
            </button>
          </div>
        </>
      )}
    </div>
  )

  const notConfigured = (
    <div className="flex flex-col gap-2 text-sm">
      {!platform.enabled ? (
        <p>Alpha Cloud is disabled. Enable the platform and set the API base URL in Settings → Platform.</p>
      ) : (
        <p>Alpha Cloud is not configured. Add the API base URL in Settings → Platform.</p>
      )}
    </div>
  )

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="card" style={{ width: 460, maxWidth: '94vw' }} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 mb-3">
          <Cloud size={16} />
          <h3 className="text-base font-semibold flex-1">Alpha Cloud</h3>
          <span className="text-xs mono" style={{ color: 'var(--faint)' }}>v{appVersion || '?'}</span>
        </div>

        {cfg?.maintenance.active ? (
          <div className="card p-2 text-sm mb-3" style={{ borderColor: 'var(--warning, #b45309)' }}>
            Maintenance: {cfg.maintenance.message ?? 'Scheduled maintenance in progress.'}
          </div>
        ) : null}
        {blocked || minNotice ? (
          <div className="card p-2 text-sm mb-3" style={{ borderColor: 'var(--danger)' }}>
            {blocked ? (
              <>This version is no longer supported. Update Alpha AI Workspace to keep using cloud models.</>
            ) : (
              <>A newer version is recommended ({min}). Update Alpha AI Workspace.</>
            )}
          </div>
        ) : null}

        <div className="flex flex-col gap-3">
          {platform.error ? (
            <div className="text-sm mb-2" style={{ color: 'var(--danger)' }}>
              <Info size={13} /> {platform.error}
            </div>
          ) : null}
          {!platform.enabled || !platform.configured
            ? notConfigured
            : platform.authenticated
              ? account
              : signIn}
        </div>
      </div>
    </div>
  )
}

function DollarIcon({ size = 16 }: { size?: number }) {
  return <DollarSign size={size} />
}

function labelFor(resource: string): string {
  const map: Record<string, string> = {
    tokens: 'Tokens used',
    messages: 'Messages',
    requests: 'Requests',
    storage: 'Storage',
    audio_minutes: 'Audio minutes'
  }
  return map[resource] ?? resource
}

function compareVersions(a: string, b: string): number {
  const pa = (a || '0').split('.').map((n) => parseInt(n, 10) || 0)
  const pb = (b || '0').split('.').map((n) => parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const da = pa[i] ?? 0
    const db = pb[i] ?? 0
    if (da !== db) return da < db ? -1 : 1
  }
  return 0
}