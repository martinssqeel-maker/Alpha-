import { useEffect, useState } from 'react'
import { Cloud, RefreshCw } from 'lucide-react'
import { useApp } from '../store/useApp'
import { api } from '../lib/api'

interface Props {
  open: boolean
  onClose: () => void
}

export default function AccountModal({ open, onClose }: Props) {
  const platform = useApp((s) => s.platform)
  const refreshPlatform = useApp((s) => s.refreshPlatform)
  const [appVersion, setAppVersion] = useState('')

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

  return (
    <div className='modal-backdrop' onClick={onClose}>
      <div className='card' style={{ width: 460, maxWidth: '94vw' }} onClick={(e) => e.stopPropagation()}>
        <div className='flex items-center gap-2 mb-3'>
          <Cloud size={16} />
          <h3 className='text-base font-semibold flex-1'>Alpha Cloud</h3>
          <span className='text-xs mono' style={{ color: 'var(--faint)' }}>v{appVersion || '?'}</span>
        </div>
        <div className='flex flex-col gap-3 text-sm' style={{ color: 'var(--muted)' }}>
          <p>Authentication has been removed. Platform features run without sign-in.</p>
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
