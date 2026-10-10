import path from 'node:path'
import { app, BrowserWindow, session, shell } from 'electron'
import { APP_ID } from '@shared/types'
import { buildContext, type AppContext } from './context'
import { registerIpc } from './ipc'

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
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 980,
    minHeight: 640,
    show: false,
    backgroundColor: '#0b0d12',
    autoHideMenuBar: true,
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#0e1016', symbolColor: '#cbd5e1', height: 40 },
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: true,
      spellcheck: false
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
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
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
      // eslint-disable-next-line no-console
      console.error('Failed to initialise application context', e)
    }
    await createWindow()

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
