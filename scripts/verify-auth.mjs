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

  /** A correctly signed token whose `role` claim simply *says* administrator.
   *  Authorization must come from the database, so this must change nothing. */
  function forgedAdminClaim(userId, secret) {
    const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url')
    const now = Math.floor(Date.now() / 1000)
    const header = b64({ alg: 'HS256', typ: 'JWT' })
    const payload = b64({
      sub: userId,
      email: userEmail,
      sid: 'forged-verify-claim',
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

    // 3. An ordinary account holding a password still gets nothing.
    const nonAdmin = await call('/auth/password', {
      method: 'POST',
      body: { email: userEmail, password: userPassword }
    })
    if (nonAdmin.status === 401) {
      record('PASS', 'a non-administrator cannot sign in through the admin path', '401')
    } else {
      record('FAIL', 'a non-administrator cannot sign in through the admin path', `status=${nonAdmin.status}`)
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
          const forged = await adminCall('overview', { token: forgedAdminClaim(ids[1], secret) })
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
  } finally {
    // Always clean up, even when an assertion threw above.
    if (ids.length) {
      await client.query('delete from public.audit_logs where actor_id = any($1::uuid[])', [ids])
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
