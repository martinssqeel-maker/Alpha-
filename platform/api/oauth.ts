import { SignJWT, createRemoteJWKSet, jwtVerify } from 'jose'
import { allowedOrigins, getEnv, requireEnv } from './env'

// Google Sign-In, server side.
//
// The browser never sees the client secret and never receives a long-lived
// session token in a URL. The Function owns the whole dance:
//
//   GET /auth/google/start    -> 302 to Google (signed `state`, no server storage)
//   GET /auth/google/callback -> verifies the id_token, links the identity,
//                                then redirects back with a *single-use* code
//   POST /auth/oauth/exchange -> swaps that code for session tokens
//
// A desktop target instead redirects to the app's existing `alpha://auth/callback`
// magic-link shape, so the installed app needs no change to sign in with Google.
//
// GitHub sign-in works the same way, with one provider-specific difference: a
// GitHub OAuth App returns no `id_token`, so identity is read from
// `GET /user` + `GET /user/emails`. GitHub's own docs are explicit that the OAuth
// App token exchange requires the client secret ("You must include the client
// secret in your native application"), so the desktop app must never run this
// flow itself — the Function owns it and returns the app to `alpha://auth/callback`.
const ISSUER = 'alpha-platform'
const STATE_AUDIENCE = 'alpha-oauth-state'
const STATE_TTL = '10m'

const GOOGLE_AUTHORIZE = 'https://accounts.google.com/o/oauth2/v2/auth'
const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token'
const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com']
const GOOGLE_JWKS = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'), {
  cooldownDuration: 30_000,
  timeoutDuration: 10_000
})

// GitHub REST API. A valid User-Agent is mandatory: GitHub rejects requests
// that omit it.
const GITHUB_API = 'https://api.github.com'
const GITHUB_USER_AGENT = 'alpha-platform-api'
const GITHUB_API_VERSION = '2022-11-28'

/**
 * Sign-in scope, deliberately kept to identity only. `repo` is NOT requested, so
 * signing in to Alpha AI Workspace can never grant repository access — that stays
 * a separate, explicit "Connect GitHub" action in the desktop app.
 */
export const GITHUB_SIGNIN_SCOPE = 'read:user user:email'

export const OAUTH_STATE_COOKIE = 'alpha_oauth_state'

function secretKey(): Uint8Array {
  return new TextEncoder().encode(requireEnv('AUTH_JWT_SECRET'))
}

export function googleClientId(): string | undefined {
  return getEnv('GOOGLE_CLIENT_ID')
}

export function googleClientSecret(): string | undefined {
  return getEnv('GOOGLE_CLIENT_SECRET')
}

/** Google is only offered once both credentials exist on the Function. */
export function googleConfigured(): boolean {
  return Boolean(googleClientId() && googleClientSecret())
}

/** What the website/admin UI may show. `otp` stays true: it is the existing path. */
export function providersSummary(): {
  google: boolean
  github: boolean
  password: boolean
  otp: boolean
} {
  return { google: googleConfigured(), github: githubConfigured(), password: true, otp: true }
}

export function appScheme(): string {
  const cleaned = (getEnv('AUTH_APP_SCHEME') ?? 'alpha').toLowerCase().replace(/[^a-z0-9+.-]/g, '')
  return cleaned || 'alpha'
}

export function appCallbackUrl(): string {
  return `${appScheme()}://auth/callback`
}

/** Origins a web sign-in may return to: the account site plus any allowed origin. */
export function webOrigins(): string[] {
  const out = new Set<string>()
  const account = getEnv('WEB_ACCOUNT_URL')
  if (account) {
    try {
      out.add(new URL(account).origin)
    } catch {
      /* ignore a malformed value */
    }
  }
  const allowed = allowedOrigins()
  if (allowed !== '*') {
    for (const entry of allowed) {
      try {
        out.add(new URL(entry).origin)
      } catch {
        /* ignore */
      }
    }
  }
  return [...out]
}

export type OAuthTarget = { kind: 'web' | 'app'; url: string }

/**
 * Validate a requested return target. Anything not on a known origin, or not the
 * app's own callback, is refused — otherwise the sign-in endpoint becomes an
 * open redirect that hands one-time codes to an attacker's host.
 */
