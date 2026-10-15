import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import app from '../platform/api/index'
import { signState } from '../platform/api/oauth'

// These exercise the real Hono app rather than a helper, so a route that is wired
// to the wrong path or loses its configuration gate is caught. Every case below
// is answered before any database work (configuration gate, state verification,
// or target allow-list), so no live database is required.
const PRIME_ID = 'route-test-client-id'
const PRIME_SECRET = 'route-test-client-secret'
const GOOGLE_ID = 'google-route-test-client-id'
const GOOGLE_SECRET = 'google-route-test-client-secret'
/** The website account page, i.e. the web return target both providers accept. */
const SITE_ACCOUNT = 'https://alpha-website-lime.vercel.app/account'

beforeAll(() => {
  process.env.AUTH_JWT_SECRET = 'route-test-secret-value-that-is-long-enough-32'
  process.env.WEB_ACCOUNT_URL = 'https://alpha-website-lime.vercel.app'
  process.env.ALLOWED_ORIGINS = 'https://alpha-website-lime.vercel.app'
  delete process.env.GITHUB_CLIENT_ID
  delete process.env.GITHUB_CLIENT_SECRET
  delete process.env.GOOGLE_CLIENT_ID
  delete process.env.GOOGLE_CLIENT_SECRET
  delete process.env.GOOGLE_REDIRECT_URI
})

afterAll(() => {
  delete process.env.AUTH_JWT_SECRET
  delete process.env.WEB_ACCOUNT_URL
  delete process.env.ALLOWED_ORIGINS
  delete process.env.GITHUB_CLIENT_ID
  delete process.env.GITHUB_CLIENT_SECRET
  delete process.env.GOOGLE_CLIENT_ID
  delete process.env.GOOGLE_CLIENT_SECRET
  delete process.env.GOOGLE_REDIRECT_URI
})

function useGithubCredentials(): void {
  process.env.GITHUB_CLIENT_ID = PRIME_ID
  process.env.GITHUB_CLIENT_SECRET = PRIME_SECRET
}

function clearGithubCredentials(): void {
  delete process.env.GITHUB_CLIENT_ID
  delete process.env.GITHUB_CLIENT_SECRET
}

function useGoogleCredentials(): void {
  process.env.GOOGLE_CLIENT_ID = GOOGLE_ID
  process.env.GOOGLE_CLIENT_SECRET = GOOGLE_SECRET
}

function clearGoogleCredentials(): void {
  delete process.env.GOOGLE_CLIENT_ID
  delete process.env.GOOGLE_CLIENT_SECRET
}

/** The signed-in desktop app's return target: same flow, different destination. */
const APP_CALLBACK = 'alpha://auth/callback'

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

  it('advertises google once both credentials are present', async () => {
    useGoogleCredentials()
    const res = await app.request('/auth/providers')
    const body = (await res.json()) as Record<string, unknown>
    expect(body.google).toBe(true)
    clearGoogleCredentials()
  })
})

