import { Hono } from 'hono'
import type { Context } from 'hono'
import type { AppEnv } from './types'
import { withContext } from './db'
import { boolEnv, getEnv, intEnv } from './env'
import { generateCode, generateToken, hashSecret, safeEqual } from './crypto'
import { EmailDeliveryError, sendOtpEmail } from './email'
import { accessTtlMs, refreshTtlMs, signAccessToken } from './jwt'
import { requireAuth } from './middleware'
import { requireLiveSession } from './sessions'
import { hashPassword, passwordNeedsRehash, passwordProblem, verifyPassword } from './password'
import { fullNameProblem, normalizeFullName, normalizePhone, phoneProblem } from './profile'
import {
  appCallbackUrl,
  exchangeGithubCode,
  exchangeGoogleCode,
  fetchGithubIdentity,
  githubAuthUrl,
  githubConfigured,
  googleAuthUrl,
  googleConfigured,
  isProviderMisconfigured,
  providersSummary,
  resolveTarget,
  signState,
  verifyGoogleIdToken,
  verifyState
} from './oauth'
import type { GithubIdentity, GoogleIdentity, OAuthState } from './oauth'
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

/**
 * Mint a sign-in code for `email` and send it (code + one-tap link).
 *
 * Callers own the throttling decision: /auth/request has the richest version of
 * it, and the password routes apply their own per-address and per-IP ceilings
 * before calling this. Kept separate so those routes cannot forget to retire the
 * previous unconsumed code, which would leave two live codes for one address.
 */
async function sendSignInCode(
  email: string,
  ip: string,
  userAgent: string | null,
  ttlMinutes: number
): Promise<{ simulated: boolean }> {
  const code = generateCode()
  const magic = generateToken(32)
  await withContext(null, 'anon', async (q) => {
    await q.query('update public.auth_otps set consumed_at = now() where email = $1 and consumed_at is null', [
      email
    ])
    await q.query(
      `insert into public.auth_otps (email, code_hash, magic_hash, expires_at, ip, user_agent)
       values ($1, $2, $3, now() + make_interval(mins => $4::int), $5, $6)`,
      [email, hashSecret(code), hashSecret(magic), ttlMinutes, ip, userAgent]
    )
  })
  const delivery = await sendOtpEmail({
    to: email,
    code,
    magicUrl: signInLinkUrl(email, magic),
    expiresMinutes: ttlMinutes
  })
  return { simulated: delivery.simulated }
}

/** The Function's own callback for a provider, honouring an explicit override. */
function oauthRedirectUri(c: { req: { url: string } }, provider: 'google' | 'github'): string {
  const configured = getEnv(provider === 'google' ? 'GOOGLE_REDIRECT_URI' : 'GITHUB_REDIRECT_URI')
  if (configured) return configured
  try {
    return `${new URL(c.req.url).origin}/auth/${provider}/callback`
  } catch {
    const base = (getEnv('NEON_FUNCTION_API_BASE_URL') ?? '').replace(/\/+$/, '')
    return `${base}/auth/${provider}/callback`
  }
}

function withParams(base: string, params: Record<string, string>): string {
  const url = new URL(base)
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value)
  return url.toString()
}

/**
 * Which failure to hand back after a provider callback.
 *
 * A rejected client secret or a callback the provider's console no longer knows
 * about is a permanent, server-side misconfiguration; reporting it as a generic
 * `..._verification_failed` invites the user to retry something only an operator
 * can fix. Genuine identity/token verification problems keep that generic code.
 */
function providerFailureCode(provider: 'google' | 'github', error: unknown): string {
  return isProviderMisconfigured(error)
    ? `${provider}_misconfigured`
    : `${provider}_verification_failed`
}

/**
 * Where an emailed sign-in link lands.
 *
 * The site is served with clean URLs, so `/account` is the canonical address of
 * the account page — pointing at `/account.html` would cost an extra redirect hop
 * and any doubt about the query surviving it. With no site configured the link
 * opens the installed app instead, via the *configured* scheme rather than a
 * hardcoded `alpha://`.
 */
export function signInLinkUrl(email: string, magic: string): string {
  const query = `email=${encodeURIComponent(email)}&token=${encodeURIComponent(magic)}`
  const webUrl = (getEnv('WEB_ACCOUNT_URL') ?? '').replace(/\/+$/, '')
  return webUrl ? `${webUrl}/account?${query}` : `${appCallbackUrl()}?${query}`
}

