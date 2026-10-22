import path from 'node:path'
import { BrowserWindow, ipcMain, screen } from 'electron'
import { HUD } from '@shared/channels'
import type { HudState } from '@shared/types'
import { canDeliverHudState } from './services/hudGuard'
import { getLogger } from './services/logger'

/**
 * Always-on-top mini control pill.
 *
 * The problem it solves is specific: while the agent is driving Word, the Alpha
 * window is behind Word. If an approval is requested at that moment the user
 * cannot see it, and the run appears to hang. A small always-on-top window in
 * the corner keeps the current step, the approve/deny pair and the stop button
 * reachable from whatever app is in front.
 *
 * It is only shown while a task is running or waiting for approval, and it never
 * takes focus on its own (`focusable` stays true for the buttons, but `show()`
 * uses `showInactive()`).
 */

const WIDTH = 372
const HEIGHT = 116
const MARGIN = 18

export interface HudHandlers {
  onDecision: (approvalId: string, approved: boolean) => void
  onStop: () => void
}

export class HudWindow {
  private window: BrowserWindow | null = null
  private state: HudState = {
    visible: false,
    phase: 'idle',
    title: '',
    canStop: false
  }
  private registered = false
  /** True once the pill's document has finished loading and can accept IPC. */
  private ready = false
  /** Set while `dispose()` runs, so late events are ignored instead of throwing. */
  private disposed = false

  constructor(private readonly handlers: HudHandlers) {
    this.registerIpc()
  }

  /**
   * Push a new state; shows or hides the pill to match.
   *
   * Every step here is guarded. The pill is updated from the chat event stream,
   * which can fire while the app is quitting, while the window is mid-destroy, or
   * before its document has finished loading — and a rejected `send` on a gone
   * webContents surfaces as an unhandled rejection rather than a catchable error
   * at the call site. Returning silently is the correct behaviour for all three.
   */
  update(next: HudState): void {
    if (this.disposed) return
    this.state = next
    if (next.phase === 'idle' || !next.visible) {
      this.hide()
      return
    }
    const win = this.ensureWindow()
    if (!win) return
    this.sendState(win, next)
    if (!win.isDestroyed() && !win.isVisible()) this.show()
  }

  getState(): HudState {
    return { ...this.state }
  }

  /** The pill's window, so callers can exclude it when broadcasting. */
  get browserWindow(): BrowserWindow | null {
    return this.window && !this.window.isDestroyed() ? this.window : null
  }

  show(): void {
    if (this.disposed) return
    const win = this.ensureWindow()
    if (!win || win.isDestroyed()) return
    try {
      this.position(win)
      // Never steal focus from the app the agent is driving.
      win.showInactive()
    } catch (error) {
      getLogger().debug('hud', `show failed: ${(error as Error).message}`)
    }
  }

  hide(): void {
    const win = this.window
    if (!win || win.isDestroyed()) return
    try {
      if (win.isVisible()) win.hide()
    } catch (error) {
      getLogger().debug('hud', `hide failed: ${(error as Error).message}`)
    }
  }

  dispose(): void {
    // Mark first: an event already queued on the loop must not resurrect the
    // window we are about to destroy.
    this.disposed = true
    this.ready = false
    const win = this.window
    this.window = null
    if (win && !win.isDestroyed()) {
      try {
        win.destroy()
      } catch (error) {
        getLogger().debug('hud', `destroy failed: ${(error as Error).message}`)
      }
    }
    if (this.registered) {
      ipcMain.removeListener(HUD.decision, this.onDecision)
      ipcMain.removeListener(HUD.stop, this.onStop)
      this.registered = false
    }
  }

  private onDecision = (_event: unknown, payload: unknown): void => {
    const data = (payload ?? {}) as { approvalId?: string; approved?: boolean }
    if (typeof data.approvalId !== 'string' || !data.approvalId) return
    this.handlers.onDecision(data.approvalId, data.approved === true)
  }

  private onStop = (): void => {
    this.handlers.onStop()
  }

  private registerIpc(): void {
    if (this.registered) return
    ipcMain.on(HUD.decision, this.onDecision as never)
    ipcMain.on(HUD.stop, this.onStop as never)
    this.registered = true
  }

  private ensureWindow(): BrowserWindow | null {
    if (this.disposed) return null
    const existing = this.window
    if (existing && !existing.isDestroyed()) return existing
    // A window object that exists but whose native side is gone must be replaced,
    // not reused: `isDestroyed()` on a half-torn-down window can still be false
    // while its webContents is already invalid.
    if (existing && existing.webContents?.isDestroyed?.() !== false) {
      this.window = null
    }
    let win: BrowserWindow
    try {
      win = this.createWindow()
    } catch (error) {
      getLogger().warn('hud', `could not create the control pill: ${(error as Error).message}`)
      this.window = null
      return null
    }
    this.window = win
    try {
      this.position(win)
    } catch (error) {
      getLogger().warn('hud', `could not position the control pill: ${(error as Error).message}`)
    }
    return win
  }

