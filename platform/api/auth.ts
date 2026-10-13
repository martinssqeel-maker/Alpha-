import { Hono } from 'hono'
import type { AppEnv } from './types'
import { withContext } from './db'
import { boolEnv, getEnv, intEnv } from './env'
import { generateCode, generateToken, hashSecret, safeEqual } from './crypto'
import { sendOtpEmail } from './email'
import { accessTtlMs, refreshTtlMs, signAccessToken } from './jwt'
import { requireAuth } from './middleware'
import { hashPassword, verifyPassword } from './password'
import {
  appCallbackUrl,
  exchangeGoogleCode,
  googleAuthUrl,
  googleConfigured,
  providersSummary,
  resolveTarget,
  signState,
  verifyGoogleIdToken,
  verifyState
} from './oauth'
import type { GoogleIdentity } from './oauth'
import { maintenanceProblem, maintenanceState } from './maintenance'

export const authRoutes = new Hono<AppEnv>()

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/

interface OtpRow {
  id: string
  email: string
  code_hash: string
  magic_hash: string
  attempts: number
  expires_at: string
  consumed_at: string | null
}

function requestIp(c: { req: { header: (n: string) => string | undefined } }): string | null {
  return c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || c.req.header('x-real-ip') || null
}

/**
 * Create a refresh session and sign the access token. Every sign-in path (OTP,
 * Google, administrator password) funnels through here, so the desktop app and
 * the website always receive exactly the same session shape for a given user.
 */
async function mintSession(
  uid: string,
  email: string,
  userAgent: string | null,
  ip: string | null
): Promise<{ accessToken: string; refreshToken: string; expiresAt: number; email: string }> {
  const refresh = generateToken(32)
  const sid = await withContext(uid, 'authenticated', async (q) => {
    const res = await q.query<{ id: string }>(
      `insert into public.sessions (user_id, refresh_hash, expires_at, user_agent, ip)
       values ($1, $2, $3, $4, $5) returning id`,
      [uid, hashSecret(refresh), new Date(Date.now() + refreshTtlMs()).toISOString(), userAgent, ip]
    )
    await q.query('update public.users set last_sign_in_at = now() where id = $1', [uid])
    return res.rows[0].id
  })
  const accessToken = await signAccessToken({ userId: uid, email, sid, role: 'authenticated' })
  return { accessToken, refreshToken: refresh, expiresAt: Date.now() + accessTtlMs(), email }
}

/** Record one login attempt for throttling. */
async function recordAttempt(scope: string, key: string, succeeded: boolean): Promise<void> {
  await withContext(null, 'anon', async (q) => {
    await q.query('insert into public.auth_attempts (scope, key, succeeded) values ($1, $2, $3)', [
      scope,
      key,
      succeeded
    ])
  })
}

/** True when `key` has already failed `max` times inside the window. */
async function tooManyAttempts(
  scope: string,
  key: string,
  max: number,
  windowMinutes: number
): Promise<boolean> {
  return withContext(null, 'anon', async (q) => {
    const row = (
      await q.query<{ count: string }>(
        `select count(*)::text as count from public.auth_attempts
          where scope = $1 and key = $2 and not succeeded
            and created_at > now() - make_interval(mins => $3::int)`,
        [scope, key, windowMinutes]
      )
    ).rows[0]
    return Number.parseInt(row?.count ?? '0', 10) >= max
  })
}

/**
 * A real digest to verify against when an account, credential or admin role is
 * missing, so a failed login costs the same work as a successful one. Computed
 * once per isolate rather than at import time.
 */
let dummyDigest: string | null = null
function dummyHash(): string {
  // A genuine digest for a random unknown value: verifying against it runs the
  // full scrypt cost and can never match, so a missing account and a wrong
  // password take the same time to reject.
  if (!dummyDigest) dummyDigest = hashPassword(generateToken(24))
  return dummyDigest
}

function googleRedirectUri(c: { req: { url: string } }): string {
  const configured = getEnv('GOOGLE_REDIRECT_URI')
  if (configured) return configured
  try {
    return `${new URL(c.req.url).origin}/auth/google/callback`
  } catch {
    const base = (getEnv('NEON_FUNCTION_API_BASE_URL') ?? '').replace(/\/+$/, '')
    return `${base}/auth/google/callback`
  }
}

function withParams(base: string, params: Record<string, string>): string {
  const url = new URL(base)
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value)
  return url.toString()
}