// ---------------------------------------------------------------------------
// Sign-in email volume control
//
// `/auth/request` is unauthenticated and sends mail to an address a caller
// chooses, so without a ceiling it is a mail-bombing tool aimed at any inbox and
// a way to burn the email provider's quota. Two independent limits apply — per
// address and per source IP — plus a short cooldown that turns a double-clicked
// button into one email instead of two.
//
// The decision is a pure function of counts and limits so it can be tested
// without a database; only the counting touches SQL.
// ---------------------------------------------------------------------------

export interface OtpRequestSignals {
  emailCount: number
  ipCount: number
  /** Infinity when this address has not been sent a code inside the window. */
  secondsSinceLastEmail: number
  perEmailMax: number
  perIpMax: number
  cooldownSeconds: number
}

export type OtpRequestDecision = 'allow' | 'cooldown' | 'throttled'

/**
 * `throttled` outranks `cooldown`: once the ceiling is reached the honest answer
 * is "stop asking", not "wait a minute" — the cooldown would expire and the next
 * request would be refused again anyway.
 */
export function otpRequestDecision(signals: OtpRequestSignals): OtpRequestDecision {
  if (signals.emailCount >= signals.perEmailMax || signals.ipCount >= signals.perIpMax) return 'throttled'
  if (signals.secondsSinceLastEmail < signals.cooldownSeconds) return 'cooldown'
  return 'allow'
}

