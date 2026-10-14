import { useEffect, useState } from 'react'
import { Chrome, Cloud, Github, RefreshCw } from 'lucide-react'
import { useApp } from '../store/useApp'
import { api } from '../lib/api'

interface Props {
  open: boolean
  onClose: () => void
}

type Provider = 'google' | 'github'

export default function AccountModal({ open, onClose }: Props) {
  const platform = useApp((s) => s.platform)
  const refreshPlatform = useApp((s) => s.refreshPlatform)
  const signInToPlatformWith = useApp((s) => s.signInToPlatformWith)
  const signOutOfPlatform = useApp((s) => s.signOutOfPlatform)
  const [appVersion, setAppVersion] = useState('')
  const [pending, setPending] = useState<Provider | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    void api.diagnostics().then((d) => setAppVersion(d.appVersion ?? '')).catch(() => undefined)
  }, [open])

  // Escape closes the dialog, matching the shortcut listed in Settings.
  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  // `platform.providers` is undefined until the deployment has been asked, and
  // explicitly false only when it says that provider is not configured.
  const showGoogle = platform.providers?.google !== false
  const showGithub = platform.providers?.github !== false

  const start = async (provider: Provider): Promise<void> => {
    setPending(provider)
    setNotice(null)
    try {
      const result = await signInToPlatformWith(provider)
      setNotice(result.ok ? (result.message ?? null) : (result.message ?? 'Could not start that sign-in.'))
    } finally {
      setPending(null)
    }
  }

  return (
    <div className='modal-backdrop' onClick={onClose}>
      <div className='card' style={{ width: 460, maxWidth: '94vw' }} onClick={(e) => e.stopPropagation()}>
        <div className='flex items-center gap-2 mb-3'>
          <Cloud size={16} />
          <h3 className='text-base font-semibold flex-1'>Alpha Account</h3>
          <span className='text-xs mono' style={{ color: 'var(--faint)' }}>v{appVersion || '?'}</span>
        </div>
        <div className='flex flex-col gap-3 text-sm' style={{ color: 'var(--muted)' }}>
          {platform.authenticated ? (
            <>
              <p>
                Signed in{platform.email ? ` as ${platform.email}` : ''}. The same account works on the
                Alpha website and in this app.
              </p>
              <div className='flex justify-end'>
                <button className='btn' onClick={() => void signOutOfPlatform()}>
                  Sign out
                </button>
              </div>
            </>
          ) : (
            <>
              <p>
                One Alpha account works across the website and this desktop app. New here? Your
                first sign-in creates the account — there is no separate sign-up form.
              </p>
              {/* Offer only the methods this deployment advertises. Before the
                  first answer every button stays visible, so an unreachable API
                  never hides a sign-in method that actually works. */}
              {showGoogle || showGithub ? (
                <div className='flex flex-col gap-2'>
                  {showGoogle && (
                    <button
                      className='btn primary'
                      disabled={pending !== null}
                      onClick={() => void start('google')}
                    >
                      <Chrome size={14} /> Continue with Google
                    </button>
                  )}
                  {showGithub && (
                    <button
                      className='btn primary'
                      disabled={pending !== null}
                      onClick={() => void start('github')}
                    >
                      <Github size={14} /> Continue with GitHub
                    </button>
                  )}
                </div>
              ) : (
                <p>
                  This Alpha deployment has no sign-in provider enabled yet. Turn one on with
                  Settings → Platform → Refresh, then try again.
                </p>
              )}
              {showGithub && (
                <p className='text-xs' style={{ color: 'var(--faint)' }}>
                  Your browser opens to finish signing in, then returns here automatically. Signing in with
                  GitHub does not grant access to your repositories — use GitHub → Connect GitHub for that.
                </p>
              )}
            </>
          )}
          {notice && <p className='text-xs' style={{ color: 'var(--faint)' }}>{notice}</p>}
          <div className='flex justify-end'>
            <button className='btn ghost icon' title='Refresh' onClick={() => void refreshPlatform()}>
              <RefreshCw size={15} />
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
