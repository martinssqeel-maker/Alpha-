#!/usr/bin/env node
/**
 * Live verification of the authentication + download surface.
 *
 * Read-only by default: it only exercises endpoints that must refuse anonymous
 * callers, so it is safe to run against production at any time.
 *
 *   npm run verify:auth
 *
 * `--with-write` additionally proves the positive paths end to end. It creates
 * two throwaway accounts (an administrator and an ordinary user), drives them
 * through the real API, and removes them again — including their sessions,
 * credentials and audit rows — in a `finally` block. Use it when you need to
 * know the login actually works, not merely that it rejects the wrong password.
 *
 *   npm run verify:auth -- --with-write
 *
 * Requires DATABASE_URL (only for --with-write) and the API base URL.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash, createHmac, randomBytes, scryptSync } from 'node:crypto'
import pg from 'pg'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const withWrite = process.argv.includes('--with-write')

function parseEnvFile(contents) {
  const out = {}
  for (const rawLine of contents.replace(/\r\n?/g, '\n').split('\n')) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const withoutExport = line.startsWith('export ') ? line.slice(7).trim() : line
    const eq = withoutExport.indexOf('=')
    if (eq <= 0) continue
    const key = withoutExport.slice(0, eq).trim()
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue
    let value = withoutExport.slice(eq + 1).trim()
    const quote = value[0]
    if ((quote === '"' || quote === "'") && value.length >= 2 && value.endsWith(quote)) {
      value = value.slice(1, -1)
    } else {
      const hash = value.indexOf(' #')
      if (hash >= 0) value = value.slice(0, hash)
      value = value.trim()
    }
    out[key] = value
  }
  return out
}

const local = fs.existsSync(path.join(repoRoot, '.env.local'))
  ? parseEnvFile(fs.readFileSync(path.join(repoRoot, '.env.local'), 'utf8'))
  : {}

const API = (process.env.VERIFY_API_BASE || local.NEON_FUNCTION_API_BASE_URL || '').replace(/\/+$/, '')
const SITE = process.env.VERIFY_SITE || local.WEB_ACCOUNT_URL || 'https://alpha-website-lime.vercel.app'

if (!API) {
  console.error('Set NEON_FUNCTION_API_BASE_URL in .env.local (or VERIFY_API_BASE) first.')
  process.exit(1)
}

const results = []
function record(status, name, detail) {
  results.push({ status, name })
  console.log(`${status.padEnd(5)} ${name}${detail ? ` — ${detail}` : ''}`)
}

async function call(pathname, opts = {}) {
  const res = await fetch(`${API}${pathname}`, {
    method: opts.method || 'GET',
    headers: {
      ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
      ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
      ...(opts.headers || {})
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    redirect: 'manual'
  })
  const text = await res.text().catch(() => '')
  let json = null
  if (text) {
    try {
      json = JSON.parse(text)
    } catch {
      json = null
    }
  }
  return { status: res.status, headers: res.headers, text, json }
}

/**
 * The administrative controls this script drives, as the routes the portal
 * itself calls. `tests/adminRouteParity.test.ts` checks these against the router,
 * so a route that moves breaks a unit test instead of being reported as a broken
 * deployment.
 */
const ADMIN_ROUTES = {
  overview: ['GET', '/admin/overview'],
  users: ['GET', '/admin/users'],
  catalog: ['GET', '/admin/catalog'],
  releases: ['GET', '/admin/releases'],
  audit: ['GET', '/admin/audit'],
  setAdmin: ['POST', '/admin/users/:id/admin']
}

/** Call an admin route and unwrap the API's `{ok, data}` envelope. */
async function adminCall(name, { id, body, token } = {}) {
  const [method, template] = ADMIN_ROUTES[name]
  const pathname = template.replace(':id', id ?? '00000000-0000-0000-0000-000000000000')
  const res = await call(pathname, { method, body, token })
  return { ...res, data: res.json?.data ?? null }
}