authRoutes.post('/request', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { email?: string }
  const email = (body.email ?? '').trim().toLowerCase()
  if (!EMAIL_RE.test(email)) {
    return c.json({ ok: false, error: { code: 'invalid_email', message: 'Enter a valid email address.' } }, 400)
  }

  // While maintenance mode is on, ordinary sign-ins are refused with an
  // explanation. The password path still works for administrators (below).
  const maintenance = maintenanceProblem(await maintenanceState(), false)
  if (maintenance) {
    return c.json({ ok: false, error: { code: maintenance.code, message: maintenance.message } }, 503)
  }

  const ttlMinutes = intEnv('AUTH_OTP_TTL_MIN', 10)
  const ip = requestIp(c) ?? 'unknown'
  const emailKey = email
  const ipKey = `ip:${ip}`
  const windowMinutes = intEnv('AUTH_OTP_REQUEST_WINDOW_MIN', 15)
  const perEmailMax = intEnv('AUTH_OTP_REQUEST_MAX', 3)
  const perIpMax = intEnv('AUTH_OTP_REQUEST_IP_MAX', 10)
  const cooldownSeconds = intEnv('AUTH_OTP_RESEND_COOLDOWN_SEC', 60)

  // Every row here is a message we actually attempted to send, so counting rows
  // counts emails. Throttled requests are deliberately not recorded: otherwise an
  // attacker's own retries would keep refreshing the window and extend their own
  // lockout.
  const signals = await withContext(null, 'anon', async (q) => {
    const row = (
      await q.query<{ email_count: string; ip_count: string; seconds_since_email: string | null }>(
        `select count(*) filter (where key = $1)::text as email_count,
                count(*) filter (where key = $2)::text as ip_count,
                extract(epoch from now() - max(created_at) filter (where key = $1))::text as seconds_since_email
           from public.auth_attempts
          where scope = 'otp_request' and created_at > now() - make_interval(mins => $3::int)`,
        [emailKey, ipKey, windowMinutes]
      )
    ).rows[0]
    const seconds = row?.seconds_since_email
    return {
      emailCount: Number.parseInt(row?.email_count ?? '0', 10),
      ipCount: Number.parseInt(row?.ip_count ?? '0', 10),
      secondsSinceLastEmail: seconds === null || seconds === undefined ? Number.POSITIVE_INFINITY : Number.parseFloat(seconds)
    }
  })

  const decision = otpRequestDecision({
    ...signals,
    perEmailMax,
    perIpMax,
    cooldownSeconds
  })

  if (decision === 'throttled') {
    return c.json(
      {
        ok: false,
        error: {
          code: 'too_many_requests',
          message: `Too many sign-in emails requested. Try again in ${windowMinutes} minutes.`
        }
      },
      429
    )
  }
  if (decision === 'cooldown') {
    const retryAfterSeconds = Math.max(1, Math.ceil(cooldownSeconds - signals.secondsSinceLastEmail))
    return c.json({
      ok: true,
      alreadySent: true,
      message: `A sign-in code was sent to ${email} moments ago. Check your inbox, or request another in ${retryAfterSeconds} second${retryAfterSeconds === 1 ? '' : 's'}.`,
      retryAfterSeconds,
      expiresInMinutes: ttlMinutes
    })
  }

  const code = generateCode()
  const magic = generateToken(32)
  const codeHash = hashSecret(code)
  const magicHash = hashSecret(magic)
  const userAgent = c.req.header('user-agent') ?? null

  const otpId = await withContext(null, 'anon', async (q) => {
    await q.query('update public.auth_otps set consumed_at = now() where email = $1 and consumed_at is null', [email])
    const inserted = await q.query<{ id: string }>(
      `insert into public.auth_otps (email, code_hash, magic_hash, expires_at, ip, user_agent)
       values ($1, $2, $3, now() + make_interval(mins => $4::int), $5, $6)
       returning id`,
      [email, codeHash, magicHash, ttlMinutes, ip, userAgent]
    )
    return inserted.rows[0].id
  })

  try {
    const delivery = await sendOtpEmail({
      to: email,
      code,
      magicUrl: signInLinkUrl(email, magic),
      expiresMinutes: ttlMinutes
    })
    await recordAttempt('otp_request', emailKey, true)
    await recordAttempt('otp_request', ipKey, true)

    const payload: Record<string, unknown> = {
      ok: true,
      message: `We sent a sign-in code to ${email}.`,
      expiresInMinutes: ttlMinutes,
      // Honest about the dev transport: "sent" when nothing was delivered would
      // send a person to check an inbox that will never receive anything.
      delivered: !delivery.simulated,
      provider: delivery.provider
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
  } catch (error) {
    // The code was already minted. If the mail never left, leaving it live would
    // mean a usable credential nobody received, issued from an error response —
    // so it is retired and the caller is told the truth instead.
    await withContext(null, 'anon', async (q) => {
      await q.query('update public.auth_otps set consumed_at = now() where id = $1', [otpId])
    })
    await recordAttempt('otp_request', emailKey, false)
    await recordAttempt('otp_request', ipKey, false)

    const retryable = error instanceof EmailDeliveryError && error.retryable
    if (!(error instanceof EmailDeliveryError)) console.error('[auth:request] email send failed', error)
    return c.json(
      {
        ok: false,
        error: {
          code: 'email_delivery_failed',
          message: retryable
            ? 'The email service is busy, so the sign-in email could not be sent. Try again in a moment.'
            : 'The sign-in email could not be sent. If this continues, the service operator must check the email configuration.'
        }
      },
      retryable ? 503 : 502
    )
  }
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
    // Redeeming the code proves the address receives mail, which is what the
    // download gate asks for.
    await q.query('select public.mark_email_verified($1)', [uid])
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
// Email + password: sign-up, recovery and change
//
// Member accounts were passwordless until now: /auth/password needed an admin
// role, and 0002_auth.sql records that password_credentials could only be written
// by scripts/admin-password.mjs on the operator's machine. These routes add the
// missing write path.
//
// Both /register and /password/forgot answer identically whether or not an account
// exists, and mail the address either way, so neither can be used to discover who
// has an account here. Sign-in keeps its single generic refusal for the same
// reason (see /password below).
// ---------------------------------------------------------------------------

authRoutes.post('/register', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    email?: string
    password?: string
    fullName?: string
    phone?: string
  }
  const email = (body.email ?? '').trim().toLowerCase()
  const password = body.password ?? ''
  const fullName = normalizeFullName(body.fullName)
  const phone = normalizePhone(body.phone)

  if (!EMAIL_RE.test(email)) {
    return c.json(
      { ok: false, error: { code: 'invalid_email', message: 'Enter a valid email address.' } },
      400
    )
  }
  // The same rules the sign-in side enforces, reported verbatim so the form can
  // say what is actually wrong instead of "invalid password".
  const problem = passwordProblem(password)
  if (problem) {
    return c.json({ ok: false, error: { code: 'weak_password', message: problem } }, 400)
  }
  // The form asks for a name and a phone number as well as credentials. Both are
  // validated before any database work so a typo cannot half-create an account.
  const nameIssue = fullNameProblem(fullName)
  if (nameIssue) {
    return c.json({ ok: false, error: { code: 'invalid_name', message: nameIssue } }, 400)
  }
  const phoneIssue = phoneProblem(phone)
  if (phoneIssue) {
    return c.json({ ok: false, error: { code: 'invalid_phone', message: phoneIssue } }, 400)
  }

  const maintenance = maintenanceProblem(await maintenanceState(), false)
  if (maintenance) {
    return c.json({ ok: false, error: { code: maintenance.code, message: maintenance.message } }, 503)
  }

  const ip = requestIp(c) ?? 'unknown'
  const windowMinutes = intEnv('AUTH_REGISTER_WINDOW_MIN', 60)
  const maxAttempts = intEnv('AUTH_REGISTER_MAX', 10)
  const throttled =
    (await tooManyAttempts('register', email, maxAttempts, windowMinutes)) ||
    (await tooManyAttempts('register', `ip:${ip}`, maxAttempts * 3, windowMinutes))
  if (throttled) {
    return c.json(
      {
        ok: false,
        error: { code: 'too_many_attempts', message: 'Too many sign-up attempts. Try again later.' }
      },
      429
    )
  }

  const userId = await withContext(null, 'anon', async (q) => {
    const existing = (
      await q.query<{ user_id: string }>(
        `select c.user_id
           from public.users u
           left join public.password_credentials c on c.user_id = u.id
          where lower(u.email) = $1
          limit 1`,
        [email]
      )
    ).rows[0]
    // provision_user is idempotent — it is the same call first sign-in makes — so
    // an existing address is a no-op here rather than an error.
    const uid = (
      await q.query<{ id: string }>('select public.provision_user($1) as id', [email])
    ).rows[0].id
    if (existing?.user_id) {
      // Signing up again from a form fills in what the account is missing, but
      // never rewrites a name or number its owner already has — including one
      // that arrived from an OAuth profile.
      await q.query(
        `update public.users
            set full_name = coalesce(full_name, $2),
                phone = coalesce(phone, $3)
          where id = $1`,
        [uid, fullName, phone]
      )
      return { uid, created: false as const }
    }
    await q.query('select public.set_password_credential($1, $2, $3)', [
      uid,
      hashPassword(password),
      'scrypt'
    ])
    await q.query('update public.users set full_name = $2, phone = $3 where id = $1', [
      uid,
      fullName,
      phone
    ])
    return { uid, created: true as const }
  })

  // A code goes out either way: it finishes a new account (and signs it in) and it
  // is the same message /auth/request would have sent to an existing one.
  let delivered = true
  try {
    const sent = await sendSignInCode(email, ip, c.req.header('user-agent') ?? null, intEnv('AUTH_OTP_TTL_MIN', 10))
    delivered = !sent.simulated
  } catch (error) {
    await recordAttempt('register', email, false)
    await recordAttempt('register', `ip:${ip}`, false)
    if (!(error instanceof EmailDeliveryError)) console.error('[auth:register] email send failed', error)
  }
  await recordAttempt('register', email, true)
  await recordAttempt('register', `ip:${ip}`, true)
  void userId

  return c.json(
    {
      ok: true,
      needsVerification: true,
      delivered,
      message: delivered
        ? 'Check your inbox for a six-digit code. Enter it here to finish setting up your account.'
        : 'Your account was saved, but the confirmation email could not be sent. Try “Forgot password” in a moment to request another code.'
    },
    202
  )
})

