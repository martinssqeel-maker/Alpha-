/**
 * Session-scoped grants (Option A).
 *
 * The rule under test throughout: a grant may turn `ask` into `allow` for one
 * exact command or one exact file, at most three times, inside one turn — and
 * nothing else. Anything out of scope, expired, or exhausted must fall back to
 * the normal approval dialog, and `deny` must never be lifted.
 */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_GRANT_TTL_MS,
  MAX_GRANT_ATTEMPTS,
  SessionGrantRegistry,
  normalizeCommand,
  normalizePath,
  samePath
} from '../src/main/services/sessionGrants'
import { PermissionService } from '../src/main/services/permissionService'
import type { PermissionSettings } from '../src/shared/types'
import { DEFAULT_PERMISSIONS } from '../src/shared/permissions'

/** Minimal settings stub: PermissionService only calls get()/set(). */
function settingsWith(permissions: Partial<PermissionSettings> = {}): {
  get: () => { permissions: PermissionSettings }
  set: (patch: unknown) => { permissions: PermissionSettings }
} {
  let current: PermissionSettings = { ...DEFAULT_PERMISSIONS, ...permissions }
  return {
    get: () => ({ permissions: current }),
    set: (patch: unknown) => {
      const next = (patch as { permissions?: PermissionSettings }).permissions
      if (next) current = next
      return { permissions: current }
    }
  }
}

const TURN = 'turn-1'
const CMD = 'npm test'

describe('normalisation', () => {
  it('collapses whitespace in commands but keeps everything else exact', () => {
    expect(normalizeCommand('  npm   test  ')).toBe('npm test')
    expect(normalizeCommand('npm test -- --run')).not.toBe(normalizeCommand('npm test'))
  })

  it('canonicalises separators and trailing slashes in paths', () => {
    expect(normalizePath('/a/b/c.ts')).toBe(normalizePath('/a/b/c.ts/'))
    expect(normalizePath('/a\\b\\c.ts')).toBe('/a/b/c.ts')
    expect(normalizePath('  ')).toBe('')
  })

  it('treats the same file as the same path', () => {
    expect(samePath('/repo/src/a.ts', '/repo/src/a.ts')).toBe(true)
    expect(samePath('/repo/src/a.ts', '/repo/src/b.ts')).toBe(false)
    expect(samePath('', '')).toBe(false)
  })
})

describe('registry — issuing', () => {
  it('refuses to issue an unbounded grant', () => {
    const registry = new SessionGrantRegistry()
    expect(registry.issue({ turnId: TURN, tool: 'run_approved_command' })).toBeNull()
    expect(registry.issue({ turnId: TURN, tool: 'apply_approved_patch', paths: [] })).toBeNull()
    expect(registry.issue({ turnId: '', tool: 'run_approved_command', command: CMD })).toBeNull()
    expect(registry.size).toBe(0)
  })

  it('caps attempts at the hard ceiling even if asked for more', () => {
    const registry = new SessionGrantRegistry()
    const grant = registry.issue({ turnId: TURN, tool: 'run_approved_command', command: CMD, attempts: 99 })
    expect(grant?.attemptsLeft).toBe(MAX_GRANT_ATTEMPTS)
  })

  it('refreshes instead of stacking when the same thing is approved twice', () => {
    const registry = new SessionGrantRegistry()
    const first = registry.issue({ turnId: TURN, tool: 'run_approved_command', command: CMD })
    const second = registry.issue({ turnId: TURN, tool: 'run_approved_command', command: 'npm  test' })
    expect(registry.size).toBe(1)
    expect(second?.id).toBe(first?.id)
  })
})

