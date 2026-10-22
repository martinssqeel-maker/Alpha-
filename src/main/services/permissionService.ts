import { permissionsForMode, resolvePermission, toolNeedsApproval } from '@shared/permissions'
import type { PermissionLevel, PermissionMode, PermissionSettings } from '@shared/types'
import type { SettingsRepo } from './store'
import {
  GRANTABLE_TOOLS,
  SessionGrantRegistry,
  type GrantableTool,
  type GrantMissReason,
  type SessionGrant
} from './sessionGrants'

export type PermissionDecision = 'allow' | 'ask' | 'deny'

export interface ToolGateInput {
  /** The user turn requesting the call; grants never cross turns. */
  turnId: string
  toolName: string
  permissionKey: keyof PermissionSettings
  requiresApproval?: boolean
  /** For `run_approved_command`. */
  command?: string | null
  /** For `apply_approved_patch`: resolved target paths. */
  paths?: string[]
}

export interface ToolGateResult {
  decision: PermissionDecision
  /** True when a session grant replaced an interactive prompt. */
  autoApproved: boolean
  grantId?: string
  attemptsLeft?: number
  /** Why a grant did not apply, for the log line and for tests. */
  reason?: GrantMissReason
}

export class PermissionService {
  private grants = new SessionGrantRegistry()

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

  // -------------------------------------------------------------------------
  // Session grants (Option A)
  // -------------------------------------------------------------------------

  /**
   * Resolve a tool call, consulting an active session grant before prompting.
   *
   * Order is deliberate:
   *  1. `deny` from the permission matrix is final — a grant can never lift it.
   *  2. a matching grant turns `ask` into `allow` and spends one attempt.
   *  3. otherwise the normal matrix applies unchanged.
   */
  gateTool(input: ToolGateInput): ToolGateResult {
    const { decision } = toolNeedsApproval(this.get(), input.permissionKey, input.requiresApproval === true)
    if (decision === 'deny') return { decision, autoApproved: false }
    if (decision !== 'ask') return { decision, autoApproved: false }

    const match = this.grants.match({
      turnId: input.turnId,
      toolName: input.toolName,
      command: input.command ?? null,
      paths: input.paths
    })
    if (!match.matched) return { decision, autoApproved: false, reason: match.reason }

    const attemptsLeft = this.grants.consume({
      turnId: input.turnId,
      toolName: input.toolName,
      command: input.command ?? null,
      paths: input.paths
    })
    return {
      decision: 'allow',
      autoApproved: true,
      grantId: match.grant.id,
      attemptsLeft: attemptsLeft ?? match.attemptsLeft - 1
    }
  }

  /**
   * Record a user's explicit approval as a bounded grant so the repair loop can
   * retry. Only the two allowlisted tools, and only with a concrete binding.
   */
  grantAfterApproval(input: {
    turnId: string
    toolName: string
    command?: string | null
    paths?: string[]
    attempts?: number
  }): SessionGrant | null {
    if (!GRANTABLE_TOOLS.includes(input.toolName as GrantableTool)) return null
    return this.grants.issue({
      turnId: input.turnId,
      tool: input.toolName as GrantableTool,
      command: input.command ?? null,
      paths: input.paths,
      attempts: input.attempts
    })
  }

  /** Turn finished: drop its grants. */
  revokeTurnGrants(turnId: string): number {
    return this.grants.revokeTurn(turnId)
  }

  /** Kill-switch. */
  revokeAllGrants(): number {
    return this.grants.revokeAll()
  }

  activeGrants(): SessionGrant[] {
    return this.grants.list()
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