authRoutes.post('/request', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { email?: string }
  const email = (body.email ?? '').trim().toLowerCase()
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return c.json({ ok: false, error: { code: 'invalid_email', message: 'Enter a valid email address.' } }, 400)
  }

  // While maintenance mode is on, ordinary sign-ins are refused with an
  // explanation. The password path still works for administrators (below).
  const maintenance = maintenanceProblem(await maintenanceState(), false)
  if (maintenance) {
    return c.json({ ok: false, error: { code: maintenance.code, message: maintenance.message } }, 503)
  }

  const ttlMinutes = intEnv('AUTH_OTP_TTL_MIN', 10)
  const code = generateCode()
  const magic = generateToken(32)
  const codeHash = hashSecret(code)
  const magicHash = hashSecret(magic)
  const ip = requestIp(c)
  const userAgent = c.req.header('user-agent') ?? null

  await withContext(null, 'anon', async (q) => {
    await q.query('update public.auth_otps set consumed_at = now() where email = $1 and consumed_at is null', [email])
    await q.query(
      `insert into public.auth_otps (email, code_hash, magic_hash, expires_at, ip, user_agent)
       values ($1, $2, $3, now() + make_interval(mins => $4::int), $5, $6)`,
      [email, codeHash, magicHash, ttlMinutes, ip, userAgent]
    )
  })

  const webUrl = (getEnv('WEB_ACCOUNT_URL') ?? '').replace(/\/+$/, '')
  const magicUrl = webUrl
    ? `${webUrl}/account.html?email=${encodeURIComponent(email)}&token=${encodeURIComponent(magic)}`
    : `alpha://auth/callback?email=${encodeURIComponent(email)}&token=${encodeURIComponent(magic)}`

  await sendOtpEmail({ to: email, code, magicUrl, expiresMinutes: ttlMinutes })

  const payload: Record<string, unknown> = {
    ok: true,
    message: `We sent a sign-in code to ${email}.`,
    expiresInMinutes: ttlMinutes
  }
  // Dev-only convenience: echo the freshly minted code/token so a local UI can be
  // driven without reading the mail log. Gated on NODE_ENV as well as the flag,
  // because a deployed Function is reachable by anyone and would otherwise hand
  // out a valid sign-in token for an arbitrary email address.
  if (boolEnv('AUTH_DEV_ECHO_OTP') && getEnv('NODE_ENV') === 'development') {
    payload.devCode = code
    payload.devMagicToken = magic
  }
  return c.json(payload)
})