export function resolveTarget(raw: string | null | undefined): OAuthTarget | null {
  const value = (raw ?? '').trim()
  if (!value) return null

  const base = appCallbackUrl()
  if (value.startsWith(`${appScheme()}://`)) {
    const withoutQuery = value.split(/[?#]/)[0]
    return withoutQuery === base ? { kind: 'app', url: base } : null
  }

  let url: URL
  try {
    url = new URL(value)
  } catch {
    return null
  }
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1'
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) return null
  const origins = webOrigins()
  if (origins.length === 0) return null
  if (!origins.includes(url.origin)) return null
  return { kind: 'web', url: `${url.origin}${url.pathname}${url.search}` }
}

export interface OAuthState {
  kind: 'web' | 'app'
  url: string
  nonce: string
}

export async function signState(state: OAuthState): Promise<string> {
  return new SignJWT({ r: state.url, k: state.kind, n: state.nonce })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(ISSUER)
    .setAudience(STATE_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(STATE_TTL)
    .sign(secretKey())
}

export async function verifyState(token: string): Promise<OAuthState | null> {
  try {
    const { payload } = await jwtVerify(token, secretKey(), {
      issuer: ISSUER,
      audience: STATE_AUDIENCE
    })
    const kind = payload.k === 'app' ? 'app' : payload.k === 'web' ? 'web' : null
    if (!kind) return null
    if (typeof payload.r !== 'string' || !payload.r) return null
    if (typeof payload.n !== 'string' || !payload.n) return null
    return { kind, url: payload.r, nonce: payload.n }
  } catch {
    return null
  }
}

export function googleAuthUrl(options: {
  state: string
  redirectUri: string
  nonce: string
  loginHint?: string
}): string {
  const url = new URL(GOOGLE_AUTHORIZE)
  url.searchParams.set('client_id', googleClientId() ?? '')
  url.searchParams.set('redirect_uri', options.redirectUri)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('scope', 'openid email profile')
  url.searchParams.set('state', options.state)
  url.searchParams.set('nonce', options.nonce)
  url.searchParams.set('prompt', 'select_account')
  if (options.loginHint) url.searchParams.set('login_hint', options.loginHint)
  return url.toString()
}

/** Exchange the authorization code for Google's tokens and return the id_token. */
export async function exchangeGoogleCode(code: string, redirectUri: string): Promise<string> {
  const body = new URLSearchParams({
    code,
    client_id: googleClientId() ?? '',
    client_secret: googleClientSecret() ?? '',
    redirect_uri: redirectUri,
    grant_type: 'authorization_code'
  })
  const res = await fetch(GOOGLE_TOKEN, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body
  })
  const text = await res.text().catch(() => '')
  if (!res.ok) {
    throw new Error(`google_exchange_failed:${res.status}:${text.slice(0, 200)}`)
  }
  let parsed: { id_token?: string }
  try {
    parsed = JSON.parse(text) as { id_token?: string }
  } catch {
    throw new Error('google_exchange_failed:unparseable_response')
  }
  if (!parsed.id_token) throw new Error('google_exchange_failed:no_id_token')
  return parsed.id_token
}

export interface GoogleIdentity {
  subject: string
  email: string
  emailVerified: boolean
  name?: string
}

/**
 * Verify Google's id_token against its published keys: issuer, audience, nonce
 * and email verification are all checked here. Returns null on any failure.
 */
export async function verifyGoogleIdToken(
  idToken: string,
  nonce: string
): Promise<GoogleIdentity | null> {
  const clientId = googleClientId()
  if (!clientId) return null
  try {
    const { payload } = await jwtVerify(idToken, GOOGLE_JWKS, {
      issuer: GOOGLE_ISSUERS,
      audience: clientId
    })
    if (typeof payload.nonce !== 'string' || payload.nonce !== nonce) return null
    const email = typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : ''
    if (!email || typeof payload.sub !== 'string') return null
    const verified = payload.email_verified === true || payload.email_verified === 'true'
    return {
      subject: payload.sub,
      email,
      emailVerified: verified,
      name: typeof payload.name === 'string' ? payload.name : undefined
    }
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// GitHub sign-in (server-side authorization code flow)
// ---------------------------------------------------------------------------

export function githubClientId(): string | undefined {
  return getEnv('GITHUB_CLIENT_ID')
}

export function githubClientSecret(): string | undefined {
  return getEnv('GITHUB_CLIENT_SECRET')
}

/** GitHub is only offered once both credentials exist on the Function. */
export function githubConfigured(): boolean {
  return Boolean(githubClientId() && githubClientSecret())
}

export function githubAuthUrl(options: { state: string; redirectUri: string }): string {
  const url = new URL('https://github.com/login/oauth/authorize')
  url.searchParams.set('client_id', githubClientId() ?? '')
  url.searchParams.set('redirect_uri', options.redirectUri)
  url.searchParams.set('scope', GITHUB_SIGNIN_SCOPE)
  // GitHub echoes this back unchanged; it is the same signed state Google uses.
  url.searchParams.set('state', options.state)
  // "Sign in or sign up" — sign-in must also serve first-time users.
  url.searchParams.set('allow_signup', 'true')
  return url.toString()
}

/**
 * Exchange the authorization code for an access token.
 *
 * GitHub answers 200 with an `error` field for several failures, so the body is
 * inspected rather than the status code alone.
 */
export async function exchangeGithubCode(code: string, redirectUri: string): Promise<string> {
  const res = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/x-www-form-urlencoded',
      'user-agent': GITHUB_USER_AGENT
    },
    body: new URLSearchParams({
      client_id: githubClientId() ?? '',
      client_secret: githubClientSecret() ?? '',
      code,
      redirect_uri: redirectUri
    })
  })
  const text = await res.text().catch(() => '')
  let parsed: { access_token?: string; error?: string; error_description?: string }
  try {
    parsed = JSON.parse(text) as typeof parsed
  } catch {
    throw new Error(`github_exchange_failed:unparseable_response:${text.slice(0, 120)}`)
  }
  if (parsed.error) {
    throw new Error(`github_exchange_failed:${parsed.error}:${parsed.error_description ?? ''}`)
  }
  if (!res.ok || !parsed.access_token) {
    throw new Error(`github_exchange_failed:${res.status}:no_access_token`)
  }
  return parsed.access_token
}

