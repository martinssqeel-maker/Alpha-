import path from 'node:path'
import { app, BrowserWindow, nativeTheme, session, shell } from 'electron'
import { APP_ID } from '@shared/types'
import { THEME_TOKENS, resolveTheme } from '@shared/theme'
import { buildContext, type AppContext } from './context'
import { registerIpc } from './ipc'
import { getLogger } from './services/logger'

let ctx: AppContext | null = null
let mainWindow: BrowserWindow | null = null

const isDev = !app.isPackaged

function emit(channel: string, data: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, data)
  }
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
  const preference = ctx?.settings.get().theme ?? 'dark'
  const theme = resolveTheme(preference, nativeTheme.shouldUseDarkColors)
  const tokens = THEME_TOKENS[theme]
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
      additionalArguments: [`--alpha-theme=${theme}`]
    }
  })

  mainWindow.once('ready-to-show', () => mainWindow?.show())
  mainWindow.on('closed', () => {
    mainWindow = null
  })

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
      registerIpc(ctx)
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

    void ctx?.platform.restore()
    for (const arg of process.argv) handleDeepLink(arg)

    setTimeout(() => {
      void ctx?.updates.check()
    }, 4000)

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) void createWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('before-quit', () => {
    try {
      ctx?.broker.rejectAll()
      ctx?.db.close()
    } catch {
      /* ignore */
    }
  })
}