authRoutes.post('/password/forgot', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { email?: string }
  const email = (body.email ?? '').trim().toLowerCase()
  if (!EMAIL_RE.test(email)) {
    return c.json(
      { ok: false, error: { code: 'invalid_email', message: 'Enter a valid email address.' } }, 400
    )
  }

  const maintenance = maintenanceProblem(await maintenanceState(), false)
  if (maintenance) {
    return c.json({ ok: false, error: { code: maintenance.code, message: maintenance.message } }, 503)
  }

  const ip = requestIp(c) ?? 'unknown'
  const windowMinutes = intEnv('AUTH_PASSWORD_WINDOW_MIN', 15)
  const maxAttempts = intEnv('AUTH_PASSWORD_MAX_ATTEMPTS', 8)
  const throttled =
    (await tooManyAttempts('password_reset', email, maxAttempts, windowMinutes)) ||
    (await tooManyAttempts('password_reset', `ip:${ip}`, maxAttempts * 3, windowMinutes))
  if (throttled) {
    return c.json(
      {
        ok: false,
        error: { code: 'too_many_attempts', message: 'Too many attempts. Try again in a few minutes.' }
      },
      429
    )
  }

  const hasCredential = await withContext(null, 'anon', async (q) => {
    const row = (
      await q.query<{ user_id: string }>(
        `select c.user_id
           from public.users u
           join public.password_credentials c on c.user_id = u.id
          where lower(u.email) = $1
          limit 1`,
        [email]
      )
    ).rows[0]
    return Boolean(row)
  })

  if (hasCredential) {
    try {
      await sendSignInCode(email, ip, c.req.header('user-agent') ?? null, intEnv('AUTH_OTP_TTL_MIN', 10))
      await recordAttempt('password_reset', email, true)
      await recordAttempt('password_reset', `ip:${ip}`, true)
    } catch (error) {
      // Deliberately not reported to the caller: a delivery error on an address
      // that exists would be an account oracle. The operator sees it in the logs.
      await recordAttempt('password_reset', email, false)
      await recordAttempt('password_reset', `ip:${ip}`, false)
      if (!(error instanceof EmailDeliveryError)) console.error('[auth:forgot] email send failed', error)
    }
  }

  return c.json(
    {
      ok: true,
      message:
        'If that address has an account with a password, a six-digit reset code is on its way. Enter it below with a new password.'
    },
    202
  )
})