authRoutes.post('/verify', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { email?: string; code?: string; token?: string }
  const email = (body.email ?? '').trim().toLowerCase()
  const code = (body.code ?? '').trim()
  const token = (body.token ?? '').trim()
  if (!token && !(email && code)) {
    return c.json({ ok: false, error: { code: 'invalid_request', message: 'Provide an email + code, or a token.' } }, 400)
  }

  const maxAttempts = intEnv('AUTH_MAX_ATTEMPTS', 6)
  const userAgent = c.req.header('user-agent') ?? null
  const ip = requestIp(c)

  const result = await withContext(null, 'anon', async (q) => {
    const row = (
      token
        ? await q.query<OtpRow>(
            `select id, email, code_hash, magic_hash, attempts, expires_at, consumed_at
               from public.auth_otps where magic_hash = $1 and consumed_at is null
              order by created_at desc limit 1`,
            [hashSecret(token)]
          )
        : await q.query<OtpRow>(
            `select id, email, code_hash, magic_hash, attempts, expires_at, consumed_at
               from public.auth_otps where email = $1 and consumed_at is null
              order by created_at desc limit 1`,
            [email]
          )
    ).rows[0]

    if (!row) return { ok: false as const, error: 'invalid_code' as const }
    if (new Date(row.expires_at).getTime() < Date.now()) {
      return { ok: false as const, error: 'expired' as const }
    }
    if (row.attempts >= maxAttempts) return { ok: false as const, error: 'too_many' as const }

    const matches = token
      ? safeEqual(hashSecret(token), row.magic_hash)
      : safeEqual(hashSecret(code), row.code_hash)
    if (!matches) {
      await q.query('update public.auth_otps set attempts = attempts + 1 where id = $1', [row.id])
      return { ok: false as const, error: 'invalid_code' as const }
    }

    await q.query('update public.auth_otps set consumed_at = now() where id = $1', [row.id])
    // provision_user is idempotent: creates the user, ensures a free subscription,
    // and grants owner role when the email matches bootstrap_admin_email.
    const uid = (await q.query<{ id: string }>('select public.provision_user($1) as id', [row.email])).rows[0].id
    const user = (await q.query<{ email: string }>('select email from public.users where id = $1', [uid])).rows[0]

    const refresh = generateToken(32)
    const sid = (
      await q.query<{ id: string }>(
        `insert into public.sessions (user_id, refresh_hash, expires_at, user_agent, ip)
         values ($1, $2, $3, $4, $5) returning id`,
        [uid, hashSecret(refresh), new Date(Date.now() + refreshTtlMs()).toISOString(), userAgent, ip]
      )
    ).rows[0].id

    return { ok: true as const, uid, email: user?.email ?? row.email, sid, refresh }
  })

  if (!result.ok) {
    const map = {
      invalid_code: { status: 400, code: 'invalid_code', message: 'That code is not correct.' },
      expired: { status: 400, code: 'expired', message: 'That code has expired. Request a new one.' },
      too_many: { status: 429, code: 'too_many', message: 'Too many attempts. Request a new code.' }
    } satisfies Record<string, { status: number; code: string; message: string }>
    const info = map[result.error]
    return c.json({ ok: false, error: { code: info.code, message: info.message } }, info.status as 400)
  }

  // A code requested before maintenance began must not become a way in either.
  const signInMaintenance = await withContext(null, 'anon', async (q) => {
    const isAdmin = (
      await q.query<{ is_admin: boolean }>('select public.is_admin($1) as is_admin', [result.uid])
    ).rows[0]?.is_admin
    return maintenanceProblem(await maintenanceState(), Boolean(isAdmin))
  })
  if (signInMaintenance) {
    return c.json(
      { ok: false, error: { code: signInMaintenance.code, message: signInMaintenance.message } },
      503
    )
  }

  const accessToken = await signAccessToken({
    userId: result.uid,
    email: result.email,
    sid: result.sid,
    role: 'authenticated'
  })
  return c.json({
    ok: true,
    accessToken,
    refreshToken: result.refresh,
    expiresAt: Date.now() + accessTtlMs(),
    email: result.email
  })
})

// ---------------------------------------------------------------------------
// Sign-in capabilities
// ---------------------------------------------------------------------------

/** Public: lets the website/admin UI only offer the methods that actually work. */
authRoutes.get('/providers', (c) => c.json({ ok: true, ...providersSummary() }))

// ---------------------------------------------------------------------------
// Administrator sign-in with an email address and password
//
// Only accounts that (a) exist, (b) are active, (c) hold an admin role and
// (d) have a password credential can authenticate here. Authorization is decided
// from the database on every request, never from anything the client sends.
// ---------------------------------------------------------------------------
authRoutes.post('/password', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { email?: string; password?: string }
  const email = (body.email ?? '').trim().toLowerCase()
  const password = body.password ?? ''
  const ip = requestIp(c) ?? 'unknown'
  const userAgent = c.req.header('user-agent') ?? null

  if (!EMAIL_RE.test(email) || !password) {
    return c.json(
      { ok: false, error: { code: 'invalid_request', message: 'Enter your email address and password.' } },
      400
    )
  }

  const maxAttempts = intEnv('AUTH_PASSWORD_MAX_ATTEMPTS', 8)
  const windowMinutes = intEnv('AUTH_PASSWORD_WINDOW_MIN', 15)
  const throttled =
    (await tooManyAttempts('password', email, maxAttempts, windowMinutes)) ||
    (await tooManyAttempts('password', `ip:${ip}`, maxAttempts * 3, windowMinutes))
  if (throttled) {
    return c.json(
      {
        ok: false,
        error: { code: 'too_many_attempts', message: 'Too many attempts. Try again in a few minutes.' }
      },
      429
    )
  }

  const account = await withContext(null, 'anon', async (q) => {
    const row = (
      await q.query<{
        id: string
        email: string
        status: string
        password_hash: string | null
        is_admin: boolean
      }>(
        `select u.id, u.email, u.status, c.password_hash, public.is_admin(u.id) as is_admin
           from public.users u
           left join public.password_credentials c on c.user_id = u.id
          where lower(u.email) = $1
          limit 1`,
        [email]
      )
    ).rows[0]
    return row ?? null
  })

  // Administrators keep access during maintenance; everyone else does not.
  const maintenance = maintenanceProblem(await maintenanceState(), Boolean(account?.is_admin))
  if (maintenance) {
    return c.json({ ok: false, error: { code: maintenance.code, message: maintenance.message } }, 503)
  }

  const okPassword = verifyPassword(password, account?.password_hash ?? dummyHash())
  const allowed = Boolean(account && account.is_admin && okPassword && account.status === 'active')

  await recordAttempt('password', email, allowed)
  await recordAttempt('password', `ip:${ip}`, allowed)

  if (!allowed || !account) {
    // One message for every failure mode — unknown account, wrong password,
    // non-admin, inactive — so this endpoint cannot be used to enumerate admins.
    return c.json(
      {
        ok: false,
        error: { code: 'invalid_credentials', message: 'That email and password combination is not valid.' }
      },
      401
    )
  }

  await withContext(account.id, 'authenticated', async (q) => {
    await q.query(
      `insert into public.audit_logs (actor_id, action, target, detail)
       values ($1, 'auth.admin_password', null, jsonb_build_object('ip', $2::text))`,
      [account.id, ip]
    )
  })

  const session = await mintSession(account.id, account.email, userAgent, ip)
  return c.json({ ok: true, ...session, admin: true })
})

