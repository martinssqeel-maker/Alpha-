import type { PermissionLevel, PermissionMode, PermissionSettings } from './types'

/**
 * Permission model.
 *
 * Every capability is `allow` | `ask` | `deny`. The three modes are *presets*
 * over the same keys, so a user can tighten any single key afterwards without
 * leaving the mode.
 *
 * Desktop control added three keys (`appLaunch`, `desktopControl`,
 * `browserControl`) rather than folding them into `terminal`. Starting Word and
 * synthesising a mouse click are different risks from running a shell command,
 * and a user who trusts commands may still not want their cursor moved.
 */
export const DEFAULT_PERMISSIONS: PermissionSettings = {
  mode: 'assist',
  fileWrites: 'ask',
  fileDeletes: 'ask',
  terminal: 'ask',
  packageInstall: 'ask',
  network: 'ask',
  gitCommit: 'ask',
  githubPush: 'ask',
  sensitiveFiles: 'deny',
  appLaunch: 'ask',
  desktopControl: 'ask',
  browserControl: 'ask'
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
  sensitiveFiles: 'deny',
  appLaunch: 'allow',
  desktopControl: 'allow',
  browserControl: 'allow'
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
  sensitiveFiles: 'deny',
  appLaunch: 'deny',
  desktopControl: 'deny',
  browserControl: 'deny'
}

const MODE_DEFAULTS: Record<PermissionMode, Partial<PermissionSettings>> = {
  chat: CHAT_PERMISSIONS,
  assist: DEFAULT_PERMISSIONS,
  agent: AGENT_PERMISSIONS
}

/**
 * Keys that read the machine but change nothing. In `assist` these stay usable
 * without a prompt: window inspection, page reading and file reads are how the
 * agent decides what to propose in the first place.
 */
export const READ_ONLY_KEYS = ['sensitiveFiles'] as const

/** Human labels, used by the approval dialog and Settings. */
export const PERMISSION_LABELS: Record<keyof Omit<PermissionSettings, 'mode'>, string> = {
  fileWrites: 'Create or modify files',
  fileDeletes: 'Delete files',
  terminal: 'Run shell commands',
  packageInstall: 'Install packages',
  network: 'Reach the network',
  gitCommit: 'Commit to Git',
  githubPush: 'Push to a remote',
  sensitiveFiles: 'Read secrets (.env, keys)',
  appLaunch: 'Open and close applications',
  desktopControl: 'Control app windows and input',
  browserControl: 'Drive the built-in browser'
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

/**
 * Whether a tool may run without an approval prompt.
 *
 * Read-only inspection tools pass `permissionKey: 'read'`, which is not a stored
 * setting at all — it exists so the tool table can describe itself completely.
 */
export function toolNeedsApproval(
  settings: PermissionSettings,
  permissionKey: keyof PermissionSettings | 'read',
  requiresApproval: boolean
): { decision: PermissionDecision; reason?: string } {
  if (permissionKey === 'read') {
    if (settings.mode === 'chat') return { decision: 'deny', reason: 'Chat mode does not run tools.' }
    return { decision: 'allow' }
  }
  const decision = resolvePermission(settings, permissionKey)
  if (decision === 'allow' && requiresApproval) {
    // A tool that declares it always needs approval keeps that promise even when
    // the underlying capability is allowed — e.g. destructive commands.
    return { decision: 'ask' }
  }
  return { decision }
}

/** Normalise a stored settings blob that predates the desktop keys. */
export function normalizePermissions(value: unknown): PermissionSettings {
  const raw = (value ?? {}) as Partial<PermissionSettings>
  const mode: PermissionMode =
    raw.mode === 'chat' || raw.mode === 'agent' || raw.mode === 'assist' ? raw.mode : 'assist'
  const pick = (key: keyof PermissionSettings, fallback: PermissionLevel): PermissionLevel => {
    const candidate = raw[key]
    return candidate === 'allow' || candidate === 'ask' || candidate === 'deny' ? candidate : fallback
  }
  const defaults = MODE_DEFAULTS[mode]
  return {
    mode,
    fileWrites: pick('fileWrites', defaults.fileWrites ?? 'ask'),
    fileDeletes: pick('fileDeletes', defaults.fileDeletes ?? 'ask'),
    terminal: pick('terminal', defaults.terminal ?? 'ask'),
    packageInstall: pick('packageInstall', defaults.packageInstall ?? 'ask'),
    network: pick('network', defaults.network ?? 'ask'),
    gitCommit: pick('gitCommit', defaults.gitCommit ?? 'ask'),
    githubPush: pick('githubPush', defaults.githubPush ?? 'ask'),
    sensitiveFiles: pick('sensitiveFiles', 'deny'),
    appLaunch: pick('appLaunch', defaults.appLaunch ?? 'ask'),
    desktopControl: pick('desktopControl', defaults.desktopControl ?? 'ask'),
    browserControl: pick('browserControl', defaults.browserControl ?? 'ask')
  }
}
