import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import app from '../platform/api/index'
import { signState } from '../platform/api/oauth'

// These exercise the real Hono app rather than a helper, so a route that is wired
// to the wrong path or loses its configuration gate is caught. Every case below
// is answered before any database work (configuration gate, state verification,
// or target allow-list), so no live database is required.
const PRIME_ID = 'route-test-client-id'
const PRIME_SECRET = 'route-test-client-secret'

beforeAll(() => {
  process.env.AUTH_JWT_SECRET = 'route-test-secret-value-that-is-long-enough-32'
  process.env.WEB_ACCOUNT_URL = 'https://alpha-website-lime.vercel.app'
  process.env.ALLOWED_ORIGINS = 'https://alpha-website-lime.vercel.app'
  delete process.env.GITHUB_CLIENT_ID
  delete process.env.GITHUB_CLIENT_SECRET
})

afterAll(() => {
  delete process.env.AUTH_JWT_SECRET
  delete process.env.WEB_ACCOUNT_URL
  delete process.env.ALLOWED_ORIGINS
  delete process.env.GITHUB_CLIENT_ID
  delete process.env.GITHUB_CLIENT_SECRET
})

function useGithubCredentials(): void {
  process.env.GITHUB_CLIENT_ID = PRIME_ID
  process.env.GITHUB_CLIENT_SECRET = PRIME_SECRET
}

function clearGithubCredentials(): void {
  delete process.env.GITHUB_CLIENT_ID
  delete process.env.GITHUB_CLIENT_SECRET
}

describe('auth routes: provider capabilities', () => {
  it('reports github as unavailable until it is configured', async () => {
    clearGithubCredentials()
    const res = await app.request('/auth/providers')
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.ok).toBe(true)
    expect(body.github).toBe(false)
    // The existing paths must keep working.
    expect(body.password).toBe(true)
    expect(body.otp).toBe(true)
  })

  it('advertises github once both credentials are present', async () => {
    useGithubCredentials()
    const res = await app.request('/auth/providers')
    const body = (await res.json()) as Record<string, unknown>
    expect(body.github).toBe(true)
    clearGithubCredentials()
  })
})

describe('auth routes: /auth/github', () => {
  it('refuses to start when the deployment has no GitHub credentials', async () => {
    clearGithubCredentials()
    const res = await app.request('/auth/github/start')
    expect(res.status).toBe(503)
    const body = (await res.json()) as { error?: { code?: string } }
    expect(body.error?.code).toBe('github_not_configured')
  })

  it('rejects a callback with no signed state instead of trusting the query', async () => {
    const res = await app.request('/auth/github/callback?code=stolen-code')
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error?: { code?: string } }
    expect(body.error?.code).toBe('invalid_state')
  })

  it('rejects a forged state even when it carries an error flag', async () => {
    // If `error` were honoured before the state was verified, an attacker could
    // turn this endpoint into an open redirect.
    const res = await app.request('/auth/github/callback?state=forged.state.value&error=access_denied')
    expect(res.status).toBe(400)
  })

  it('returns a GitHub cancellation to the app instead of failing it', async () => {
    const state = await signState({ kind: 'app', url: 'alpha://auth/callback', nonce: 'n-cancel' })
    const res = await app.request(`/auth/github/callback?state=${encodeURIComponent(state)}&error=access_denied`)
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('alpha://auth/callback?error=access_denied')
  })

  it('returns a missing-code failure to the web page it came from', async () => {
    const state = await signState({
      kind: 'web',
      url: 'https://alpha-website-lime.vercel.app/account.html',
      nonce: 'n-nocode'
    })
    const res = await app.request(`/auth/github/callback?state=${encodeURIComponent(state)}`)
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe(
      'https://alpha-website-lime.vercel.app/account.html?error=missing_code'
    )
  })

  it('keeps google behaviour intact alongside the new provider', async () => {
    const res = await app.request('/auth/google/start')
    expect(res.status).toBe(503)
    const body = (await res.json()) as { error?: { code?: string } }
    expect(body.error?.code).toBe('google_not_configured')
  })
})