// ---------------------------------------------------------------------------
// Google sign-in (server-side authorization code flow)
// ---------------------------------------------------------------------------
authRoutes.get('/google/start', async (c) => {
  if (!googleConfigured()) {
    return c.json(
      {
        ok: false,
        error: {
          code: 'google_not_configured',
          message: 'Google sign-in is not configured on this deployment yet.'
        }
      },
      503
    )
  }

  const maintenance = maintenanceProblem(await maintenanceState(), false)
  if (maintenance) {
    return c.json({ ok: false, error: { code: maintenance.code, message: maintenance.message } }, 503)
  }

  const target = resolveTarget(c.req.query('redirect'))
  if (!target) {
    return c.json(
      {
        ok: false,
        error: { code: 'invalid_redirect', message: 'Unsupported sign-in return target.' }
      },
      400
    )
  }

  const nonce = generateToken(16)
  const state = await signState({ kind: target.kind, url: target.url, nonce })
  return c.redirect(googleAuthUrl({ state, redirectUri: googleRedirectUri(c), nonce }), 302)
})

authRoutes.get('/google/callback', async (c) => {
  const state = await verifyState(c.req.query('state') ?? '')
  if (!state) {
    return c.json(
      { ok: false, error: { code: 'invalid_state', message: 'This sign-in attempt expired. Try again.' } },
      400
    )
  }

  const failure = (code: string) => c.redirect(withParams(state.url, { error: code }), 302)

  if (c.req.query('error')) return failure(c.req.query('error') as string)
  const code = c.req.query('code') ?? ''
  if (!code) return failure('missing_code')

  let identity: GoogleIdentity | null = null
  try {
    const idToken = await exchangeGoogleCode(code, googleRedirectUri(c))
    identity = await verifyGoogleIdToken(idToken, state.nonce)
  } catch (error) {
    console.error('[api:google] exchange failed', error)
    identity = null
  }
  if (!identity) return failure('google_verification_failed')
  if (!identity.emailVerified) return failure('email_not_verified')

  const linked = await withContext(null, 'anon', async (q) => {
    const uid = (
      await q.query<{ uid: string }>('select public.link_identity($1, $2, $3, $4) as uid', [
        'google',
        identity.subject,
        identity.email,
        identity.name ?? null
      ])
    ).rows[0]?.uid
    if (!uid) return null
    return (
      (
        await q.query<{ id: string; email: string; status: string }>(
          'select id, email, status from public.users where id = $1',
          [uid]
        )
      ).rows[0] ?? null
    )
  })

  if (!linked) return failure('account_unavailable')
  if (linked.status !== 'active') return failure('account_inactive')

  if (state.kind === 'app') {
    // Hand the installed desktop app the magic-link shape it already verifies,
    // so signing in with Google needs no desktop change at all.
    const magic = generateToken(32)
    const ttlMinutes = intEnv('AUTH_OTP_TTL_MIN', 10)
    await withContext(null, 'anon', async (q) => {
      await q.query('update public.auth_otps set consumed_at = now() where email = $1 and consumed_at is null', [
        linked.email
      ])
      await q.query(
        `insert into public.auth_otps (email, code_hash, magic_hash, expires_at)
         values ($1, $2, $3, now() + make_interval(mins => $4::int))`,
        [linked.email, hashSecret(generateToken(32)), hashSecret(magic), ttlMinutes]
      )
    })
    return c.redirect(
      withParams(appCallbackUrl(), { email: linked.email, token: magic, type: 'google' }),
      302
    )
  }

  // Web: never put a session token in the URL — hand back a single-use code the
  // page exchanges over POST for the real tokens.
  const oneTime = generateToken(32)
  await withContext(linked.id, 'authenticated', async (q) => {
    await q.query(
      `insert into public.auth_oauth_codes (code_hash, user_id, expires_at)
       values ($1, $2, now() + make_interval(mins => $3::int))`,
      [hashSecret(oneTime), linked.id, intEnv('AUTH_OAUTH_CODE_TTL_MIN', 5)]
    )
    await q.query('update public.users set last_sign_in_at = now() where id = $1', [linked.id])
  })
  return c.redirect(withParams(state.url, { code: oneTime }), 302)
})

