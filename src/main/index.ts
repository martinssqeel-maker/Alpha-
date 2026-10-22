import path from 'node:path'
import { app, BrowserWindow, globalShortcut, nativeTheme, session, shell } from 'electron'
import { APP_ID, type ChatEvent, type HudState } from '@shared/types'
import { createThemeTokens, normalizeAppearanceSettings, resolveTheme } from '@shared/theme'
import { buildContext, type AppContext } from './context'
import { registerIpc } from './ipc'
import { EVENTS } from '@shared/channels'
import { HudWindow } from './hudWindow'
import { getLogger } from './services/logger'

let ctx: AppContext | null = null
let mainWindow: BrowserWindow | null = null
let hud: HudWindow | null = null

/** Mirror of what the control pill is showing; also drives show/hide. */
/** How often a running app re-polls the release feed (6 hours). */
const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000
let updateTimer: NodeJS.Timeout | null = null

let hudState: HudState = {
  visible: false,
  phase: 'idle',
  title: '',
  canStop: false
}

/**
 * Emergency kill-switch.
 *
 * Registered globally so it works while Word, Godot or a browser has focus —
 * which is precisely when the agent is most likely to be mid-task. Everything
 * that can still be moving is stopped: chat turns abort, pending approvals are
 * rejected, and any in-flight PowerShell/automation child process is killed.
 */
function emergencyStop(): void {
  const cancelled = ctx?.chat.cancelAll() ?? 0
  try {
    ctx?.broker.rejectAll()
    ctx?.desktop.killAll()
    ctx?.computer.killAll()
  } catch (error) {
    getLogger().warn('app', `kill-switch cleanup failed: ${(error as Error).message}`)
  }
  pushHud({ phase: 'idle', visible: false, title: '', detail: undefined, approvalId: undefined, canStop: false })
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed() || win === hud?.browserWindow) continue
    win.webContents.send(EVENTS.agentStopped, { at: Date.now(), cancelled })
  }
  getLogger().warn('app', `emergency kill-switch invoked (${cancelled} turn(s) aborted)`)
}

/** Merge a HUD patch and decide whether the pill should be on screen. */
function pushHud(patch: Partial<HudState>): void {
  hudState = { ...hudState, ...patch }
  const mainInFront = Boolean(
    mainWindow && !mainWindow.isDestroyed() && mainWindow.isFocused() && !mainWindow.isMinimized()
  )
  const visible = hudState.phase !== 'idle' && !mainInFront
  hud?.update({ ...hudState, visible })
}

/** Translate the chat event stream into a one-line HUD status. */
function updateHudFromChat(event: ChatEvent): void {
  switch (event.type) {
    case 'start':
      pushHud({ phase: 'working', title: 'Alpha is working', detail: 'Planning the next step', canStop: true, approvalId: undefined })
      break
    case 'thinking':
      pushHud({ phase: 'working', title: 'Alpha is thinking', detail: event.content.slice(0, 110), canStop: true })
      break
    case 'activity': {
      const activity = event.activity
      if (activity.state === 'awaiting-approval') {
        pushHud({
          phase: 'approval',
          title: `Approve: ${activity.title}`,
          detail: activity.detail?.slice(0, 140),
          approvalId: activity.approvalId,
          canStop: true
        })
      } else if (activity.state === 'running') {
        pushHud({
          phase: 'working',
          title: activity.title,
          detail: activity.detail?.slice(0, 140),
          approvalId: undefined,
          canStop: true
        })
      } else if (activity.verification) {
        pushHud({
          phase: 'working',
          title: activity.title,
          detail: `${activity.verification.verified ? 'Verified' : 'Unverified'}: ${activity.verification.note}`.slice(0, 150),
          approvalId: undefined,
          canStop: true
        })
      }
      break
    }
    case 'done':
    case 'error':
    case 'cancelled':
      pushHud({ phase: 'idle', visible: false, title: '', detail: undefined, approvalId: undefined, canStop: false })
      break
    default:
      break
  }
}

const isDev = !app.isPackaged

function emit(channel: string, data: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, data)
  }
  if (channel === EVENTS.chat) updateHudFromChat(data as ChatEvent)
}

function contentSecurityPolicy(): string {
  if (isDev) {
    return [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self' data:",
      "connect-src 'self' ws: wss: http://localhost:* http://127.0.0.1:*",
      "media-src 'self' blob: data:"
    ].join('; ')
  }
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "media-src 'self' blob: data:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'"
  ].join('; ')
}

function hardenSession(): void {
  const ses = session.defaultSession
  ses.webRequest.onHeadersReceived((details, callback) => {
    const headers = details.responseHeaders ?? {}
    headers['Content-Security-Policy'] = [contentSecurityPolicy()]
    callback({ responseHeaders: headers })
  })
  ses.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === 'media')
  })
}