// Same digest format as platform/api/password.ts. If the two ever drift, the
// live login below fails — which is the point of doing it this way.
function hashPassword(password) {
  const salt = randomBytes(16)
  const digest = scryptSync(password, salt, 64, { N: 16_384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 })
  return ['scrypt', 16_384, 8, 1, salt.toString('base64url'), digest.toString('base64url')].join('$')
}

async function readOnlyChecks() {
  const providers = await call('/auth/providers')
  if (providers.status === 200 && providers.json?.password === true) {
    record('PASS', 'GET /auth/providers reports capabilities', `google=${providers.json.google} password=${providers.json.password}`)
  } else {
    record('FAIL', 'GET /auth/providers reports capabilities', `status=${providers.status}`)
  }

  const anon = await call('/downloads/latest')
  if (anon.status === 401) record('PASS', 'GET /downloads/latest refuses anonymous callers', '401')
  else record('FAIL', 'GET /downloads/latest refuses anonymous callers', `status=${anon.status}`)

  const google = await call(`/auth/google/start?redirect=${encodeURIComponent(`${SITE}/download.html`)}`)
  if (google.status === 503) {
    record('PASS', 'GET /auth/google/start is honest when unconfigured', '503 google_not_configured')
  } else if (google.status === 302) {
    const location = google.headers.get('location') || ''
    const ok = location.startsWith('https://accounts.google.com/')
    record(ok ? 'PASS' : 'FAIL', 'GET /auth/google/start redirects to Google', location.slice(0, 60))
  } else {
    record('FAIL', 'GET /auth/google/start responds', `status=${google.status}`)
  }

  const badRedirect = await call('/auth/google/start?redirect=https%3A%2F%2Fevil.example%2Fsteal')
  if (badRedirect.status === 400 || badRedirect.status === 503) {
    record('PASS', 'GET /auth/google/start refuses a foreign redirect target', `status=${badRedirect.status}`)
  } else {
    record('FAIL', 'GET /auth/google/start refuses a foreign redirect target', `status=${badRedirect.status}`)
  }

  const foreign = await call('/health', { headers: { Origin: 'https://smoke-probe.invalid' } })
  const acao = foreign.headers.get('access-control-allow-origin')
  if (acao !== 'https://smoke-probe.invalid') {
    record('PASS', 'CORS does not reflect an arbitrary origin', `acao=${acao ?? '(none)'}`)
  } else {
    record('FAIL', 'CORS does not reflect an arbitrary origin', 'reflected the probe origin')
  }

  const own = await call('/health', { headers: { Origin: SITE } })
  const ownAcao = own.headers.get('access-control-allow-origin')
  if (ownAcao === SITE) record('PASS', 'CORS allows the website origin', SITE)
  else record('FAIL', 'CORS allows the website origin', `acao=${ownAcao ?? '(none)'}`)

  // The dashboard updates a profile and revokes sessions, so the browser sends a
  // PATCH and a DELETE. If the preflight does not allow them, every such control
  // is dead before its handler runs.
  const preflight = await call('/auth/me', {
    method: 'OPTIONS',
    headers: { Origin: SITE, 'Access-Control-Request-Method': 'PATCH' }
  })
  const allowMethods = preflight.headers.get('access-control-allow-methods') || ''
  if (allowMethods.includes('PATCH') && allowMethods.includes('DELETE')) {
    record('PASS', 'CORS preflight allows PATCH and DELETE', allowMethods)
  } else {
    record('FAIL', 'CORS preflight allows PATCH and DELETE', allowMethods || '(missing header)')
  }

  for (const path of ['/auth/me', '/auth/sessions']) {
    const anon = await call(path)
    if (anon.status === 401) record('PASS', `GET ${path} refuses anonymous callers`, '401')
    else record('FAIL', `GET ${path} refuses anonymous callers`, `status=${anon.status}`)
  }

  const wrong = await call('/auth/password', {
    method: 'POST',
    body: { email: 'nobody@example.invalid', password: 'a-long-enough-password' }
  })
  if (wrong.status === 401) record('PASS', 'POST /auth/password rejects unknown accounts', '401')
  else record('FAIL', 'POST /auth/password rejects unknown accounts', `status=${wrong.status}`)

  const malformed = await call('/auth/password', { method: 'POST', body: { email: 'not-an-email', password: '' } })
  if (malformed.status === 400) record('PASS', 'POST /auth/password validates input', '400')
  else record('FAIL', 'POST /auth/password validates input', `status=${malformed.status}`)
}