describe('registry — matching', () => {
  it('matches the exact command it was granted for', () => {
    const registry = new SessionGrantRegistry()
    registry.issue({ turnId: TURN, tool: 'run_approved_command', command: CMD })
    const match = registry.match({ turnId: TURN, toolName: 'run_approved_command', command: 'npm test' })
    expect(match.matched).toBe(true)
  })

  it('does not match a different command, a prefix, or a smuggled second command', () => {
    const registry = new SessionGrantRegistry()
    registry.issue({ turnId: TURN, tool: 'run_approved_command', command: CMD })
    for (const command of ['npm run build', 'npm', 'npm test -- --watch', 'npm test; rm -rf ~']) {
      const match = registry.match({ turnId: TURN, toolName: 'run_approved_command', command })
      expect(match.matched, command).toBe(false)
      if (!match.matched) expect(match.reason).toBe('command-mismatch')
    }
  })

  it('matches only the approved file, not its neighbours', () => {
    const registry = new SessionGrantRegistry()
    registry.issue({ turnId: TURN, tool: 'apply_approved_patch', paths: ['/repo/src/a.ts'] })
    expect(
      registry.match({ turnId: TURN, toolName: 'apply_approved_patch', paths: ['/repo/src/a.ts'] }).matched
    ).toBe(true)
    const miss = registry.match({ turnId: TURN, toolName: 'apply_approved_patch', paths: ['/repo/src/b.ts'] })
    expect(miss.matched).toBe(false)
    if (!miss.matched) expect(miss.reason).toBe('path-mismatch')
  })

  it('rejects a patch that mixes an approved file with an unapproved one', () => {
    const registry = new SessionGrantRegistry()
    registry.issue({ turnId: TURN, tool: 'apply_approved_patch', paths: ['/repo/src/a.ts'] })
    const match = registry.match({
      turnId: TURN,
      toolName: 'apply_approved_patch',
      paths: ['/repo/src/a.ts', '/repo/src/b.ts']
    })
    expect(match.matched).toBe(false)
  })

  it('rejects a patch request that names no path at all', () => {
    const registry = new SessionGrantRegistry()
    registry.issue({ turnId: TURN, tool: 'apply_approved_patch', paths: ['/repo/src/a.ts'] })
    expect(registry.match({ turnId: TURN, toolName: 'apply_approved_patch' }).matched).toBe(false)
  })

  it('never covers a tool it was not issued for', () => {
    const registry = new SessionGrantRegistry()
    registry.issue({ turnId: TURN, tool: 'run_approved_command', command: CMD })
    const match = registry.match({ turnId: TURN, toolName: 'delete_file', command: CMD })
    expect(match.matched).toBe(false)
    if (!match.matched) expect(match.reason).toBe('other-tool')
  })

  it('does not cross turns', () => {
    const registry = new SessionGrantRegistry()
    registry.issue({ turnId: TURN, tool: 'run_approved_command', command: CMD })
    const match = registry.match({ turnId: 'turn-2', toolName: 'run_approved_command', command: CMD })
    expect(match.matched).toBe(false)
    if (!match.matched) expect(match.reason).toBe('no-grant')
  })

  it('expires on the wall-clock backstop', () => {
    let now = 1_000
    const registry = new SessionGrantRegistry({ now: () => now })
    registry.issue({ turnId: TURN, tool: 'run_approved_command', command: CMD })
    now += DEFAULT_GRANT_TTL_MS - 1
    expect(registry.match({ turnId: TURN, toolName: 'run_approved_command', command: CMD }).matched).toBe(true)
    now += 2
    const expired = registry.match({ turnId: TURN, toolName: 'run_approved_command', command: CMD })
    expect(expired.matched).toBe(false)
    if (!expired.matched) expect(expired.reason).toBe('expired')
  })

  it('runs out after three uses', () => {
    const registry = new SessionGrantRegistry()
    registry.issue({ turnId: TURN, tool: 'run_approved_command', command: CMD })
    const request = { turnId: TURN, toolName: 'run_approved_command', command: CMD }
    expect(registry.consume(request)).toBe(2)
    expect(registry.consume(request)).toBe(1)
    expect(registry.consume(request)).toBe(0)
    const exhausted = registry.match(request)
    expect(exhausted.matched).toBe(false)
    if (!exhausted.matched) expect(exhausted.reason).toBe('exhausted')
  })

  it('does not spend an attempt on a call that does not match', () => {
    const registry = new SessionGrantRegistry()
    registry.issue({ turnId: TURN, tool: 'run_approved_command', command: CMD })
    expect(registry.consume({ turnId: TURN, toolName: 'run_approved_command', command: 'npm run build' })).toBeNull()
    expect(registry.list()[0].attemptsLeft).toBe(MAX_GRANT_ATTEMPTS)
  })
})