/** The subset of GitHub's payloads this flow depends on. */
export interface GithubProfile {
  id?: number | string
  login?: string
  name?: string | null
}

export interface GithubEmail {
  email?: string
  primary?: boolean
  verified?: boolean
}

export interface GithubIdentity {
  subject: string
  login: string
  email: string
  emailVerified: boolean
  name?: string
}

/**
 * Derive an identity from GitHub's payloads.
 *
 * Only a VERIFIED address is accepted, so an unverified email can never be used
 * to reach an existing Alpha AI Workspace account. The subject is GitHub's
 * numeric user id, which is stable and never reused — unlike the login handle,
 * which a user may rename or give up.
 */
export function toGithubIdentity(
  profile: GithubProfile | null,
  emails: GithubEmail[] | null
): GithubIdentity | null {
  if (!profile || profile.id === undefined || profile.id === null) return null
  const subject = String(profile.id).trim()
  if (!subject) return null

  const list = Array.isArray(emails) ? emails : []
  const verified = list.filter(
    (entry): entry is GithubEmail & { email: string } =>
      Boolean(entry) && entry.verified === true && typeof entry.email === 'string' && entry.email.includes('@')
  )
  const chosen = verified.find((entry) => entry.primary === true) ?? verified[0]
  if (!chosen) return null

  const name = typeof profile.name === 'string' && profile.name.trim() ? profile.name.trim() : undefined
  return {
    subject,
    login: typeof profile.login === 'string' ? profile.login : '',
    email: chosen.email.trim().toLowerCase(),
    emailVerified: true,
    name
  }
}

async function githubGetJson<T>(path: string, accessToken: string): Promise<T | null> {
  const res = await fetch(`${GITHUB_API}${path}`, {
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${accessToken}`,
      'user-agent': GITHUB_USER_AGENT,
      'x-github-api-version': GITHUB_API_VERSION
    }
  })
  if (!res.ok) return null
  try {
    return (await res.json()) as T
  } catch {
    return null
  }
}

/** Read the authenticated user's profile and verified addresses. */
export async function fetchGithubIdentity(accessToken: string): Promise<GithubIdentity | null> {
  const profile = await githubGetJson<GithubProfile>('/user', accessToken)
  if (!profile) return null
  const emails = await githubGetJson<GithubEmail[]>('/user/emails', accessToken)
  return toGithubIdentity(profile, emails)
}