authRoutes.post('/password/reset', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    email?: string
    code?: string
    password?: string
  }
  const email = (body.email ?? '').trim().toLowerCase()
  const code = (body.code ?? '').trim()
  const password = body.password ?? ''

  if (!EMAIL_RE.test(email)) {
    return c.json(
      { ok: false, error: { code: 'invalid_email', message: 'Enter a valid email address.' } }, 400
    )
  }
  const problem = passwordProblem(password)
  if (problem) {
    return c.json({ ok: false, error: { code: 'weak_password', message: problem } }, 400)
  }
  if (!/^\d{6}$/.test(code)) {
    return c.json(
      { ok: false, error: { code: 'invalid_code', message: 'That code is not correct.' } },
      400
    )
  }

  const maintenance = maintenanceProblem(await maintenanceState(), false)
  if (maintenance) {
    return c.json({ ok: false, error: { code: maintenance.code, message: maintenance.message } }, 503)
  }

  const maxAttempts = intEnv('AUTH_MAX_ATTEMPTS', 6)
  const result = await withContext(null, 'anon', async (q) => {
    const row = (
      await q.query<OtpRow>(
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
    if (!safeEqual(hashSecret(code), row.code_hash)) {
      await q.query('update public.auth_otps set attempts = attempts + 1 where id = $1', [row.id])
      return { ok: false as const, error: 'invalid_code' as const }
    }

    await q.query('update public.auth_otps set consumed_at = now() where id = $1', [row.id])
    // Only an account that already has a password can reset one. Provisioning here
    // would let the reset form create accounts.
    const uid = (
      await q.query<{ id: string }>(
        `select u.id from public.users u
           join public.password_credentials c on c.user_id = u.id
          where lower(u.email) = $1 limit 1`,
        [email]
      )
    ).rows[0]?.id
    if (!uid) return { ok: false as const, error: 'invalid_code' as const }

    await q.query('select public.set_password_credential($1, $2, $3)', [
      uid,
      hashPassword(password),
      'scrypt'
    ])
    // The code arrived in the mailbox, so this address is now proven.
    await q.query('select public.mark_email_verified($1)', [uid])
    await q.query(
      `insert into public.audit_logs (actor_id, action, target, detail)
       values (null, 'auth.password_reset', $1::text, jsonb_build_object('via', 'website_reset'))`,
      [uid]
    )
    return { ok: true as const, uid }
  })

  if (!result.ok) {
    await recordAttempt('password_reset', email, false)
    const map = {
      invalid_code: { status: 400, code: 'invalid_code', message: 'That code is not correct.' },
      expired: { status: 400, code: 'expired', message: 'That code has expired. Request a new one.' },
      too_many: { status: 429, code: 'too_many', message: 'Too many attempts. Request a new code.' }
    } satisfies Record<string, { status: number; code: string; message: string }>
    const info = map[result.error]
    return c.json({ ok: false, error: { code: info.code, message: info.message } }, info.status as 400)
  }

  await recordAttempt('password_reset', email, true)
  return c.json({ ok: true, message: 'Your password has been updated. Sign in with the new one.' })
})

