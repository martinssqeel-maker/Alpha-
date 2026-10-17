import type { MiddlewareHandler } from 'hono'
import type { AppEnv } from './types'
import { withContext } from './db'

/**
 * Session liveness.
 *
 * An access token is a signed claim that a session existed when it was minted.
 * Without this check, revoking a session — from the account dashboard, by an
 * administrator, or by signing out everywhere — only stopped the *refresh* from
 * working: the stolen/lost access token kept opening the API until its own
 * expiry, up to an hour later. The dashboard would have offered "revoke" as a
 * button that did not mean what it said.
 *
 * Every authenticated router mounts this after `requireAuth`, so a session row
 * is checked once per request and revocation takes effect on the next call.
 */

export interface SessionRecord {
  revoked_at?: string | null
  revokedAt?: string | null
  expires_at?: string
  expiresAt?: string
  user_id?: string
}

export type SessionState = 'active' | 'revoked' | 'expired'

/** Decide liveness from a session row. Pure so the rule is testable. */
export function sessionState(row: SessionRecord | null | undefined, now = Date.now()): SessionState {
  if (!row) return 'revoked'
  const revoked = row.revoked_at ?? row.revokedAt ?? null
  if (revoked) return 'revoked'
  const expires = row.expires_at ?? row.expiresAt ?? null
  if (!expires) return 'expired'
  const at = new Date(expires).getTime()
  if (!Number.isFinite(at) || at <= now) return 'expired'
  return 'active'
}

/** True when the session id in the token belongs to this account and is live. */
export async function isLiveSession(userId: string, sid: string): Promise<boolean> {
  if (!userId || !sid) return false
  return withContext(userId, 'authenticated', async (q) => {
    const res = await q.query<{ revoked_at: string | null; expires_at: string }>(
      'select revoked_at, expires_at from public.sessions where id = $1 and user_id = $2',
      [sid, userId]
    )
    return sessionState(res.rows[0]) === 'active'
  })
}

export const requireLiveSession: MiddlewareHandler<AppEnv> = async (c, next) => {
  const userId = c.get('userId')
  const sid = c.get('sid')
  let live = false
  try {
    live = await isLiveSession(userId, sid)
  } catch {
    // Failing closed is the only safe answer: an unavailable database must not
    // turn "this session may have been revoked" into access.
    return c.json(
      { ok: false, error: { code: 'unavailable', message: 'Sign-in is temporarily unavailable. Try again.' } },
      503
    )
  }
  if (!live) {
    return c.json(
      { ok: false, error: { code: 'session_ended', message: 'Your session has ended. Sign in again.' } },
      401
    )
  }
  await next()
}
