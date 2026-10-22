/**
 * Session-scoped grants ("Option A") for the self-healing and swarm re-run loops.
 *
 * The problem this solves: `apply_approved_patch` and `run_approved_command`
 * declare `requiresApproval: true`, and `toolNeedsApproval` re-prompts even when
 * the mode is `allow`. A repair loop therefore stopped on its first retry, which
 * made "autonomous self-healing" impossible without weakening the gate.
 *
 * A grant is the narrow middle ground. It records that the user approved one
 * *specific* thing — this exact command, or an edit to this exact file — and
 * permits only that same thing to proceed without a second dialog, at most
 * `MAX_GRANT_ATTEMPTS` times, and only inside the turn that issued it.
 *
 * Deliberate limits, all of them load-bearing:
 *  - exact command match after whitespace normalisation. No prefixes, no
 *    substring matching: `npm test` must never authorise `npm test; rm -rf ~`.
 *  - exact file paths, not directory containment. Approving a patch to
 *    `src/a.ts` says nothing about `src/b.ts`.
 *  - `deny` always wins. A grant can turn `ask` into `allow`; it can never turn
 *    `deny` into anything.
 *  - bounded by attempts *and* by the turn. A grant that outlived its turn would
 *    be a standing permission the user never gave.
 *
 * Pure module: no Electron, no DB, so the rules are unit-testable.
 */

export type GrantableTool = 'apply_approved_patch' | 'run_approved_command'

export const GRANTABLE_TOOLS: readonly GrantableTool[] = ['apply_approved_patch', 'run_approved_command']

/** Hard ceiling on automated retries per grant. */
export const MAX_GRANT_ATTEMPTS = 3

/**
 * Wall-clock backstop. The grant is revoked when its turn ends; this only stops
 * a leaked grant from surviving a turn that never finished cleanly.
 */
export const DEFAULT_GRANT_TTL_MS = 15 * 60_000

export interface SessionGrant {
  id: string
  /** The user turn (chat request id) that issued this grant. */
  turnId: string
  tool: GrantableTool
  /** Exact verification command, normalised. Null for patch grants. */
  command: string | null
  /** Exact target file paths, normalised. Empty for command grants. */
  paths: string[]
  attemptsLeft: number
  issuedAt: number
  expiresAt: number
}

export interface GrantRequest {
  turnId: string
  toolName: string
  /** Present for `run_approved_command`. */
  command?: string | null
  /** Present for `apply_approved_patch`: the proposal's resolved path. */
  paths?: string[]
  now?: number
}

export type GrantMissReason =
  | 'no-grant'
  | 'other-tool'
  | 'other-turn'
  | 'command-mismatch'
  | 'path-mismatch'
  | 'expired'
  | 'exhausted'

export type GrantMatch =
  | { matched: true; grant: SessionGrant; attemptsLeft: number }
  | { matched: false; reason: GrantMissReason }

/**
 * Collapse whitespace so `npm  test` and `npm test ` are the same approval.
 * Nothing else is forgiven: quoting, flags and order must match exactly.
 */
export function normalizeCommand(command: string): string {
  return command.replace(/\s+/g, ' ').trim()
}

/**
 * Canonical form for comparison only — never used to build a path that is then
 * opened. Separators are unified and Windows/macOS compare case-insensitively.
 */