// Both providers share one completion path, so both must serve both surfaces: a
// website that gets back a single-use code, and a desktop app that gets back its
// `alpha://auth/callback` deep link. These assert the redirect the browser is
// actually sent to, including the callback that must be registered in each
// provider's console — a mismatch there is the usual cause of a failed sign-in.
describe('auth routes: provider start, both surfaces', () => {
  it('sends a website sign-in to Google with the callback the console must register', async () => {
    useGoogleCredentials()
    const res = await app.request(`/auth/google/start?redirect=${encodeURIComponent(SITE_ACCOUNT)}`)
    expect(res.status).toBe(302)

    const loc = new URL(res.headers.get('location') as string)
    expect(`${loc.origin}${loc.pathname}`).toBe('https://accounts.google.com/o/oauth2/v2/auth')
    expect(loc.searchParams.get('client_id')).toBe(GOOGLE_ID)
    expect(loc.searchParams.get('response_type')).toBe('code')
    expect(loc.searchParams.get('scope')).toBe('openid email profile')
    expect(loc.searchParams.get('prompt')).toBe('select_account')
    expect(loc.searchParams.get('redirect_uri')).toMatch(/\/auth\/google\/callback$/)
    // `state` carries the return target and `nonce` is checked against the id_token.
    expect(loc.searchParams.get('state')).toBeTruthy()
    expect(loc.searchParams.get('nonce')).toBeTruthy()
    clearGoogleCredentials()
  })

  it('sends a website sign-in to GitHub with identity-only scope', async () => {
    useGithubCredentials()
    const res = await app.request(`/auth/github/start?redirect=${encodeURIComponent(SITE_ACCOUNT)}`)
    expect(res.status).toBe(302)

    const loc = new URL(res.headers.get('location') as string)
    expect(`${loc.origin}${loc.pathname}`).toBe('https://github.com/login/oauth/authorize')
    expect(loc.searchParams.get('client_id')).toBe(PRIME_ID)
    expect(loc.searchParams.get('redirect_uri')).toMatch(/\/auth\/github\/callback$/)
    // `repo` must never appear here: signing in does not grant repository access.
    expect(loc.searchParams.get('scope')).toBe('read:user user:email')
    expect(loc.searchParams.get('state')).toBeTruthy()
    clearGithubCredentials()
  })

  it('accepts the desktop app deep link for both providers', async () => {
    useGoogleCredentials()
    useGithubCredentials()

    for (const provider of ['google', 'github'] as const) {
      const res = await app.request(`/auth/${provider}/start?redirect=${encodeURIComponent(APP_CALLBACK)}`)
      expect(res.status).toBe(302)
      // The provider still comes back to the Function, which then hands the app
      // its own magic link — the app never receives a provider token.
      const loc = new URL(res.headers.get('location') as string)
      expect(loc.searchParams.get('redirect_uri')).toMatch(new RegExp(`/auth/${provider}/callback$`))
      expect(loc.searchParams.get('client_id')).toBeTruthy()
    }

    clearGoogleCredentials()
    clearGithubCredentials()
  })

  it('refuses an untrusted return target for both providers', async () => {
    useGoogleCredentials()
    useGithubCredentials()

    for (const provider of ['google', 'github'] as const) {
      const res = await app.request(
        `/auth/${provider}/start?redirect=${encodeURIComponent('https://evil.example/steal')}`
      )
      expect(res.status).toBe(400)
      const body = (await res.json()) as { error?: { code?: string } }
      expect(body.error?.code).toBe('invalid_redirect')
    }

    clearGoogleCredentials()
    clearGithubCredentials()
  })

  it('honours an explicit redirect URI override when the derived one is wrong', async () => {
    useGoogleCredentials()
    process.env.GOOGLE_REDIRECT_URI = 'https://api.example.test/auth/google/callback'

    const res = await app.request(`/auth/google/start?redirect=${encodeURIComponent(SITE_ACCOUNT)}`)
    const loc = new URL(res.headers.get('location') as string)
    expect(loc.searchParams.get('redirect_uri')).toBe('https://api.example.test/auth/google/callback')

    delete process.env.GOOGLE_REDIRECT_URI
    clearGoogleCredentials()
  })
})

// How a failed token exchange is reported. Google rejecting the deployment's own
// client secret is a permanent server-side misconfiguration, so it must not be
// dressed up as a transient "could not be verified" the user is invited to retry.
// These drive the real routes with a stubbed provider, so the classification is
// exercised end to end without any network or database access.
describe('auth routes: provider exchange failures are classified', () => {
  const realFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = realFetch
    clearGoogleCredentials()
  })

  function stubProvider(status: number, body: unknown): void {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' }
      })) as unknown as typeof fetch
  }

  it('reports a rejected Google client secret as a misconfiguration, not a retry', async () => {
    useGoogleCredentials()
    stubProvider(401, {
      error: 'invalid_client',
      error_description: 'The provided client secret is invalid.'
    })
    const state = await signState({ kind: 'web', url: SITE_ACCOUNT, nonce: 'n-misconfigured' })

    const res = await app.request(`/auth/google/callback?state=${encodeURIComponent(state)}&code=abc123`)
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe(`${SITE_ACCOUNT}?error=google_misconfigured`)
  })

  it('still reports a genuine identity failure as a verification failure', async () => {
    useGoogleCredentials()
    // A 200 carrying an unusable id_token: the exchange succeeded, so this is not
    // a credential problem and must keep the original code.
    stubProvider(200, { access_token: 'x', id_token: 'not-a-real-jwt' })
    const state = await signState({ kind: 'web', url: SITE_ACCOUNT, nonce: 'n-unverifiable' })

    const res = await app.request(`/auth/google/callback?state=${encodeURIComponent(state)}&code=abc123`)
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe(`${SITE_ACCOUNT}?error=google_verification_failed`)
  })

  it('classifies a rejected GitHub client the same way', async () => {
    useGithubCredentials()
    stubProvider(200, { error: 'incorrect_client_credentials' })
    const state = await signState({ kind: 'app', url: APP_CALLBACK, nonce: 'n-gh-misconfigured' })

    const res = await app.request(`/auth/github/callback?state=${encodeURIComponent(state)}&code=abc123`)
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe(`${APP_CALLBACK}?error=github_misconfigured`)
    clearGithubCredentials()
  })
})