async function writeChecks() {
  const url = process.env.DATABASE_URL || local.DATABASE_URL
  if (!url) {
    record('FAIL', '--with-write requires DATABASE_URL', 'set it or run without the flag')
    return
  }
  const isLocal = /localhost|127\.0\.0\.1/.test(url)
  const client = new pg.Client({ connectionString: url, ssl: isLocal ? undefined : { rejectUnauthorized: false } })
  await client.connect()

  const stamp = Date.now()
  const adminEmail = `verify-admin-${stamp}@example.invalid`
  const userEmail = `verify-user-${stamp}@example.invalid`
  const adminPassword = `Tile-Canyon-${stamp}-Riverbend`
  const userPassword = `Meadow-Lantern-${stamp}-Basalt`
  const ids = []
  const pepper = local.AUTH_PEPPER || local.AUTH_JWT_SECRET || ''

  /** Mint a real session for `userId` through the same one-time-code exchange the
   *  website uses, so the token under test is one the API itself issued. */
  async function sessionFor(userId) {
    const code = randomBytes(32).toString('base64url')
    const codeHash = createHash('sha256').update(`${pepper}:${code}`).digest('hex')
    await client.query(
      `insert into public.auth_oauth_codes (code_hash, user_id, expires_at)
       values ($1, $2, now() + interval '5 minutes')`,
      [codeHash, userId]
    )
    const res = await call('/auth/oauth/exchange', { method: 'POST', body: { code } })
    return res.json?.accessToken ?? null
  }

  /** Claims inside a token this script has already obtained. */
  function tokenClaims(token) {
    try {
      return JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8'))
    } catch {
      return null
    }
  }

  /** A correctly signed token whose `role` claim simply *says* administrator.
   *  Authorization must come from the database, so this must change nothing.
   *
   *  It carries the caller's *real* session id: since the API now checks that a
   *  token's session is still live, a fabricated id would be refused as an ended
   *  session (401) rather than testing the claim this check is about (403). */
  function forgedAdminClaim(userId, secret, sid) {
    const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url')
    const now = Math.floor(Date.now() / 1000)
    const header = b64({ alg: 'HS256', typ: 'JWT' })
    const payload = b64({
      sub: userId,
      email: userEmail,
      sid: sid || 'forged-verify-claim',
      role: 'admin',
      iss: 'alpha-platform',
      aud: 'alpha-clients',
      iat: now,
      exp: now + 3600
    })
    const sig = createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url')
    return `${header}.${payload}.${sig}`
  }

  try {
    for (const [email, password, isAdmin] of [
      [adminEmail, adminPassword, true],
      [userEmail, userPassword, false]
    ]) {
      const uid = (await client.query('select public.provision_user($1) as id', [email])).rows[0].id
      ids.push(uid)
      // These accounts stand in for people who signed in through a code or a
      // provider, both of which prove the mailbox. Without this they would be
      // refused the download for a reason the fixture invented, not the product.
      await client.query('select public.mark_email_verified($1)', [uid])
      if (isAdmin) {
        await client.query(
          `insert into public.admin_users (user_id, role_id)
           select $1, id from public.admin_roles where code = 'owner' on conflict do nothing`,
          [uid]
        )
      }
      await client.query(
        `insert into public.password_credentials (user_id, password_hash, algo)
         values ($1, $2, 'scrypt') on conflict (user_id) do update set password_hash = excluded.password_hash`,
        [uid, hashPassword(password)]
      )
    }

    // 1. The administrator can sign in with the password.
    const login = await call('/auth/password', {
      method: 'POST',
      body: { email: adminEmail, password: adminPassword }
    })
    const adminToken = login.json?.accessToken
    if (login.status === 200 && adminToken) {
      record('PASS', 'administrator password sign-in returns a session', `email=${adminEmail}`)
    } else {
      record('FAIL', 'administrator password sign-in returns a session', `status=${login.status}`)
    }

    // 2. The wrong password is refused for an account that exists.
    const badPassword = await call('/auth/password', {
      method: 'POST',
      body: { email: adminEmail, password: `${adminPassword}-wrong` }
    })
    if (badPassword.status === 401) record('PASS', 'wrong password is refused', '401')
    else record('FAIL', 'wrong password is refused', `status=${badPassword.status}`)

    // 3. An ordinary account holding a password signs in — and the `admin` flag is
    //    read from the database rather than being the constant it used to be when
    //    this route was administrators-only.
    const memberLogin = await call('/auth/password', {
      method: 'POST',
      body: { email: userEmail, password: userPassword }
    })
    if (memberLogin.status === 200 && memberLogin.json?.accessToken && memberLogin.json?.admin === false) {
      record('PASS', 'a member with a password signs in and is not an administrator', 'admin=false')
    } else {
      record(
        'FAIL',
        'a member with a password signs in and is not an administrator',
        `status=${memberLogin.status} admin=${String(memberLogin.json?.admin)}`
      )
    }

    // 4. An account with no credential still cannot sign in this way: the password
    //    path must not become a way to authenticate anything that exists.
    const noCredentialEmail = `verify-nopw-${stamp}@example.invalid`
    const noCredentialUid = (
      await client.query('select public.provision_user($1) as id', [noCredentialEmail])
    ).rows[0].id
    ids.push(noCredentialUid)
    await client.query('select public.mark_email_verified($1)', [noCredentialUid])
    const noCredential = await call('/auth/password', {
      method: 'POST',
      body: { email: noCredentialEmail, password: 'Any-Long-Password-123' }
    })
    if (noCredential.status === 401) {
      record('PASS', 'an account without a password cannot sign in with one', '401')
    } else {
      record('FAIL', 'an account without a password cannot sign in with one', `status=${noCredential.status}`)
    }

    if (adminToken) {
      // 4. The session carries real, database-enforced administrator rights.
      const overview = await adminCall('overview', { token: adminToken })
      if (overview.status === 200 && overview.json?.ok && typeof overview.data?.users === 'number') {
        record('PASS', 'the admin session can read GET /admin/overview', `users=${overview.data.users}`)
      } else {
        record('FAIL', 'the admin session can read GET /admin/overview', `status=${overview.status}`)
      }

      // 5. The desktop app's own contract still answers for a signed-in account:
      //    /platform/config is what the workspace calls on every launch.
      const platformConfig = await call('/platform/config', { token: adminToken })
      if (platformConfig.status === 200 && platformConfig.json && typeof platformConfig.json === 'object') {
        record('PASS', '/platform/config answers for a signed-in account', `plan=${platformConfig.json.plan?.code ?? 'n/a'}`)
      } else {
        record('FAIL', '/platform/config answers for a signed-in account', `status=${platformConfig.status}`)
      }

      // 6. Every panel of the admin portal is backed by one of these routes, so a
      //    failure here is a failure the dashboard would show as an empty panel.
      for (const panel of ['users', 'catalog', 'releases', 'audit']) {
        const res = await adminCall(panel, { token: adminToken })
        const shape = Array.isArray(res.data)
          ? `${res.data.length} row(s)`
          : res.data && typeof res.data === 'object'
            ? 'object'
            : typeof res.data
        if (res.status === 200 && res.json?.ok) record('PASS', `admin ${panel} panel answers`, shape)
        else record('FAIL', `admin ${panel} panel answers`, `status=${res.status} ${res.json?.error?.message ?? ''}`)
      }

      const device = await call('/platform/device', {
        method: 'POST',
        token: adminToken,
        body: { platform: 'win32', appVersion: '0.0.0-verify' }
      })
      if (device.status === 200) record('PASS', '/platform/device records a launch', '200')
      else record('FAIL', '/platform/device records a launch', `status=${device.status}`)

      // 6. The same session reaches the gated download surface.
      const download = await call('/downloads/latest', { token: adminToken })
      const release = download.json?.release
      if (download.status === 200 && release?.version) {
        record('PASS', 'a signed-in account gets the release metadata', `version=${release.version} size=${release.size}`)
      } else {
        record('FAIL', 'a signed-in account gets the release metadata', `status=${download.status}`)
      }

      // 7. A suspended account is cut off by the server, not the UI.
      await client.query("update public.users set status = 'suspended' where id = $1", [ids[0]])
      const suspendedDownload = await call('/downloads/latest', { token: adminToken })
      const suspendedLogin = await call('/auth/password', {
        method: 'POST',
        body: { email: adminEmail, password: adminPassword }
      })
      if (suspendedDownload.status === 403 && suspendedLogin.status === 401) {
        record('PASS', 'a suspended account loses the download and the login', `download=${suspendedDownload.status} login=${suspendedLogin.status}`)
      } else {
        record('FAIL', 'a suspended account loses the download and the login', `download=${suspendedDownload.status} login=${suspendedLogin.status}`)
      }
      await client.query("update public.users set status = 'active' where id = $1", [ids[0]])

      // 8. One-time OAuth codes are single use.
      const code = randomBytes(32).toString('base64url')
      const codeHash = createHash('sha256').update(`${pepper}:${code}`).digest('hex')
      await client.query(
        `insert into public.auth_oauth_codes (code_hash, user_id, expires_at)
         values ($1, $2, now() + interval '5 minutes')`,
        [codeHash, ids[0]]
      )
      const exchanged = await call('/auth/oauth/exchange', { method: 'POST', body: { code } })
      const replayed = await call('/auth/oauth/exchange', { method: 'POST', body: { code } })
      if (exchanged.status === 200 && exchanged.json?.accessToken && replayed.status === 400) {
        record('PASS', 'an OAuth code exchanges once and cannot be replayed', `first=${exchanged.status} replay=${replayed.status}`)
      } else {
        record('FAIL', 'an OAuth code exchanges once and cannot be replayed', `first=${exchanged.status} replay=${replayed.status}`)
      }

      // 9. The admin surface must refuse an *authenticated but ordinary* session.
      //    This is the check that makes "modify the frontend request" pointless:
      //    the token is genuine and unexpired, and it still gets nothing.
      const userToken = await sessionFor(ids[1])
      if (!userToken) {
        record('FAIL', 'an ordinary session can be minted for the authorization checks', 'no access token')
      } else {
        const userRpc = await adminCall('overview', { token: userToken })
        if (userRpc.status === 403 && userRpc.json?.error?.code === 'forbidden') {
          record('PASS', 'an ordinary session is refused by GET /admin/overview', '403 forbidden')
        } else {
          record('FAIL', 'an ordinary session is refused by GET /admin/overview', `status=${userRpc.status}`)
        }

        const userSystem = await call('/admin/system', { token: userToken })
        if (userSystem.status === 403) record('PASS', 'an ordinary session is refused by /admin/system', '403')
        else record('FAIL', 'an ordinary session is refused by /admin/system', `status=${userSystem.status}`)

        // 10. A *correctly signed* token that merely claims `role: admin` must be
        //     worth exactly as much as any other non-administrator session.
        const secret = process.env.AUTH_JWT_SECRET || local.AUTH_JWT_SECRET
        if (!secret) {
          record('NOT RUN', 'a forged admin claim is still refused', 'AUTH_JWT_SECRET not available locally')
        } else {
          const forged = await adminCall('overview', {
            token: forgedAdminClaim(ids[1], secret, tokenClaims(userToken)?.sid)
          })
          if (forged.status === 403) {
            record('PASS', 'a signed token claiming role=admin is still refused', '403')
          } else {
            record('FAIL', 'a signed token claiming role=admin is still refused', `status=${forged.status}`)
          }
        }

        // 11. Role changes take effect live and server-side: the *same* token that
        //     was just refused must work once the database grants the role, and be
        //     refused again the moment it is revoked.
        const granted = await adminCall('setAdmin', {
          id: ids[1],
          token: adminToken,
          body: { admin: true, roleCode: 'admin' }
        })
        const afterGrant = granted.json?.ok ? await adminCall('overview', { token: userToken }) : null
        if (granted.data?.isAdmin === true && afterGrant?.status === 200) {
          record('PASS', 'granting the role lets the live session through', 'POST /admin/users/:id/admin -> 200')
        } else {
          record('FAIL', 'granting the role lets the live session through', `grant=${granted.status} read=${afterGrant?.status ?? 'n/a'}`)
        }

        const revoked = await adminCall('setAdmin', {
          id: ids[1],
          token: adminToken,
          body: { admin: false, roleCode: 'admin' }
        })
        const afterRevoke = revoked.json?.ok ? await adminCall('overview', { token: userToken }) : null
        if (revoked.data?.isAdmin === false && afterRevoke?.status === 403) {
          record('PASS', 'revoking the role cuts the live session off again', 'POST /admin/users/:id/admin -> 403')
        } else {
          record('FAIL', 'revoking the role cuts the live session off again', `revoke=${revoked.status} read=${afterRevoke?.status ?? 'n/a'}`)
        }

        // 12. The last owner cannot be demoted, so the product cannot lock itself out.
        const selfDemote = await adminCall('setAdmin', {
          id: ids[0],
          token: adminToken,
          body: { admin: false, roleCode: 'admin' }
        })
        if (selfDemote.status === 409 && selfDemote.json?.error?.code === 'cannot_remove_own_admin') {
          record('PASS', 'an administrator cannot remove its own admin rights', '409 cannot_remove_own_admin')
        } else {
          record('FAIL', 'an administrator cannot remove its own admin rights', `status=${selfDemote.status} code=${selfDemote.json?.error?.code ?? 'none'}`)
        }
      }
    }

    // ---------------------------------------------------------------- passwords
    // The member password lifecycle, driven through the real API. Codes are minted
    // here rather than read from mail: this run has no mailbox, and what is being
    // proven is the account/session/download behaviour that follows a confirmed
    // code. Delivery itself is the one part only a human can check.
    const pwStamp = Date.now()
    const newEmail = `verify-pw-${pwStamp}@example.invalid`
    const secondEmail = `verify-pw2-${pwStamp}@example.invalid`
    const firstPassword = `Harbour-Basalt-${pwStamp}-Tide`
    const secondPassword = `Lantern-Meadow-${pwStamp}-Ridge`
    const thirdPassword = `Copper-Lantern-${pwStamp}-Harbour`

    /** Mint a code row for an address, the part the mailbox would normally do. */
    async function mintCode(email) {
      const value = String(Math.floor(Math.random() * 1_000_000)).padStart(6, '0')
      const digest = createHash('sha256').update(`${pepper}:${value}`).digest('hex')
      await client.query('update public.auth_otps set consumed_at = now() where lower(email) = $1 and consumed_at is null', [email])
      await client.query(
        `insert into public.auth_otps (email, code_hash, magic_hash, expires_at)
         values ($1, $2, $3, now() + interval '10 minutes')`,
        [email, digest, `${digest}-magic`]
      )
      return value
    }

    // 13. Sign-up accepts a password without claiming a session, and answers a
    //     second address identically — the response is not an account oracle.
    const registered = await call('/auth/register', {
      method: 'POST',
      body: { email: newEmail, password: firstPassword }
    })
    if (registered.status === 202 && registered.json?.ok && registered.json?.needsVerification === true) {
      record('PASS', 'sign-up takes an email and password without claiming a session', '202 needsVerification')
    } else {
      record('FAIL', 'sign-up takes an email and password without claiming a session', `status=${registered.status}`)
    }

    const secondSignUp = await call('/auth/register', {
      method: 'POST',
      body: { email: secondEmail, password: firstPassword }
    })
    if (secondSignUp.status === registered.status) {
      record('PASS', 'sign-up answers a second address the same way', `status=${secondSignUp.status}`)
    } else {
      record('FAIL', 'sign-up answers a second address the same way', `statuses ${registered.status} vs ${secondSignUp.status}`)
    }

    const newRows = (
      await client.query('select id, email, email_verified_at from public.users where lower(email) = any($1::text[])', [
        [newEmail, secondEmail]
      ])
    ).rows
    for (const row of newRows) ids.push(row.id)
    const newRow = newRows.find((row) => row.email.toLowerCase() === newEmail)

    if (newRow && newRow.email_verified_at === null) {
      record('PASS', 'a password sign-up has not proved the mailbox yet', 'email_verified_at is null')
    } else {
      record('FAIL', 'a password sign-up has not proved the mailbox yet', newRow ? 'already verified' : 'no account row')
    }

    // 14. The password they chose signs them in.
    const memberPasswordLogin = await call('/auth/password', {
      method: 'POST',
      body: { email: newEmail, password: firstPassword }
    })
    const newMemberToken = memberPasswordLogin.json?.accessToken
    if (memberPasswordLogin.status === 200 && newMemberToken && memberPasswordLogin.json?.admin === false) {
      record('PASS', 'a new member signs in with the password they chose', 'admin=false')
    } else {
      record(
        'FAIL',
        'a new member signs in with the password they chose',
        `status=${memberPasswordLogin.status} admin=${String(memberPasswordLogin.json?.admin)}`
      )
    }

    // 15. A password is knowledge, not proof of the mailbox: the installer waits.
    if (newMemberToken) {
      const unverifiedDownload = await call('/downloads/latest', { token: newMemberToken })
      if (unverifiedDownload.status === 403 && unverifiedDownload.json?.error?.code === 'email_unverified') {
        record('PASS', 'an unconfirmed address is refused the installer', '403 email_unverified')
      } else {
        record(
          'FAIL',
          'an unconfirmed address is refused the installer',
          `status=${unverifiedDownload.status} code=${unverifiedDownload.json?.error?.code ?? 'none'}`
        )
      }
    }

    // 16. Redeeming the code confirms the address, and the installer follows.
    const confirmCode = await mintCode(newEmail)
    const confirmed = await call('/auth/verify', {
      method: 'POST',
      body: { email: newEmail, code: confirmCode }
    })
    const confirmedToken = confirmed.json?.accessToken
    if (confirmed.status === 200 && confirmedToken) {
      record('PASS', 'redeeming the emailed code confirms the address and signs in', '200')
    } else {
      record('FAIL', 'redeeming the emailed code confirms the address and signs in', `status=${confirmed.status}`)
    }

    if (confirmedToken) {
      const confirmedDownload = await call('/downloads/latest', { token: confirmedToken })
      if (confirmedDownload.status === 200 && confirmedDownload.json?.release?.version) {
        record('PASS', 'a confirmed member is handed the current installer', `version=${confirmedDownload.json.release.version}`)
      } else {
        record('FAIL', 'a confirmed member is handed the current installer', `status=${confirmedDownload.status}`)
      }

      // 17. Changing it from a live session: the old password stops working and
      //     other devices are signed out.
      const changed = await call('/auth/password/change', {
        method: 'POST',
        token: confirmedToken,
        body: { currentPassword: firstPassword, newPassword: secondPassword }
      })
      if (changed.status === 200 && changed.json?.ok) {
        record('PASS', 'a signed-in member can change their password', `revokedOthers=${changed.json.revokedOthers ?? 0}`)
      } else {
        record('FAIL', 'a signed-in member can change their password', `status=${changed.status}`)
      }

      const replacedLogin = await call('/auth/password', {
        method: 'POST',
        body: { email: newEmail, password: firstPassword }
      })
      if (replacedLogin.status === 401) record('PASS', 'the replaced password no longer signs in', '401')
      else record('FAIL', 'the replaced password no longer signs in', `status=${replacedLogin.status}`)
    }

    // 18. Forgot-password answers without describing the account, and its code
    //     sets a new password exactly once.
    const forgot = await call('/auth/password/forgot', { method: 'POST', body: { email: newEmail } })
    if (forgot.status === 202 && forgot.json?.ok) {
      record('PASS', 'forgot-password answers without describing the account', '202')
    } else {
      record('FAIL', 'forgot-password answers without describing the account', `status=${forgot.status}`)
    }

    const resetCode = await mintCode(newEmail)
    const reset = await call('/auth/password/reset', {
      method: 'POST',
      body: { email: newEmail, code: resetCode, password: thirdPassword }
    })
    if (reset.status === 200 && reset.json?.ok) {
      record('PASS', 'a reset code sets a new password', '200')
    } else {
      record('FAIL', 'a reset code sets a new password', `status=${reset.status}`)
    }

    const replay = await call('/auth/password/reset', {
      method: 'POST',
      body: { email: newEmail, code: resetCode, password: 'Replay-Attempt-4711-Cobalt' }
    })
    if (replay.status === 400 && replay.json?.error?.code === 'invalid_code') {
      record('PASS', 'a reset code cannot be replayed', '400 invalid_code')
    } else {
      record('FAIL', 'a reset code cannot be replayed', `status=${replay.status} code=${replay.json?.error?.code ?? 'none'}`)
    }

    const resetLogin = await call('/auth/password', {
      method: 'POST',
      body: { email: newEmail, password: thirdPassword }
    })
    if (resetLogin.status === 200 && resetLogin.json?.accessToken) {
      record('PASS', 'the reset password signs in', '200')
    } else {
      record('FAIL', 'the reset password signs in', `status=${resetLogin.status}`)
    }
  } finally {
    // Always clean up, even when an assertion threw above.
    if (ids.length) {
      // Audit rows this run wrote, by actor and by target, then the accounts
      // themselves (sessions, credentials, overrides cascade from users).
      await client.query('delete from public.audit_logs where actor_id = any($1::uuid[])', [ids])
      await client.query('delete from public.audit_logs where target = any($1::text[])', [ids])
      await client.query('delete from public.auth_otps where lower(email) like $1', ['verify-%@example.invalid'])
      await client.query('delete from public.users where id = any($1::uuid[])', [ids])
    }
    // admin_users rows (and sessions, credentials, overrides) cascade from users.
    const leftovers = await client.query(
      'select count(*)::int as n from public.users where email like $1',
      ['verify-%@example.invalid']
    )
    console.log(`\ncleanup: ${ids.length} temporary account(s) removed, ${leftovers.rows[0].n} leftover`)
  }
  await client.end()
}

console.log(`Alpha auth verification\napi:  ${API}\nsite: ${SITE}\nmode: ${withWrite ? 'read + write' : 'read-only'}\n`)
await readOnlyChecks()
if (withWrite) await writeChecks()

const failed = results.filter((r) => r.status === 'FAIL').length
console.log(`\n${results.length - failed} passed, ${failed} failed`)
process.exitCode = failed ? 1 : 0