authRoutes.post('/password/change', requireAuth, requireLiveSession, async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    currentPassword?: string
    newPassword?: string
  }
  const newPassword = body.newPassword ?? ''
  const currentPassword = body.currentPassword ?? ''
  const problem = passwordProblem(newPassword)
  if (problem) {
    return c.json({ ok: false, error: { code: 'weak_password', message: problem } }, 400)
  }

  const userId = c.get('userId')
  const result = await withContext(userId, 'authenticated', async (q) => {
    const stored = (
      await q.query<{ password_hash: string }>(
        'select password_hash from public.password_credentials where user_id = $1',
        [userId]
      )
    ).rows[0]

    if (stored?.password_hash) {
      if (!currentPassword) return { ok: false as const, error: 'current_required' as const }
      if (!verifyPassword(currentPassword, stored.password_hash)) {
        return { ok: false as const, error: 'invalid_password' as const }
      }
    }

    await q.query('select public.set_password_credential($1, $2, $3)', [
      userId,
      hashPassword(newPassword),
      'scrypt'
    ])
    // Both casts are required: one parameter cannot be inferred as uuid for
    // actor_id and text for target, and an uncast id fails the whole statement.
    await q.query(
      `insert into public.audit_logs (actor_id, action, target, detail)
       values ($1::uuid, 'auth.password_set', $1::text, jsonb_build_object('via', 'website_dashboard'))`,
      [userId]
    )
    // A changed password ends every other device's session, which is the behaviour
    // people expect after they change a password because they think it leaked.
    const revoked = await q.query(
      `update public.sessions set revoked_at = now()
        where user_id = $1 and id <> $2 and revoked_at is null and expires_at > now()`,
      [userId, c.get('sid')]
    )
    return { ok: true as const, replaced: Boolean(stored?.password_hash), revokedOthers: revoked.rowCount ?? 0 }
  })

  if (!result.ok) {
    const map = {
      current_required: { status: 400, code: 'current_required', message: 'Enter your current password to replace it.' },
      invalid_password: { status: 400, code: 'invalid_password', message: 'That password is not correct.' }
    } satisfies Record<string, { status: number; code: string; message: string }>
    const info = map[result.error]
    return c.json({ ok: false, error: { code: info.code, message: info.message } }, info.status as 400)
  }

  return c.json({ ok: true, replaced: result.replaced, revokedOthers: result.revokedOthers })
})

// ---------------------------------------------------------------------------
// Sign-in capabilities
// ---------------------------------------------------------------------------

/** Public: lets the website/admin UI only offer the methods that actually work. */
authRoutes.get('/providers', (c) => c.json({ ok: true, ...providersSummary() }))

// ---------------------------------------------------------------------------
// Sign-in with an email address and password
//
// Any account that exists, is active and has a password credential can
// authenticate here. Whether the caller is an administrator is read from the
// database after sign-in and returned as `admin` — never assumed, and never a
// constant, which it was while this route was administrators-only.
//
// Authorization for admin actions is still decided from the database on every
// request by public.require_admin, so this flag is a UI hint, not a grant.
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
  const allowed = Boolean(account && account.password_hash && okPassword && account.status === 'active')

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

  // Cost parameters move over time; a successful sign-in is the one moment the
  // plaintext is available to bring an old digest up to today's.
  if (account.password_hash && passwordNeedsRehash(account.password_hash)) {
    await withContext(account.id, 'authenticated', async (q) => {
      await q.query('select public.set_password_credential($1, $2, $3)', [
        account.id,
        hashPassword(password),
        'scrypt'
      ])
    })
  }

  const session = await mintSession(account.id, account.email, userAgent, ip)
  return c.json({ ok: true, ...session, admin: Boolean(account.is_admin) })
})

