import { permissionsForMode, resolvePermission } from '@shared/permissions'
import type { PermissionLevel, PermissionMode, PermissionSettings } from '@shared/types'
import type { SettingsRepo } from './store'

export type PermissionDecision = 'allow' | 'ask' | 'deny'

export class PermissionService {
  constructor(private settings: SettingsRepo) {}

  get(): PermissionSettings {
    return this.settings.get().permissions
  }

  setMode(mode: PermissionMode): PermissionSettings {
    const next = permissionsForMode(mode, this.get())
    return this.settings.set({ permissions: next }).permissions
  }

  setLevel(key: keyof PermissionSettings, level: PermissionLevel): PermissionSettings {
    const current = this.get()
    const next = { ...current, [key]: level } as PermissionSettings
    return this.settings.set({ permissions: next }).permissions
  }

  set(settings: PermissionSettings): PermissionSettings {
    return this.settings.set({ permissions: settings }).permissions
  }

  resolve(key: keyof PermissionSettings): PermissionDecision {
    return resolvePermission(this.get(), key)
  }
}

export class ApprovalBroker {
  private pending = new Map<string, (approved: boolean) => void>()

  request(id: string): Promise<boolean> {
    return new Promise((resolve) => {
      this.pending.set(id, resolve)
    })
  }

  resolve(id: string, approved: boolean): void {
    const fn = this.pending.get(id)
    if (fn) {
      this.pending.delete(id)
      fn(approved)
    }
  }

  rejectAll(): void {
    for (const [, fn] of this.pending) fn(false)
    this.pending.clear()
  }

  get size(): number {
    return this.pending.size
  }
}
