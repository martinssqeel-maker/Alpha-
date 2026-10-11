import { Hono } from 'hono'
import type { AppEnv } from './types'
import { withContext } from './db'
import { boolEnv, getEnv, intEnv } from './env'
import { generateCode, generateToken, hashSecret, safeEqual } from './crypto'
import { sendOtpEmail } from './email'
import { accessTtlMs, refreshTtlMs, signAccessToken } from './jwt'
import { requireAuth } from './middleware'

export const authRoutes = new Hono<AppEnv>()

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

authRoutes.post('/request', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { email?: string }
  const email = (body.email ?? '').trim().toLowerCase()
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return c.json({ ok: false, error: { code: 'invalid_email', message: 'Enter a valid email address.' } }, 400)
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
  if (boolEnv('AUTH_DEV_ECHO_OTP')) {
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

    if (!row) return { error: 'invalid_code' as const }
    if (new Date(row.expires_at).getTime() < Date.now()) return { error: 'expired' as const }
    if (row.attempts >= maxAttempts) return { error: 'too_many' as const }

    const matches = token
      ? safeEqual(hashSecret(token), row.magic_hash)
      : safeEqual(hashSecret(code), row.code_hash)
    if (!matches) {
      await q.query('update public.auth_otps set attempts = attempts + 1 where id = $1', [row.id])
      return { error: 'invalid_code' as const }
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

    return { uid, email: user?.email ?? row.email, sid, refresh }
  })

  if ('error' in result) {
    const map: Record<string, { status: number; code: string; message: string }> = {
      invalid_code: { status: 400, code: 'invalid_code', message: 'That code is not correct.' },
      expired: { status: 400, code: 'expired', message: 'That code has expired. Request a new one.' },
      too_many: { status: 429, code: 'too_many', message: 'Too many attempts. Request a new code.' }
    }
    const info = map[result.error]
    return c.json({ ok: false, error: { code: info.code, message: info.message } }, info.status as 400)
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