// ---------------------------------------------------------------------------
// Shared sign-in completion
//
// Every OAuth provider ends the same way: link the verified identity to an Alpha
// AI Workspace account, then return the browser to the originating surface. For
// the desktop app that is the `alpha://auth/callback` magic-link shape it already
// verifies, so the installed app needs no provider-specific code and never sees a
// provider token. For the web it is a single-use code the page exchanges over
// POST, so no session token ever lands in a URL.
// ---------------------------------------------------------------------------
async function finishOAuthSignIn(
  c: Context<AppEnv>,
  state: OAuthState,
  provider: 'google' | 'github',
  identity: { subject: string; email: string; name?: string },
  failure: (code: string) => Response
): Promise<Response> {
  const linked = await withContext(null, 'anon', async (q) => {
    const uid = (
      await q.query<{ uid: string }>('select public.link_identity($1, $2, $3, $4) as uid', [
        provider,
        identity.subject,
        identity.email,
        identity.name ?? null
      ])
    ).rows[0]?.uid
    if (!uid) return null
    // The provider verified this address before it would return an identity.
    await q.query('select public.mark_email_verified($1)', [uid])
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
    // Hand the installed desktop app the magic-link shape it already verifies.
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
      withParams(appCallbackUrl(), { email: linked.email, token: magic, type: provider }),
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
}

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
  return c.redirect(googleAuthUrl({ state, redirectUri: oauthRedirectUri(c, 'google'), nonce }), 302)
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
  let exchangeError: unknown = null
  try {
    const idToken = await exchangeGoogleCode(code, oauthRedirectUri(c, 'google'))
    identity = await verifyGoogleIdToken(idToken, state.nonce)
  } catch (error) {
    exchangeError = error
    console.error('[api:google] exchange failed', error)
    identity = null
  }
  if (!identity) return failure(providerFailureCode('google', exchangeError))
  if (!identity.emailVerified) return failure('email_not_verified')

  return finishOAuthSignIn(c, state, 'google', identity, failure)
})