async function createWindow(): Promise<void> {
  const settings = ctx?.settings.get()
  const preference = settings?.theme ?? 'solar-flare'
  const appearance = normalizeAppearanceSettings(settings?.appearance)
  nativeTheme.themeSource = appearance.mode
  const theme = resolveTheme(preference, nativeTheme.shouldUseDarkColors)
  const tokens = createThemeTokens(theme, appearance, nativeTheme.shouldUseDarkColors)
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 980,
    minHeight: 640,
    show: false,
    // Packaged builds take the icon from the exe resource; dev needs it explicit.
    icon: isDev ? path.join(app.getAppPath(), 'build', 'icon.ico') : undefined,
    backgroundColor: tokens['--surface-0'],
    autoHideMenuBar: true,
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: tokens['--surface-1'], symbolColor: tokens['--text-secondary'], height: 40 },
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: true,
      spellcheck: false,
      additionalArguments: [`--alpha-theme=${theme}`, `--alpha-mode=${appearance.mode}`]
    }
  })

  mainWindow.once('ready-to-show', () => mainWindow?.show())
  mainWindow.on('closed', () => {
    ctx?.browserPreview.dispose()
    mainWindow = null
  })
  // Focus changes decide whether the pill is needed: if the user is looking at
  // Alpha, an inline approval is enough.
  mainWindow.on('focus', () => pushHud({}))
  mainWindow.on('blur', () => pushHud({}))
  mainWindow.on('minimize', () => pushHud({}))
  mainWindow.on('restore', () => pushHud({}))
  ctx?.browserPreview.attach(mainWindow)

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) {
    await mainWindow.loadURL(devUrl)
    mainWindow.webContents.openDevTools({ mode: 'detach' })
  } else {
    await mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  const DEFAULT_AUTH_SCHEME = 'alpha'
  const AUTH_SCHEME_PATTERN = /^[a-z][a-z0-9+.-]*$/

  /**
   * Deep-link scheme used for sign-in, from Settings → Alpha Cloud
   * (`authRedirectScheme`). Falls back to `alpha` when unset or malformed. The
   * server must be configured to emit links for the same scheme; the installer
   * also registers `alpha` via electron-builder.yml `protocols`.
   */
  function configuredAuthScheme(): string {
    const raw = ctx?.platform.authScheme() ?? ''
    return AUTH_SCHEME_PATTERN.test(raw) ? raw : DEFAULT_AUTH_SCHEME
  }

  function handleDeepLink(rawUrl: string): void {
    const scheme = configuredAuthScheme().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    if (!new RegExp(`^${scheme}://`).test(rawUrl)) return
    const c = ctx
    if (!c) return
    void c.platform.handleRedirectUrl(rawUrl).then(() => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        if (mainWindow.isMinimized()) mainWindow.restore()
        mainWindow.focus()
      }
    })
  }

  app.on('second-instance', (_e, argv, _workingDirectory) => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
    for (const arg of argv) handleDeepLink(arg)
  })

  app.on('open-url', (event, url) => {
    event.preventDefault()
    handleDeepLink(url)
  })

  app.on('web-contents-created', (_e, contents) => {
    contents.setWindowOpenHandler(({ url }) => {
      if (/^https?:/.test(url)) void shell.openExternal(url)
      return { action: 'deny' }
    })
    contents.on('will-navigate', (event, url) => {
      if (url !== contents.getURL()) {
        event.preventDefault()
        if (/^https?:/.test(url)) void shell.openExternal(url)
      }
    })
  })

  app.whenReady().then(async () => {
    app.setAppUserModelId(APP_ID)
    hardenSession()
    try {
      ctx = await buildContext(app.getPath('userData'), emit)
      hud = new HudWindow({
        onDecision: (approvalId, approved) => {
          ctx?.broker.resolve(approvalId, approved)
          pushHud({ phase: 'working', approvalId: undefined, title: 'Continuing', canStop: true })
        },
        onStop: () => emergencyStop()
      })
      registerIpc(ctx, ctx.browserPreview)
    } catch (e) {
      // If context failed we still want a window to show the error.
      try {
        getLogger().error(
          'app',
          `context init failed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`
        )
      } catch {
        /* ignore */
      }
      // eslint-disable-next-line no-console
      console.error('Failed to initialise application context', e)
    }
    // Register after the context exists so the configured scheme is honoured.
    // Changing the scheme while running takes effect on the next launch.
    app.setAsDefaultProtocolClient(
      configuredAuthScheme(),
      process.execPath,
      isDev ? [path.resolve(process.argv[1] ?? '')] : []
    )

    await createWindow()

    // Alt+Shift+Q is deliberately obscure: it must not collide with an editor
    // shortcut, because the whole point is that it works from inside another app.
    const registered = globalShortcut.register('Alt+Shift+Q', emergencyStop)
    if (!registered) {
      getLogger().warn('app', 'could not register the Alt+Shift+Q kill-switch; another app may own it')
    }

    void ctx?.platform.restore()
    for (const arg of process.argv) handleDeepLink(arg)

    // First check shortly after launch, then periodically: a desktop app can stay
    // open for days, and a release published after launch would otherwise stay
    // invisible until the user happened to restart.
    setTimeout(() => {
      void ctx?.updates.check()
    }, 4000)
    updateTimer = setInterval(() => {
      void ctx?.updates.check()
    }, UPDATE_CHECK_INTERVAL_MS)

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) void createWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('will-quit', () => {
    if (updateTimer) {
      clearInterval(updateTimer)
      updateTimer = null
    }
    globalShortcut.unregisterAll()
    hud?.dispose()
    hud = null
  })

  app.on('before-quit', () => {
    try {
      ctx?.broker.rejectAll()
      ctx?.desktop.killAll()
      ctx?.db.close()
    } catch {
      /* ignore */
    }
  })
}