describe('registry — revocation', () => {
  it('drops a turn’s grants without touching other turns', () => {
    const registry = new SessionGrantRegistry()
    registry.issue({ turnId: TURN, tool: 'run_approved_command', command: CMD })
    registry.issue({ turnId: 'turn-2', tool: 'run_approved_command', command: 'npm run build' })
    expect(registry.revokeTurn(TURN)).toBe(1)
    expect(registry.size).toBe(1)
    expect(registry.list()[0].turnId).toBe('turn-2')
  })

  it('revokes everything for the kill-switch', () => {
    const registry = new SessionGrantRegistry()
    registry.issue({ turnId: TURN, tool: 'run_approved_command', command: CMD })
    registry.issue({ turnId: 'turn-2', tool: 'run_approved_command', command: 'npm run build' })
    expect(registry.revokeAll()).toBe(2)
    expect(registry.size).toBe(0)
  })

  it('prunes expired and exhausted grants', () => {
    let now = 0
    const registry = new SessionGrantRegistry({ now: () => now })
    registry.issue({ turnId: TURN, tool: 'run_approved_command', command: CMD })
    registry.issue({ turnId: TURN, tool: 'apply_approved_patch', paths: ['/a.ts'], ttlMs: 1 })
    now = 10
    expect(registry.prune()).toBe(1)
    expect(registry.size).toBe(1)
  })
})

