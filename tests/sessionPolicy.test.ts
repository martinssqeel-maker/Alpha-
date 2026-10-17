import { describe, expect, it } from 'vitest'
import { sessionState } from '../platform/api/sessions'

// The dashboard offers "revoke" as a security control, so the rule that decides
// whether a session token still works has to be unambiguous. These are the cases
// the route, refresh and middleware all depend on.
describe('session liveness', () => {
  const now = Date.parse('2026-10-17T12:00:00Z')

  it('treats a live, unrevoked session as active', () => {
    expect(sessionState({ revoked_at: null, expires_at: '2026-10-18T12:00:00Z' }, now)).toBe('active')
  })

  it('treats a revoked session as ended even before its expiry', () => {
    expect(
      sessionState({ revoked_at: '2026-10-17T11:59:00Z', expires_at: '2026-10-18T12:00:00Z' }, now)
    ).toBe('revoked')
  })

  it('treats an expired session as ended', () => {
    expect(sessionState({ revoked_at: null, expires_at: '2026-10-17T11:59:59Z' }, now)).toBe('expired')
    // Exactly at expiry is already over: half-open [created, expires) is the safe side.
    expect(sessionState({ revoked_at: null, expires_at: '2026-10-17T12:00:00Z' }, now)).toBe('expired')
  })

  it('refuses a missing row, a missing expiry or an unparseable date', () => {
    expect(sessionState(null, now)).toBe('revoked')
    expect(sessionState({ revoked_at: null }, now)).toBe('expired')
    expect(sessionState({ revoked_at: null, expires_at: 'not-a-date' }, now)).toBe('expired')
  })

  it('understands the camelCase shape used by the database function output', () => {
    expect(sessionState({ revokedAt: null, expiresAt: '2026-12-01T00:00:00Z' }, now)).toBe('active')
    expect(sessionState({ revokedAt: '2026-10-01T00:00:00Z', expiresAt: '2026-12-01T00:00:00Z' }, now)).toBe(
      'revoked'
    )
  })
})
