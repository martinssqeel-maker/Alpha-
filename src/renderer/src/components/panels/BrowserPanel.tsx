import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { ArrowLeft, ArrowRight, ExternalLink, LoaderCircle, RotateCw } from 'lucide-react'
import type { BrowserPreviewState } from '@shared/types'
import { normalizePreviewUrl } from '@shared/browserUrl'
import { api, onBrowser } from '../../lib/api'

const INITIAL_STATE: BrowserPreviewState = {
  url: '',
  loading: false,
  canGoBack: false,
  canGoForward: false,
  error: null
}

export default function BrowserPanel({ blocked = false }: { blocked?: boolean }) {
  const viewport = useRef<HTMLDivElement>(null)
  const [address, setAddress] = useState('')
  const [state, setState] = useState(INITIAL_STATE)
  const [addressError, setAddressError] = useState<string | null>(null)

  const updateNativeBounds = useCallback((): void => {
    const element = viewport.current
    if (!element) return
    const rect = element.getBoundingClientRect()
    const obscured = blocked || Boolean(document.querySelector('[role="alertdialog"]'))
    void api.browser.setLayout(!obscured, {
      x: rect.left,
      y: rect.top,
      width: rect.width,
      height: rect.height
    })
  }, [blocked])

  useEffect(() => {
    let active = true
    const element = viewport.current
    const observer = element ? new ResizeObserver(updateNativeBounds) : null
    if (element) observer?.observe(element)
    const mutations = new MutationObserver(updateNativeBounds)
    mutations.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style'] })
    window.addEventListener('resize', updateNativeBounds)
    const unsubscribe = onBrowser((next) => {
      if (!active) return
      setState(next)
      setAddress(next.url)
      if (!next.error) setAddressError(null)
    })
    void api.browser.getState().then((next) => {
      if (!active) return
      const restored = next as BrowserPreviewState
      setState(restored)
      setAddress(restored.url)
    })
    updateNativeBounds()
    return () => {
      active = false
      observer?.disconnect()
      mutations.disconnect()
      window.removeEventListener('resize', updateNativeBounds)
      unsubscribe()
      void api.browser.setLayout(false, { x: 0, y: 0, width: 0, height: 0 })
    }
  }, [updateNativeBounds])

  const navigate = (event: FormEvent): void => {
    event.preventDefault()
    try {
      const normalized = normalizePreviewUrl(address)
      setAddress(normalized)
      setAddressError(null)
      void api.browser.navigate(normalized).then((next) => setState(next as BrowserPreviewState)).catch((error) => {
        setAddressError((error as Error).message)
      })
    } catch (error) {
      setAddressError((error as Error).message)
    }
  }

  const openExternally = (): void => {
    void api.browser.openExternal().then((result) => {
      if (!result.ok) setAddressError(result.message ?? 'Could not open the page externally.')
    })
  }

  return (
    <div className="browser-panel flex flex-col h-full">
      <form className="browser-toolbar flex items-center gap-1 p-2" onSubmit={navigate}>
        <button className="btn ghost icon" type="button" title="Back" aria-label="Back" disabled={!state.canGoBack} onClick={() => void api.browser.back()}>
          <ArrowLeft size={14} />
        </button>
        <button className="btn ghost icon" type="button" title="Forward" aria-label="Forward" disabled={!state.canGoForward} onClick={() => void api.browser.forward()}>
          <ArrowRight size={14} />
        </button>
        <button className="btn ghost icon" type="button" title="Reload" aria-label="Reload" disabled={!state.url} onClick={() => void api.browser.reload()}>
          <RotateCw size={14} />
        </button>
        <input
          className="input text-xs flex-1"
          aria-label="Preview address"
          placeholder="http://localhost:3000 or https://example.com"
          value={address}
          onChange={(event) => setAddress(event.target.value)}
          title={state.url || 'Enter an HTTP or HTTPS preview address'}
        />
        <button className="btn ghost icon" type="button" title="Open in external browser" aria-label="Open in external browser" disabled={!state.url} onClick={openExternally}>
          <ExternalLink size={14} />
        </button>
        <button className="btn primary icon" type="submit" title="Open preview" aria-label="Open preview" disabled={!address.trim()}>
          <ArrowRight size={14} />
        </button>
      </form>
      <div className="browser-current-url text-xs px-3 py-1" title={state.url}>
        {state.loading ? <><LoaderCircle size={12} className="spin" /> Loading preview…</> : state.url || 'No page open'}
      </div>
      <div className="browser-viewport flex-1" ref={viewport}>
        {(state.error || addressError) && (
          <div className="browser-message" role="status">
            <h3 className="text-sm font-semibold mb-2">Preview unavailable</h3>
            <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>{addressError ?? state.error}</p>
            <p className="text-xs mt-2" style={{ color: 'var(--text-tertiary)' }}>Check the address and confirm that any local development server is running.</p>
          </div>
        )}
        {!state.url && !state.loading && !state.error && !addressError && (
          <div className="browser-message text-center">
            <h3 className="text-sm font-semibold mb-2">Preview a project</h3>
            <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>Enter a local or hosted HTTP(S) address. This opens in an isolated browser session.</p>
          </div>
        )}
        {blocked && <div className="browser-message text-center"><p className="text-xs" style={{ color: 'var(--text-secondary)' }}>Preview paused while an approval dialog is open.</p></div>}
      </div>
    </div>
  )
}
