import { app } from 'electron'
import { autoUpdater, type ProgressInfo, type UpdateInfo } from 'electron-updater'
import type { UpdateStatus } from '@shared/types'
import type { Logger } from './logger'

export class UpdateService {
  private status: UpdateStatus

  constructor(
    private logger: Logger,
    private report: (status: UpdateStatus) => void
  ) {
    this.status = { state: app.isPackaged ? 'idle' : 'unsupported', currentVersion: app.getVersion() }
    if (!app.isPackaged) return
    autoUpdater.autoDownload = false
    autoUpdater.logger = {
      info: (m?: unknown) => this.logger.debug('updater', m ?? ''),
      warn: (m?: unknown) => this.logger.warn('updater', m ?? ''),
      error: (m?: unknown) => this.logger.error('updater', m ?? ''),
      debug: (m?: unknown) => this.logger.debug('updater', m ?? '')
    }
    this.wireEvents()
  }

  private set(next: Partial<UpdateStatus>): void {
    this.status = { ...this.status, ...next }
    this.report(this.status)
  }

  private wireEvents(): void {
    autoUpdater.on('checking-for-update', () => this.set({ state: 'checking', message: 'Checking for updates…' }))
    autoUpdater.on('update-available', (info: UpdateInfo) =>
      this.set({
        state: 'available',
        version: info.version,
        releaseName: info.releaseName ?? undefined,
        releaseDate: info.releaseDate ?? undefined,
        message: `Version ${info.version} is available.`
      })
    )
    autoUpdater.on('update-not-available', () => this.set({ state: 'up-to-date', message: 'You are on the latest version.' }))
    autoUpdater.on('error', (err: Error) => this.set({ state: 'error', message: (err?.message ?? String(err)).slice(0, 400) }))
    autoUpdater.on('download-progress', (p: ProgressInfo) =>
      this.set({ state: 'downloading', percent: Math.round(p.percent), message: `Downloading ${Math.round(p.percent)}%` })
    )
    autoUpdater.on('update-downloaded', (info: UpdateInfo) =>
      this.set({
        state: 'downloaded',
        version: info.version,
        releaseName: info.releaseName ?? undefined,
        percent: 100,
        message: 'Update downloaded. Restart to install.'
      })
    )
  }

  async check(): Promise<UpdateStatus> {
    if (!app.isPackaged) {
      this.set({ state: 'unsupported', message: 'Updates are only available in packaged builds.' })
      return this.status
    }
    try {
      await autoUpdater.checkForUpdates()
    } catch (e) {
      this.logger.warn('updater', `check failed: ${(e as Error).message}`)
      this.set({ state: 'error', message: `Update check failed: ${(e as Error).message.toLowerCase()}` })
    }
    return this.status
  }

  async download(): Promise<UpdateStatus> {
    if (!app.isPackaged) {
      this.set({ state: 'unsupported', message: 'Updates are only available in packaged builds.' })
      return this.status
    }
    if (this.status.state !== 'available') return this.status
    try {
      this.set({ state: 'downloading', percent: 0, message: 'Downloading…' })
      await autoUpdater.downloadUpdate()
    } catch (e) {
      this.set({ state: 'error', message: `Download failed: ${(e as Error).message.toLowerCase()}` })
    }
    return this.status
  }

  install(): { ok: boolean; message?: string } {
    if (!app.isPackaged) {
      return { ok: false, message: 'Updates are only available in packaged builds.' }
    }
    if (this.status.state !== 'downloaded') {
      return { ok: false, message: 'No downloaded update to install.' }
    }
    this.set({ state: 'installing', message: 'Installing update…' })
    autoUpdater.quitAndInstall(false, true)
    return { ok: true }
  }

  getStatus(): UpdateStatus {
    return this.status
  }
}