// ---------------------------------------------------------------------------
// GitHub sign-in (server-side authorization code flow)
//
// The same shape as Google, and for the same reason: GitHub's own documentation
// states the OAuth App token exchange requires the client secret, so it must
// happen here on the Function and never inside the distributed desktop app. The
// app receives no GitHub token — only the alpha:// magic link it already knows
// how to verify.
//
// Scope is identity only (`read:user user:email`). Signing in with GitHub does
// NOT grant repository access; connecting repositories stays the separate,
// explicit "Connect GitHub" action in the desktop app.
// ---------------------------------------------------------------------------
authRoutes.get('/github/start', async (c) => {
  if (!githubConfigured()) {
    return c.json(
      {
        ok: false,
        error: {
          code: 'github_not_configured',
          message: 'GitHub sign-in is not configured on this deployment yet.'
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
  return c.redirect(githubAuthUrl({ state, redirectUri: oauthRedirectUri(c, 'github') }), 302)
})

authRoutes.get('/github/callback', async (c) => {
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

  let identity: GithubIdentity | null = null
  let exchangeError: unknown = null
  try {
    const accessToken = await exchangeGithubCode(code, oauthRedirectUri(c, 'github'))
    identity = await fetchGithubIdentity(accessToken)
  } catch (error) {
    exchangeError = error
    console.error('[api:github] exchange failed', error)
    identity = null
  }
  if (!identity) return failure(providerFailureCode('github', exchangeError))
  // fetchGithubIdentity only ever returns a verified address, so an email here is
  // already proven; the check keeps that invariant explicit.
  if (!identity.emailVerified) return failure('email_not_verified')

  return finishOAuthSignIn(c, state, 'github', identity, failure)
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

// ---------------------------------------------------------------------------
// Self-service account and sessions
//
// These are the only endpoints that let a signed-in visitor read or change their
// own account. Every statement is scoped by the user id from the verified token;
// none of them accepts a user id from the request, so an account cannot reach
// another account's data by editing a body. They also mount `requireLiveSession`,
// so a revoked session stops working here immediately.
// ---------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

interface SelfAccount {
  id: string
  email: string
  fullName: string | null
  phone: string | null
  status: string
  createdAt: string
  lastSignInAt: string | null
  providers: string[]
  hasPassword: boolean
  admin: boolean
}

/** The signed-in account, assembled from this user's own rows only. */
async function loadSelfAccount(userId: string): Promise<SelfAccount | null> {
  return withContext(userId, 'authenticated', async (q) => {
    const user = (
      await q.query<{
        id: string
        email: string
        full_name: string | null
        phone: string | null
        status: string
        created_at: string
        last_sign_in_at: string | null
      }>(
        `select id, email, full_name, phone, status, created_at, last_sign_in_at
           from public.users where id = $1`,
        [userId]
      )
    ).rows[0]
    if (!user) return null

    const providers = (
      await q.query<{ provider: string }>(
        'select distinct provider from public.user_identities where user_id = $1 order by provider',
        [userId]
      )
    ).rows.map((row) => row.provider)

    const credential = await q.query(
      'select 1 from public.password_credentials where user_id = $1',
      [userId]
    )
    const admin = (
      await q.query<{ is_admin: boolean }>('select public.is_admin($1) as is_admin', [userId])
    ).rows[0]?.is_admin

    return {
      id: user.id,
      email: user.email,
      fullName: user.full_name,
      phone: user.phone,
      status: user.status,
      createdAt: user.created_at,
      lastSignInAt: user.last_sign_in_at,
      providers,
      hasPassword: (credential.rowCount ?? 0) > 0,
      admin: Boolean(admin)
    }
  })
}

authRoutes.get('/me', requireAuth, requireLiveSession, async (c) => {
  const account = await loadSelfAccount(c.get('userId'))
  if (!account) {
    return c.json(
      { ok: false, error: { code: 'account_unavailable', message: 'This account is no longer available.' } },
      404
    )
  }
  return c.json({ ok: true, account })
})

authRoutes.patch('/me', requireAuth, requireLiveSession, async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { fullName?: unknown }
  if (typeof body.fullName !== 'string') {
    return c.json(
      { ok: false, error: { code: 'invalid_request', message: 'Send a full name to save.' } },
      400
    )
  }
  const name = normalizeFullName(body.fullName)
  if (name.length > 80) {
    return c.json(
      { ok: false, error: { code: 'invalid_request', message: 'A name can be at most 80 characters.' } },
      400
    )
  }

  const userId = c.get('userId')
  await withContext(userId, 'authenticated', async (q) => {
    await q.query('update public.users set full_name = nullif($2, \'\') where id = $1', [userId, name])
  })
  const account = await loadSelfAccount(userId)
  return c.json({ ok: true, account })
})

authRoutes.get('/sessions', requireAuth, requireLiveSession, async (c) => {
  const userId = c.get('userId')
  const sid = c.get('sid')
  const rows = await withContext(userId, 'authenticated', async (q) => {
    const res = await q.query<{
      id: string
      created_at: string
      last_used_at: string
      expires_at: string
      user_agent: string | null
      ip: string | null
    }>(
      `select id, created_at, last_used_at, expires_at, user_agent, ip
         from public.sessions
        where user_id = $1 and revoked_at is null and expires_at > now()
        order by last_used_at desc
        limit 50`,
      [userId]
    )
    return res.rows
  })

  return c.json({
    ok: true,
    sessions: rows.map((row) => ({
      id: row.id,
      createdAt: row.created_at,
      lastUsedAt: row.last_used_at,
      expiresAt: row.expires_at,
      userAgent: row.user_agent,
      ip: row.ip,
      current: row.id === sid
    }))
  })
})

authRoutes.delete('/sessions/:id', requireAuth, requireLiveSession, async (c) => {
  const id = c.req.param('id')
  if (!UUID_RE.test(id)) {
    return c.json(
      { ok: false, error: { code: 'invalid_request', message: 'That session id is not valid.' } },
      400
    )
  }
  const userId = c.get('userId')
  const revoked = await withContext(userId, 'authenticated', async (q) => {
    const res = await q.query(
      'update public.sessions set revoked_at = now() where id = $1 and user_id = $2 and revoked_at is null',
      [id, userId]
    )
    return res.rowCount ?? 0
  })
  if (revoked === 0) {
    return c.json(
      { ok: false, error: { code: 'session_not_found', message: 'That session is already signed out.' } },
      404
    )
  }
  return c.json({ ok: true, revoked: 1, current: id === c.get('sid') })
})

authRoutes.post('/sessions/revoke-others', requireAuth, requireLiveSession, async (c) => {
  const userId = c.get('userId')
  const sid = c.get('sid')
  const count = await withContext(userId, 'authenticated', async (q) => {
    const res = await q.query(
      `update public.sessions set revoked_at = now()
        where user_id = $1 and id <> $2 and revoked_at is null and expires_at > now()`,
      [userId, sid]
    )
    return res.rowCount ?? 0
  })
  return c.json({ ok: true, revoked: count })
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

authRoutes.get('/status', (c) => c.json({ ok: true, authenticated: false, authRequired: false }))
