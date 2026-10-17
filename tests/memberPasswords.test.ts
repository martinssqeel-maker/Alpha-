import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import app from '../platform/api/index'
import { verificationProblem } from '../platform/api/releases'

/**
 * The member password surface, exercised through the real Hono app.
 *
 * Every case here is answered before any database work — validation, the
 * authorization middleware, or the pure download gate — so this file needs no
 * live database and cannot be flaky against one. The live sign-up, sign-in and
 * reset sequence is covered by `npm run verify:auth -- --with-write`, which is
 * the only place it can be proven end to end (mailbox, sessions, cleanup).
 */
beforeAll(() => {
  process.env.AUTH_JWT_SECRET = 'member-password-test-secret-long-enough'
  process.env.WEB_ACCOUNT_URL = 'https://alpha-website-lime.vercel.app'
  process.env.ALLOWED_ORIGINS = 'https://alpha-website-lime.vercel.app'
})

afterAll(() => {
  delete process.env.AUTH_JWT_SECRET
  delete process.env.WEB_ACCOUNT_URL
  delete process.env.ALLOWED_ORIGINS
})

function post(path: string, body: unknown): Promise<Response> {
  return Promise.resolve(
    app.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    })
  )
}

const GOOD_PASSWORD = 'Basalt-Harbour-314-Lantern'

describe('POST /auth/register', () => {
  it('rejects an address that is not an address', async () => {
    const res = await post('/auth/register', { email: 'not-an-email', password: GOOD_PASSWORD })
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('invalid_email')
  })

  it('reports the password rule that was actually broken, not a generic refusal', async () => {
    const res = await post('/auth/register', { email: 'someone@example.invalid', password: 'short' })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('weak_password')
    // The message comes from platform/api/password.ts and is shown verbatim.
    expect(body.error.message).toMatch(/at least 12 characters/i)
  })

  it('refuses a well-known weak phrase even at a legal length', async () => {
    const res = await post('/auth/register', {
      email: 'someone@example.invalid',
      password: 'my-password-is-here'
    })
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('weak_password')
  })

  it('refuses surrounding whitespace, so a pasted password cannot surprise its owner', async () => {
    const res = await post('/auth/register', {
      email: 'someone@example.invalid',
      password: ` ${GOOD_PASSWORD}`
    })
    expect(res.status).toBe(400)
    expect((await res.json()).error.message).toMatch(/leading or trailing spaces/i)
  })
})

describe('POST /auth/password/forgot and /reset', () => {
  it('forgot needs a valid address before it will consider sending anything', async () => {
    const res = await post('/auth/password/forgot', { email: 'nope' })
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('invalid_email')
  })

  it('reset validates the new password before touching a code', async () => {
    const res = await post('/auth/password/reset', {
      email: 'someone@example.invalid',
      code: '123456',
      password: 'short'
    })
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('weak_password')
  })

  it('reset refuses a code that is not six digits without consuming an attempt', async () => {
    const res = await post('/auth/password/reset', {
      email: 'someone@example.invalid',
      code: '12ab',
      password: GOOD_PASSWORD
    })
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('invalid_code')
  })
})

describe('POST /auth/password/change', () => {
  it('requires a live session', async () => {
    const res = await post('/auth/password/change', {
      currentPassword: 'whatever-it-was',
      newPassword: GOOD_PASSWORD
    })
    expect(res.status).toBe(401)
    expect((await res.json()).error.code).toBe('unauthorized')
  })
})

describe('GET /auth/providers', () => {
  it('still advertises password sign-in, now for members as well as operators', async () => {
    const res = await app.request('/auth/providers')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.password).toBe(true)
    for (const key of ['google', 'github', 'otp']) {
      expect(typeof body[key], `${key} must be a boolean capability`).toBe('boolean')
    }
  })
})

describe('download gate: proof of mailbox', () => {
  it('withholds the installer until the address is confirmed', () => {
    expect(verificationProblem({ email_verified_at: null })).toMatchObject({
      status: 403,
      code: 'email_unverified'
    })
  })

  it('asks nothing more of an account that has confirmed, or of one from a provider', () => {
    expect(verificationProblem({ email_verified_at: '2026-10-18T00:00:00.000Z' })).toBeNull()
    // A missing row is handled by `gatingProblem` as "not signed in"; this rule
    // must not turn it into a second, conflicting answer.
    expect(verificationProblem(null)).toBeNull()
  })
})
