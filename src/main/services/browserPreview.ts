import { shell, session, WebContentsView, type BrowserWindow, type Rectangle } from 'electron'
import type { BrowserPreviewState } from '@shared/types'
import { normalizePreviewUrl } from '@shared/browserUrl'

const PREVIEW_PARTITION = 'alpha-browser-preview'
const INITIAL_STATE: BrowserPreviewState = {
  url: '',
  loading: false,
  canGoBack: false,
  canGoForward: false,
  error: null
}

export class BrowserPreviewService {
  private host: BrowserWindow | null = null
  private view: WebContentsView | null = null
  private bounds: Rectangle = { x: 0, y: 0, width: 0, height: 0 }
  private visible = false
  private state: BrowserPreviewState = { ...INITIAL_STATE }
  private readonly previewSession = session.fromPartition(PREVIEW_PARTITION)

  constructor(private readonly emit: (state: BrowserPreviewState) => void) {
    this.previewSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
    this.previewSession.setPermissionCheckHandler(() => false)
    this.previewSession.on('will-download', (event) => event.preventDefault())
  }

  attach(host: BrowserWindow): void {
    if (this.host === host) return
    this.disposeView()
    this.host = host
    this.applyBounds()
  }

  getState(): BrowserPreviewState {
    return { ...this.state }
  }

  setLayout(visible: boolean, bounds: Rectangle): void {
    this.visible = visible
    this.bounds = {
      x: Math.round(bounds.x),
      y: Math.round(bounds.y),
      width: Math.max(0, Math.round(bounds.width)),
      height: Math.max(0, Math.round(bounds.height))
    }
    this.applyBounds()
  }

  async navigate(input: string): Promise<BrowserPreviewState> {
    let url: string
    try {
      url = normalizePreviewUrl(input)
    } catch (error) {
      this.setState({ ...this.state, loading: false, error: (error as Error).message })
      return this.getState()
    }
    const view = this.ensureView()
    this.setState({ ...INITIAL_STATE, url, loading: true })
    this.applyBounds()
    try {
      await view.webContents.loadURL(url)
    } catch (error) {
      const message = (error as Error).message
      this.setLoadError(url, friendlyLoadError(-1, message))
    }
    return this.getState()
  }

  back(): void {
    if (this.view?.webContents.canGoBack()) this.view.webContents.goBack()
  }

  forward(): void {
    if (this.view?.webContents.canGoForward()) this.view.webContents.goForward()
  }

  reload(): void {
    this.view?.webContents.reload()
  }

  async openExternally(): Promise<{ ok: boolean; message?: string }> {
    try {
      const url = normalizePreviewUrl(this.state.url)
      await shell.openExternal(url)
      return { ok: true }
    } catch (error) {
      return { ok: false, message: (error as Error).message }
    }
  }

  dispose(): void {
    this.disposeView()
    this.host = null
    this.visible = false
  }

  private ensureView(): WebContentsView {
    if (this.view && !this.view.webContents.isDestroyed()) return this.view
    const host = this.host
    if (!host || host.isDestroyed()) throw new Error('The application window is unavailable.')
    const view = new WebContentsView({
      webPreferences: {
        partition: PREVIEW_PARTITION,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true
      }
    })
    const contents = view.webContents
    host.contentView.addChildView(view)
    view.setVisible(false)
    contents.setWindowOpenHandler(() => ({ action: 'deny' }))
    contents.on('will-navigate', (event, url) => {
      if (!isHttpUrl(url)) event.preventDefault()
    })
    contents.on('will-redirect', (event, url) => {
      if (!isHttpUrl(url)) event.preventDefault()
    })
    contents.on('did-start-loading', () => {
      this.setState({ ...this.state, url: contents.getURL() || this.state.url, loading: true, error: null })
      this.applyBounds()
    })
    contents.on('did-navigate', (_event, url) => this.updateUrl(url))
    contents.on('did-navigate-in-page', (_event, url) => this.updateUrl(url))
    contents.on('did-stop-loading', () => {
      this.setState({ ...this.state, url: contents.getURL() || this.state.url, loading: false })
      this.syncHistory()
      this.applyBounds()
    })
    contents.on('did-fail-load', (_event, errorCode, description, validatedURL, isMainFrame) => {
      if (!isMainFrame || errorCode === -3) return
      this.setLoadError(validatedURL, friendlyLoadError(errorCode, description))
    })
    contents.on('render-process-gone', () => {
      this.setState({ ...this.state, loading: false, error: 'The preview page stopped unexpectedly. Reload to try again.' })
      this.applyBounds()
    })
    contents.on('destroyed', () => {
      if (this.view === view) {
        this.view = null
        this.setState({ ...INITIAL_STATE })
      }
    })
    this.view = view
    this.applyBounds()
    return view
  }

  private updateUrl(url: string): void {
    if (!isHttpUrl(url)) return
    this.setState({ ...this.state, url })
    this.syncHistory()
  }

  private setLoadError(url: string, error: string): void {
    this.setState({ ...this.state, url, loading: false, error })
    this.applyBounds()
  }

  private syncHistory(): void {
    const contents = this.view?.webContents
    if (!contents || contents.isDestroyed()) return
    this.setState({
      ...this.state,
      canGoBack: contents.canGoBack(),
      canGoForward: contents.canGoForward()
    })
  }

  private setState(state: BrowserPreviewState): void {
    this.state = state
    this.emit(this.getState())
  }

  private applyBounds(): void {
    const host = this.host
    const view = this.view
    if (!host || host.isDestroyed() || !view || view.webContents.isDestroyed()) return
    const content = host.getContentBounds()
    const x = Math.max(0, Math.min(this.bounds.x, content.width))
    const y = Math.max(0, Math.min(this.bounds.y, content.height))
    const width = Math.max(0, Math.min(this.bounds.width, content.width - x))
    const height = Math.max(0, Math.min(this.bounds.height, content.height - y))
    view.setBounds({ x, y, width, height })
    view.setVisible(this.visible && !this.state.loading && !this.state.error && width > 1 && height > 1)
  }

  private disposeView(): void {
    const view = this.view
    if (!view) return
    this.view = null
    try {
      if (this.host && !this.host.isDestroyed()) this.host.contentView.removeChildView(view)
      if (!view.webContents.isDestroyed()) view.webContents.close()
    } catch {
      // The owning BrowserWindow may already have disposed the guest view.
    }
    this.setState({ ...INITIAL_STATE })
  }
}

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value)
}

function friendlyLoadError(code: number, description: string): string {
  if (description.includes('ERR_CONNECTION_REFUSED')) return 'The server refused the connection. Check that the development server is running and that the port is correct.'
  if (description.includes('ERR_NAME_NOT_RESOLVED')) return 'The address could not be found. Check the URL and your network connection.'
  if (description.includes('ERR_INVALID_URL')) return 'The address is invalid. Enter an HTTP or HTTPS URL.'
  return `The page could not be loaded (error ${code}). Check the address or try again.`
}
