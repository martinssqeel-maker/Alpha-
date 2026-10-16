import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'

// The gateway, platform and admin routers are only as protected as the
// middleware they mount. That middleware reads AUTH_JWT_SECRET at call time, so
// the test sets it before importing rather than trying to stub the module.
process.env.AUTH_JWT_SECRET = 'test-only-secret-please-never-deploy-this-value'
process.env.AUTH_ACCESS_TTL_MIN = '60'

async function protectedApp() {
  const { requireAuth } = await import('../platform/api/middleware')
  const app = new Hono()
  app.use('*', requireAuth)
  app.get('/private', (c) => c.json({ ok: true, userId: c.get('userId'), email: c.get('email') }))
  app.post('/private', (c) => c.json({ ok: true }))
  return app
}

describe('API authentication middleware', () => {
  it('refuses a request with no Authorization header', async () => {
    const app = await protectedApp()
    const res = await app.request('/private')
    expect(res.status).toBe(401)
    expect((await res.json()).error.code).toBe('unauthorized')
  })

  it('refuses an empty or malformed Authorization header', async () => {
    const app = await protectedApp()
    for (const header of ['', 'Bearer', 'Bearer ', 'Token abc', 'Bearer not-a-jwt']) {
      const res = await app.request('/private', { headers: { authorization: header } })
      expect(res.status, `header ${JSON.stringify(header)} must be refused`).toBe(401)
    }
  })

  it('refuses a token signed with a different secret', async () => {
    const app = await protectedApp()
    const { SignJWT } = await import('jose')
    const forged = await new SignJWT({ email: 'attacker@example.invalid', sid: 'x', role: 'authenticated' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('11111111-1111-1111-1111-111111111111')
      .setIssuer('alpha-platform')
      .setAudience('alpha-clients')
      .setExpirationTime('5m')
      .sign(new TextEncoder().encode('a-different-secret-entirely'))
    const res = await app.request('/private', { headers: { authorization: `Bearer ${forged}` } })
    expect(res.status).toBe(401)
  })

  it('refuses an expired token', async () => {
    const app = await protectedApp()
    const { SignJWT } = await import('jose')
    const expired = await new SignJWT({ email: 'old@example.invalid', sid: 'x', role: 'authenticated' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('22222222-2222-2222-2222-222222222222')
      .setIssuer('alpha-platform')
      .setAudience('alpha-clients')
      .setIssuedAt(Math.floor(Date.now() / 1000) - 7200)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 3600)
      .sign(new TextEncoder().encode(process.env.AUTH_JWT_SECRET as string))
    const res = await app.request('/private', { headers: { authorization: `Bearer ${expired}` } })
    expect(res.status).toBe(401)
  })

  it('accepts a validly signed session and exposes the caller to the handler', async () => {
    const app = await protectedApp()
    const { signAccessToken } = await import('../platform/api/jwt')
    const token = await signAccessToken({
      userId: '33333333-3333-3333-3333-333333333333',
      email: 'member@example.invalid',
      sid: 'session-1',
      role: 'authenticated'
    })
    const res = await app.request('/private', { headers: { authorization: `Bearer ${token}` } })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.userId).toBe('33333333-3333-3333-3333-333333333333')
    expect(body.email).toBe('member@example.invalid')
  })

  it('protects mutating verbs as well as reads', async () => {
    const app = await protectedApp()
    expect((await app.request('/private', { method: 'POST' })).status).toBe(401)
    const { signAccessToken } = await import('../platform/api/jwt')
    const token = await signAccessToken({
      userId: '44444444-4444-4444-4444-444444444444',
      email: 'member@example.invalid',
      sid: 'session-2',
      role: 'authenticated'
    })
    const res = await app.request('/private', { method: 'POST', headers: { authorization: `Bearer ${token}` } })
    expect(res.status).toBe(200)
  })
})