describe('PermissionService.gateTool', () => {
  it('asks when nothing has been granted', () => {
    const permissions = new PermissionService(settingsWith({ mode: 'assist' }) as never)
    const gate = permissions.gateTool({
      turnId: TURN,
      toolName: 'run_approved_command',
      permissionKey: 'terminal',
      requiresApproval: true,
      command: CMD
    })
    expect(gate).toMatchObject({ decision: 'ask', autoApproved: false, reason: 'no-grant' })
  })

  it('allows silently once the same command was granted, and decrements', () => {
    const permissions = new PermissionService(settingsWith({ mode: 'assist' }) as never)
    permissions.grantAfterApproval({ turnId: TURN, toolName: 'run_approved_command', command: CMD })
    const first = permissions.gateTool({
      turnId: TURN,
      toolName: 'run_approved_command',
      permissionKey: 'terminal',
      requiresApproval: true,
      command: CMD
    })
    expect(first.decision).toBe('allow')
    expect(first.autoApproved).toBe(true)
    expect(first.attemptsLeft).toBe(2)
  })

  it('falls back to asking for an out-of-scope command', () => {
    const permissions = new PermissionService(settingsWith({ mode: 'assist' }) as never)
    permissions.grantAfterApproval({ turnId: TURN, toolName: 'run_approved_command', command: CMD })
    const gate = permissions.gateTool({
      turnId: TURN,
      toolName: 'run_approved_command',
      permissionKey: 'terminal',
      requiresApproval: true,
      command: 'npm run deploy'
    })
    expect(gate).toMatchObject({ decision: 'ask', autoApproved: false })
  })

  it('falls back to asking for an out-of-scope file', () => {
    const permissions = new PermissionService(settingsWith({ mode: 'assist' }) as never)
    permissions.grantAfterApproval({ turnId: TURN, toolName: 'apply_approved_patch', paths: ['/repo/a.ts'] })
    const gate = permissions.gateTool({
      turnId: TURN,
      toolName: 'apply_approved_patch',
      permissionKey: 'fileWrites',
      requiresApproval: true,
      paths: ['/repo/other.ts']
    })
    expect(gate.decision).toBe('ask')
    expect(gate.autoApproved).toBe(false)
  })

  it('asks again once the grant is exhausted', () => {
    const permissions = new PermissionService(settingsWith({ mode: 'assist' }) as never)
    permissions.grantAfterApproval({ turnId: TURN, toolName: 'run_approved_command', command: CMD })
    const call = () =>
      permissions.gateTool({
        turnId: TURN,
        toolName: 'run_approved_command',
        permissionKey: 'terminal',
        requiresApproval: true,
        command: CMD
      })
    expect(call().autoApproved).toBe(true)
    expect(call().autoApproved).toBe(true)
    expect(call().autoApproved).toBe(true)
    const spent = call()
    expect(spent.decision).toBe('ask')
    expect(spent.autoApproved).toBe(false)
    expect(spent.reason).toBe('exhausted')
  })

  it('never lifts an explicit deny', () => {
    // chat mode denies every mutating capability outright.
    const permissions = new PermissionService(settingsWith({ mode: 'chat' }) as never)
    permissions.grantAfterApproval({ turnId: TURN, toolName: 'run_approved_command', command: CMD })
    const gate = permissions.gateTool({
      turnId: TURN,
      toolName: 'run_approved_command',
      permissionKey: 'terminal',
      requiresApproval: true,
      command: CMD
    })
    expect(gate).toMatchObject({ decision: 'deny', autoApproved: false })
  })

  it('never lifts a deny on sensitive files', () => {
    const permissions = new PermissionService(settingsWith({ mode: 'agent', sensitiveFiles: 'deny' }) as never)
    permissions.grantAfterApproval({ turnId: TURN, toolName: 'apply_approved_patch', paths: ['/repo/.env'] })
    const gate = permissions.gateTool({
      turnId: TURN,
      toolName: 'apply_approved_patch',
      permissionKey: 'sensitiveFiles',
      requiresApproval: true,
      paths: ['/repo/.env']
    })
    expect(gate.decision).toBe('deny')
  })

  it('leaves a plain allow alone — no grant needed, none consumed', () => {
    const permissions = new PermissionService(settingsWith({ mode: 'agent' }) as never)
    permissions.grantAfterApproval({ turnId: TURN, toolName: 'run_approved_command', command: CMD })
    const gate = permissions.gateTool({
      turnId: TURN,
      toolName: 'read_project_file',
      permissionKey: 'read',
      requiresApproval: false
    })
    expect(gate).toMatchObject({ decision: 'allow', autoApproved: false })
    expect(permissions.activeGrants()[0].attemptsLeft).toBe(MAX_GRANT_ATTEMPTS)
  })

  it('refuses to grant anything for a non-grantable tool', () => {
    const permissions = new PermissionService(settingsWith({ mode: 'assist' }) as never)
    expect(
      permissions.grantAfterApproval({ turnId: TURN, toolName: 'delete_file', paths: ['/repo/a.ts'] })
    ).toBeNull()
    expect(permissions.activeGrants()).toEqual([])
  })

  it('revokes grants when a turn ends and on the kill-switch', () => {
    const permissions = new PermissionService(settingsWith({ mode: 'assist' }) as never)
    permissions.grantAfterApproval({ turnId: TURN, toolName: 'run_approved_command', command: CMD })
    permissions.grantAfterApproval({ turnId: 'turn-2', toolName: 'run_approved_command', command: CMD })
    expect(permissions.revokeTurnGrants(TURN)).toBe(1)
    expect(permissions.activeGrants()).toHaveLength(1)
    expect(permissions.revokeAllGrants()).toBe(1)
    expect(permissions.activeGrants()).toEqual([])
  })
})