export function normalizePath(input: string): string {
  const trimmed = input.replace(/\0/g, '').trim()
  if (!trimmed) return ''
  let value = trimmed.replace(/\\/g, '/')
  // Collapse `/.` and `//` without importing node:path, so this stays pure.
  value = value.replace(/\/{2,}/g, '/')
  value = value.replace(/\/\.\//g, '/').replace(/\/\.$/, '')
  const caseInsensitive = process.platform === 'win32' || process.platform === 'darwin'
  if (caseInsensitive) value = value.toLowerCase()
  if (value.length > 1 && value.endsWith('/')) value = value.replace(/\/+$/, '')
  return value
}

/** True when the same file is named, by canonical comparison. */
export function samePath(a: string, b: string): boolean {
  const left = normalizePath(a)
  const right = normalizePath(b)
  return left !== '' && left === right
}

export interface GrantRegistryDeps {
  now?: () => number
  /** Injectable so tests can prove the id is not guessable-sensitive. */
  idFactory?: () => string
}

/**
 * Holds the live grants. Small enough that a linear scan is the right structure:
 * there are never more than a handful, and ordering makes the intent obvious.
 */
export class SessionGrantRegistry {
  private grants: SessionGrant[] = []
  private now: () => number
  private idFactory: () => string

  constructor(deps: GrantRegistryDeps = {}) {
    this.now = deps.now ?? (() => Date.now())
    this.idFactory = deps.idFactory ?? (() => `g_${Math.random().toString(36).slice(2, 10)}`)
  }

  /**
   * Issue a grant after a user explicitly approved something.
   *
   * Returns null when the call has nothing to bind to — a grant with no command
   * and no paths would authorise anything, which is precisely what this feature
   * must never do.
   */
  issue(input: {
    turnId: string
    tool: GrantableTool
    command?: string | null
    paths?: string[]
    attempts?: number
    ttlMs?: number
  }): SessionGrant | null {
    if (!input.turnId) return null
    if (!GRANTABLE_TOOLS.includes(input.tool)) return null
    const command = input.command ? normalizeCommand(input.command) : null
    const paths = (input.paths ?? []).map(normalizePath).filter(Boolean)
    if (!command && paths.length === 0) return null

    // One live grant per (turn, tool, binding): re-approving refreshes rather
    // than stacking, so a user cannot accumulate an unbounded retry budget by
    // approving the same command repeatedly.
    const existing = this.grants.find(
      (grant) =>
        grant.turnId === input.turnId &&
        grant.tool === input.tool &&
        (command ? grant.command === command : paths.some((p) => grant.paths.includes(p)))
    )
    const now = this.now()
    const ttl = Math.max(input.ttlMs ?? DEFAULT_GRANT_TTL_MS, 0)
    const attempts = Math.min(Math.max(input.attempts ?? MAX_GRANT_ATTEMPTS, 1), MAX_GRANT_ATTEMPTS)
    if (existing) {
      existing.attemptsLeft = attempts
      existing.expiresAt = now + ttl
      existing.issuedAt = now
      return existing
    }
    const grant: SessionGrant = {
      id: this.idFactory(),
      turnId: input.turnId,
      tool: input.tool,
      command,
      paths,
      attemptsLeft: attempts,
      issuedAt: now,
      expiresAt: now + ttl
    }
    this.grants.push(grant)
    return grant
  }

  /**
   * Decide whether a tool call is covered. Never mutates: callers consume
   * explicitly, so a rejected approval cannot silently burn an attempt.
   */
  match(request: GrantRequest): GrantMatch {
    const now = request.now ?? this.now()
    if (!GRANTABLE_TOOLS.includes(request.toolName as GrantableTool)) {
      return { matched: false, reason: 'other-tool' }
    }
    const grant = this.grants.find(
      (candidate) => candidate.tool === request.toolName && candidate.turnId === request.turnId
    )
    if (!grant) return { matched: false, reason: 'no-grant' }
    if (grant.expiresAt <= now) return { matched: false, reason: 'expired' }
    if (grant.attemptsLeft <= 0) return { matched: false, reason: 'exhausted' }

    if (grant.command !== null) {
      const requested = request.command ? normalizeCommand(request.command) : ''
      if (!requested || requested !== grant.command) return { matched: false, reason: 'command-mismatch' }
    }

    if (grant.paths.length > 0) {
      const requested = (request.paths ?? []).map(normalizePath).filter(Boolean)
      if (requested.length === 0) return { matched: false, reason: 'path-mismatch' }
      // Every target must be covered. A patch that touches one approved file and
      // one unapproved file is not "covered", it is a new request.
      const covered = requested.every((path) => grant.paths.includes(path))
      if (!covered) return { matched: false, reason: 'path-mismatch' }
    }

    return { matched: true, grant, attemptsLeft: grant.attemptsLeft }
  }

  /** Spend one attempt. Returns the remaining count, or null if not matched. */
  consume(request: GrantRequest): number | null {
    const result = this.match(request)
    if (!result.matched) return null
    result.grant.attemptsLeft = Math.max(0, result.grant.attemptsLeft - 1)
    return result.grant.attemptsLeft
  }

  /** Drop every grant issued by a turn. Called when the turn finishes. */
  revokeTurn(turnId: string): number {
    const before = this.grants.length
    this.grants = this.grants.filter((grant) => grant.turnId !== turnId)
    return before - this.grants.length
  }

  /** Kill-switch: drop everything. */
  revokeAll(): number {
    const count = this.grants.length
    this.grants = []
    return count
  }

  /** Expire in place and report how many were removed. */
  prune(now = this.now()): number {
    const before = this.grants.length
    this.grants = this.grants.filter((grant) => grant.expiresAt > now && grant.attemptsLeft > 0)
    return before - this.grants.length
  }

  list(): SessionGrant[] {
    return this.grants.map((grant) => ({ ...grant, paths: [...grant.paths] }))
  }

  get size(): number {
    return this.grants.length
  }
}
