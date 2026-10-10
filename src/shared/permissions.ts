import type { PermissionLevel, PermissionMode, PermissionSettings } from './types'

export const DEFAULT_PERMISSIONS: PermissionSettings = {
  mode: 'assist',
  fileWrites: 'ask',
  fileDeletes: 'ask',
  terminal: 'ask',
  packageInstall: 'ask',
  network: 'ask',
  gitCommit: 'ask',
  githubPush: 'ask',
  sensitiveFiles: 'deny'
}

export const AGENT_PERMISSIONS: PermissionSettings = {
  mode: 'agent',
  fileWrites: 'allow',
  fileDeletes: 'ask',
  terminal: 'allow',
  packageInstall: 'ask',
  network: 'ask',
  gitCommit: 'ask',
  githubPush: 'ask',
  sensitiveFiles: 'deny'
}

export const CHAT_PERMISSIONS: PermissionSettings = {
  mode: 'chat',
  fileWrites: 'deny',
  fileDeletes: 'deny',
  terminal: 'deny',
  packageInstall: 'deny',
  network: 'deny',
  gitCommit: 'deny',
  githubPush: 'deny',
  sensitiveFiles: 'deny'
}

const MODE_DEFAULTS: Record<PermissionMode, Partial<PermissionSettings>> = {
  chat: CHAT_PERMISSIONS,
  assist: DEFAULT_PERMISSIONS,
  agent: AGENT_PERMISSIONS
}

export function permissionsForMode(
  mode: PermissionMode,
  current?: PermissionSettings
): PermissionSettings {
  const base = MODE_DEFAULTS[mode]
  return {
    ...DEFAULT_PERMISSIONS,
    ...base,
    mode,
    // Preserve user's sensitiveFiles choice across mode switches.
    sensitiveFiles: current?.sensitiveFiles ?? base.sensitiveFiles ?? 'deny'
  }
}

export type PermissionDecision = 'allow' | 'ask' | 'deny'

/**
 * Resolve the effective decision for a named permission key.
 * In Chat mode every mutating action is denied regardless of stored levels.
 */
export function resolvePermission(
  settings: PermissionSettings,
  key: keyof PermissionSettings
): PermissionDecision {
  if (key === 'mode') return 'deny'
  if (settings.mode === 'chat') return 'deny'
  const value = settings[key]
  if (value === 'allow' || value === 'ask' || value === 'deny') return value
  return 'ask'
}

export function isMutatingKey(key: keyof PermissionSettings): boolean {
  return key !== 'mode'
}