/** Swap a single-use OAuth code for a session. */
authRoutes.post('/oauth/exchange', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { code?: string }
  const code = (body.code ?? '').trim()
  if (!code) {
    return c.json({ ok: false, error: { code: 'invalid_request', message: 'A code is required.' } }, 400)
  }

  const user = await withContext(null, 'anon', async (q) => {
    // The UPDATE consumes the code atomically, so a replay finds nothing.
    const row = (
      await q.query<{ user_id: string }>(
        `update public.auth_oauth_codes set consumed_at = now()
          where code_hash = $1 and consumed_at is null and expires_at > now()
          returning user_id`,
        [hashSecret(code)]
      )
    ).rows[0]
    if (!row) return null
    return (
      (
        await q.query<{ id: string; email: string; status: string }>(
          'select id, email, status from public.users where id = $1',
          [row.user_id]
        )
      ).rows[0] ?? null
    )
  })

  if (!user) {
    return c.json(
      { ok: false, error: { code: 'invalid_code', message: 'That sign-in link has expired. Sign in again.' } },
      400
    )
  }
  if (user.status !== 'active') {
    return c.json(
      { ok: false, error: { code: 'account_inactive', message: 'This account is not active.' } },
      403
    )
  }

  const session = await mintSession(user.id, user.email, c.req.header('user-agent') ?? null, requestIp(c))
  return c.json({ ok: true, ...session })
})

authRoutes.post('/refresh', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { refreshToken?: string }
  const refreshToken = (body.refreshToken ?? '').trim()
  if (!refreshToken) {
    return c.json({ ok: false, error: { code: 'invalid_request', message: 'refreshToken is required.' } }, 400)
  }

  const result = await withContext(null, 'anon', async (q) => {
    const session = (
      await q.query<{ id: string; user_id: string; expires_at: string; revoked_at: string | null }>(
        'select id, user_id, expires_at, revoked_at from public.sessions where refresh_hash = $1',
        [hashSecret(refreshToken)]
      )
    ).rows[0]
    if (!session || session.revoked_at || new Date(session.expires_at).getTime() < Date.now()) {
      return { error: 'invalid_refresh' as const }
    }
    const user = (
      await q.query<{ id: string; email: string; status: string }>(
        'select id, email, status from public.users where id = $1',
        [session.user_id]
      )
    ).rows[0]
    if (!user || user.status !== 'active') return { error: 'account_inactive' as const }

    const nextRefresh = generateToken(32)
    await q.query('update public.sessions set refresh_hash = $1, last_used_at = now() where id = $2', [
      hashSecret(nextRefresh),
      session.id
    ])
    return { uid: user.id, email: user.email, sid: session.id, refresh: nextRefresh }
  })

  if ('error' in result) {
    const inactive = result.error === 'account_inactive'
    return c.json(
      {
        ok: false,
        error: {
          code: inactive ? 'account_inactive' : 'invalid_refresh',
          message: inactive ? 'This account is not active.' : 'Session expired. Sign in again.'
        }
      },
      inactive ? 403 : 401
    )
  }

  const accessToken = await signAccessToken({
    userId: result.uid,
    email: result.email,
    sid: result.sid,
    role: 'authenticated'
  })
  return c.json({
    ok: true,
    accessToken,
    refreshToken: result.refresh,
    expiresAt: Date.now() + accessTtlMs(),
    email: result.email
  })
})

authRoutes.post('/signout', requireAuth, async (c) => {
  const sid = c.get('sid')
  if (sid) {
    await withContext(c.get('userId'), 'authenticated', async (q) => {
      await q.query('update public.sessions set revoked_at = now() where id = $1', [sid])
    })
  }
  return c.json({ ok: true })
})