  private createWindow(): BrowserWindow {
    const preload = path.join(__dirname, '../preload/hud.js')
    const win = new BrowserWindow({
      width: WIDTH,
      height: HEIGHT,
      show: false,
      frame: false,
      transparent: true,
      resizable: false,
      movable: true,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      hasShadow: false,
      backgroundColor: '#00000000',
      webPreferences: {
        preload,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        spellcheck: false
      }
    })
    // Float above full-screen apps too, which plain alwaysOnTop does not always do.
    win.setAlwaysOnTop(true, 'screen-saver')
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    win.on('closed', () => {
      if (this.window === win) {
        this.window = null
        this.ready = false
      }
    })
    win.webContents.on('did-finish-load', () => {
      if (this.disposed || win.isDestroyed()) return
      this.ready = true
      // Deliver whatever state accumulated while the document was loading.
      this.sendState(win, this.state)
    })
    win.webContents.on('render-process-gone', () => {
      // The renderer crashed: drop the handle so the next update recreates it.
      if (this.window === win) {
        this.ready = false
        try {
          win.destroy()
        } catch {
          /* already gone */
        }
        this.window = null
      }
    })
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    void win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(HUD_HTML)}`)
    return win
  }

  /**
   * Send a state payload only when there is a live receiver.
   *
   * Returns whether it was delivered, so callers can decide to retry. `send` can
   * throw synchronously (destroyed webContents) or return a rejected promise on
   * the renderer side; both are swallowed here because a missing pill must never
   * be able to interrupt the agent.
   */
  private sendState(win: BrowserWindow | null, state: HudState): boolean {
    const contents = win && !win.isDestroyed() ? win.webContents : null
    const deliverable = canDeliverHudState({
      disposed: this.disposed,
      ready: this.ready,
      windowDestroyed: !win || win.isDestroyed(),
      hasWebContents: Boolean(contents),
      contentsDestroyed: !contents || contents.isDestroyed()
    })
    if (!deliverable || !contents) return false
    try {
      contents.send(HUD.state, state)
      return true
    } catch (error) {
      getLogger().debug('hud', `state send failed: ${(error as Error).message}`)
      return false
    }
  }

  private position(win: BrowserWindow): void {
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
    const area = display.workArea
    win.setBounds({
      x: Math.round(area.x + area.width - WIDTH - MARGIN),
      y: Math.round(area.y + area.height - HEIGHT - MARGIN),
      width: WIDTH,
      height: HEIGHT
    })
  }
}

/**
 * The pill's markup.
 *
 * Inline because it is ~2 KB of static CSS/HTML: a bundled renderer entry for
 * three buttons would add a build target and a second Vite graph for no gain.
 * Values are written with `textContent`, never `innerHTML`, so a window title or
 * command containing markup cannot inject anything.
 */
const HUD_HTML = `<!doctype html>
<html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 10px 12px; height: 100vh;
    font-family: -apple-system, 'Segoe UI', system-ui, sans-serif;
    background: transparent; overflow: hidden;
    -webkit-user-select: none; user-select: none;
  }
  .pill {
    height: 100%; border-radius: 14px; padding: 10px 12px;
    background: rgba(20, 20, 24, 0.96);
    border: 1px solid rgba(255,255,255,0.12);
    box-shadow: 0 10px 30px rgba(0,0,0,0.45);
    display: flex; flex-direction: column; gap: 8px;
    -webkit-app-region: drag;
  }
  .row { display: flex; align-items: center; gap: 8px; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: #38bdf8; flex: none; }
  .dot.approval { background: #fbbf24; }
  .dot.working { background: #38bdf8; animation: pulse 1.4s ease-in-out infinite; }
  @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.35; } }
  .title { font-size: 12px; font-weight: 600; color: #f4f4f5; flex: 1;
           white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .detail { font-size: 11px; color: #a1a1aa; line-height: 1.35;
            max-height: 28px; overflow: hidden; }
  .actions { display: flex; gap: 6px; -webkit-app-region: no-drag; }
  button { font: inherit; font-size: 11px; font-weight: 600; border-radius: 7px;
           border: 1px solid rgba(255,255,255,0.16); background: rgba(255,255,255,0.08);
           color: #f4f4f5; padding: 4px 10px; cursor: pointer; }
  button:hover { background: rgba(255,255,255,0.16); }
  button.approve { background: #16a34a; border-color: #16a34a; }
  button.approve:hover { background: #15803d; }
  button.deny { background: transparent; border-color: rgba(248,113,113,0.5); color: #fca5a5; }
  button.stop { margin-left: auto; background: transparent; border-color: rgba(255,255,255,0.2); color: #d4d4d8; }
  .hidden { display: none !important; }
</style></head>
<body>
  <div class="pill">
    <div class="row">
      <span class="dot" id="dot"></span>
      <span class="title" id="title">Alpha is working</span>
    </div>
    <div class="detail" id="detail"></div>
    <div class="actions">
      <button class="approve hidden" id="approve">Approve</button>
      <button class="deny hidden" id="deny">Deny</button>
      <button class="stop" id="stop">Stop &#183; Alt+Shift+Q</button>
    </div>
  </div>
<script>
  const el = (id) => document.getElementById(id);
  let approvalId = null;

  function render(state) {
    const dot = el('dot');
    dot.className = 'dot ' + (state.phase === 'approval' ? 'approval' : 'working');
    el('title').textContent = state.title || 'Alpha is working';
    el('detail').textContent = state.detail || '';
    approvalId = state.approvalId || null;
    const showApproval = state.phase === 'approval' && Boolean(approvalId);
    el('approve').classList.toggle('hidden', !showApproval);
    el('deny').classList.toggle('hidden', !showApproval);
    el('stop').classList.toggle('hidden', !state.canStop && !showApproval);
  }

  el('approve').addEventListener('click', () => {
    if (approvalId) window.alphaHud.decide(approvalId, true);
  });
  el('deny').addEventListener('click', () => {
    if (approvalId) window.alphaHud.decide(approvalId, false);
  });
  el('stop').addEventListener('click', () => window.alphaHud.stop());

  window.alphaHud.onState(render);
</script>
</body></html>`
