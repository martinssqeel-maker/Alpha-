import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { shell, session, WebContentsView, type BrowserWindow, type Rectangle } from 'electron'
import type { BrowserPageSnapshot, BrowserPreviewState } from '@shared/types'
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

  // -------------------------------------------------------------------------
  // Agent-facing surface
  // -------------------------------------------------------------------------
  //
  // The preview exists for a human: it only renders when the inspector panel is
  // open and sized. The agent needs it to behave like a headless page it can
  // read and drive, so these methods ensure a live view exists and bring it
  // on-screen for captures rather than depending on the panel being open.

  /** Create the view if it does not exist yet, so tools work with the panel shut. */
  ensureReady(): void {
    this.ensureView()
  }

  /** Wait until the page stops loading (or the timeout elapses). */
  async waitForLoad(timeoutMs = 15_000): Promise<boolean> {
    const contents = this.view?.webContents
    if (!contents || contents.isDestroyed()) return false
    if (!contents.isLoading()) return true
    return new Promise<boolean>((resolve) => {
      let settled = false
      const finish = (ok: boolean): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        contents.removeListener('did-stop-loading', onStop)
        contents.removeListener('did-fail-load', onStop)
        resolve(ok)
      }
      const onStop = (): void => finish(true)
      const timer = setTimeout(() => finish(!contents.isLoading()), timeoutMs)
      contents.once('did-stop-loading', onStop)
      contents.once('did-fail-load', onStop)
    })
  }

  /**
   * Read the page the way a person would: title, URL, visible text, and a
   * numbered list of interactive elements.
   *
   * Elements get a `data-alpha-id` attribute so the next `browser_interact` call
   * can address `[3]` without the model inventing a CSS selector. The attribute
   * is scoped to this document and disappears on navigation.
   */
  async readPage(): Promise<BrowserPageSnapshot> {
    const contents = this.view?.webContents
    if (!contents || contents.isDestroyed()) {
      return {
        ok: false,
        url: this.state.url,
        title: '',
        text: '',
        elements: [],
        truncated: false,
        message: 'The browser panel has not been opened yet. Navigate first.'
      }
    }
    try {
      const snapshot = (await contents.executeJavaScript(READ_PAGE_SCRIPT, true)) as BrowserPageSnapshot
      return {
        ...snapshot,
        url: snapshot.url || contents.getURL() || this.state.url,
        elements: (snapshot.elements ?? []).map((element, index) => ({
          ...element,
          id: index + 1
        }))
      }
    } catch (error) {
      return {
        ok: false,
        url: contents.getURL() || this.state.url,
        title: '',
        text: '',
        elements: [],
        truncated: false,
        message: (error as Error).message
      }
    }
  }

  /** Click, type into, or press a key on a numbered element (or a CSS selector). */
  async interact(
    elementIdOrSelector: string | number,
    action: 'click' | 'type' | 'press',
    value?: string
  ): Promise<{ ok: boolean; message?: string; element?: string }> {
    const contents = this.view?.webContents
    if (!contents || contents.isDestroyed()) {
      return { ok: false, message: 'The browser panel has not been opened yet.' }
    }
    try {
      const result = (await contents.executeJavaScript(
        buildInteractScript(elementIdOrSelector, action, value ?? ''),
        true
      )) as { ok: boolean; message?: string; element?: string }
      return result
    } catch (error) {
      return { ok: false, message: (error as Error).message }
    }
  }

  /** PNG of the current viewport. Forces the view visible so it actually paints. */
  async screenshot(): Promise<{ ok: boolean; path?: string; width?: number; height?: number; message?: string }> {
    const view = this.view
    const contents = view?.webContents
    if (!view || !contents || contents.isDestroyed()) {
      return { ok: false, message: 'The browser panel has not been opened yet. Navigate first.' }
    }
    const restore = { visible: this.visible, bounds: { ...this.bounds } }
    try {
      const width = Math.max(this.bounds.width, 1024)
      const height = Math.max(this.bounds.height, 768)
      view.setBounds({ x: 0, y: 0, width, height })
      view.setVisible(true)
      await sleep(220)
      const image = await contents.capturePage()
      if (image.isEmpty()) return { ok: false, message: 'The page produced an empty capture.' }
      const directory = path.join(os.tmpdir(), 'alpha-browser-shots')
      fs.mkdirSync(directory, { recursive: true })
      const filePath = path.join(directory, `browser-${Date.now()}.png`)
      fs.writeFileSync(filePath, image.toPNG())
      const size = image.getSize()
      return { ok: true, path: filePath, width: size.width, height: size.height }
    } catch (error) {
      return { ok: false, message: (error as Error).message }
    } finally {
      this.bounds = restore.bounds
      this.visible = restore.visible
      this.applyBounds()
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Runs inside the preview page.
 *
 * Numbering is assigned here rather than in the main process because only the
 * page knows what is actually visible; an `display:none` button must not consume
 * an element id, or the model would address something it cannot see.
 */
const READ_PAGE_SCRIPT = `(() => {
  const MAX_ELEMENTS = 120;
  const MAX_TEXT = 6000;
  const SELECTOR = 'a,button,input,textarea,select,summary,[role="button"],[role="link"],[role="textbox"],[role="checkbox"],[contenteditable="true"]';
  const labelOf = (el) => {
    const text = (el.innerText || el.textContent || '').trim().replace(/\\s+/g, ' ');
    if (text) return text.slice(0, 90);
    return (el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('placeholder') || '').slice(0, 90);
  };
  const visible = [];
  for (const el of Array.from(document.querySelectorAll(SELECTOR))) {
    const rect = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);
    if (rect.width < 2 || rect.height < 2) continue;
    if (style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0') continue;
    if (el.closest('[aria-hidden="true"]')) continue;
    visible.push(el);
    if (visible.length >= MAX_ELEMENTS) break;
  }
  const elements = visible.map((el, index) => {
    const id = index + 1;
    el.setAttribute('data-alpha-id', String(id));
    const tag = el.tagName.toLowerCase();
    return {
      id,
      tag,
      type: el.getAttribute('type') || undefined,
      name: el.getAttribute('name') || el.id || undefined,
      text: labelOf(el),
      selector: '[data-alpha-id="' + id + '"]',
      visible: true
    };
  });
  const bodyText = (document.body ? document.body.innerText : '') || '';
  return {
    ok: true,
    url: location.href,
    title: document.title || '',
    text: bodyText.replace(/\\n{3,}/g, '\\n\\n').slice(0, MAX_TEXT),
    elements,
    truncated: bodyText.length > MAX_TEXT || elements.length >= MAX_ELEMENTS
  };
})()`

/**
 * Build the interaction script.
 *
 * Values are JSON-encoded so a string containing quotes or `</script>` cannot
 * break out of the injected code — the page receives data, never syntax.
 */
function buildInteractScript(
  target: string | number,
  action: 'click' | 'type' | 'press',
  value: string
): string {
  const selector =
    typeof target === 'number'
      ? `[data-alpha-id="${target}"]`
      : /^[[.#]/.test(target) || /[ >]/.test(target)
        ? target
        : `[data-alpha-id="${target.replace(/"/g, '')}"]`
  return `(() => {
    const selector = ${JSON.stringify(selector)};
    const action = ${JSON.stringify(action)};
    const value = ${JSON.stringify(value)};
    let el;
    try { el = document.querySelector(selector); } catch (e) { return { ok: false, message: 'Invalid selector: ' + e.message }; }
    if (!el) return { ok: false, message: 'No element matched ' + selector + '. Read the page again; the ids are reassigned on every read.' };
    const describe = el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + ' "' + ((el.innerText || el.getAttribute('aria-label') || '').trim().slice(0, 60)) + '"';
    el.scrollIntoView({ block: 'center', inline: 'center' });

    if (action === 'click') {
      el.focus({ preventScroll: true });
      if (typeof el.click === 'function') { el.click(); }
      else {
        for (const type of ['mousedown', 'mouseup', 'click']) {
          el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
        }
      }
      return { ok: true, element: describe };
    }

    if (action === 'type') {
      el.focus({ preventScroll: true });
      if (el.isContentEditable) {
        el.textContent = value;
      } else if ('value' in el) {
        // React and friends track the value property, so set it through the
        // native setter before dispatching — a plain assignment is swallowed.
        const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value');
        if (setter && setter.set) setter.set.call(el, value); else el.value = value;
      }
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true, element: describe };
    }

    // press
    el.focus({ preventScroll: true });
    const parts = String(value || 'Enter').split('+').map((p) => p.trim()).filter(Boolean);
    const key = parts.pop() || 'Enter';
    const init = { key, bubbles: true, cancelable: true, ctrlKey: parts.includes('Control') || parts.includes('Ctrl'), shiftKey: parts.includes('Shift'), altKey: parts.includes('Alt'), metaKey: parts.includes('Meta') };
    el.dispatchEvent(new KeyboardEvent('keydown', init));
    el.dispatchEvent(new KeyboardEvent('keypress', init));
    el.dispatchEvent(new KeyboardEvent('keyup', init));
    if (key === 'Enter' && el.form && typeof el.form.requestSubmit === 'function') el.form.requestSubmit();
    return { ok: true, element: describe };
  })()`
}
