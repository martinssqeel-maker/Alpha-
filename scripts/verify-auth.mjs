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
import { randomBytes, scryptSync } from 'node:crypto'
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
      const overview = await call('/admin/rpc', {
        method: 'POST',
        token: adminToken,
        body: { fn: 'admin_overview', params: {} }
      })
      if (overview.status === 200 && overview.json?.ok && typeof overview.json.result?.users === 'number') {
        record('PASS', 'the admin session can read /admin/rpc', `users=${overview.json.result.users}`)
      } else {
        record('FAIL', 'the admin session can read /admin/rpc', `status=${overview.status}`)
      }

      // 5. The desktop app's own contract still answers for a signed-in account:
      //    /platform/config is what the workspace calls on every launch.
      const platformConfig = await call('/platform/config', { token: adminToken })
      if (platformConfig.status === 200 && platformConfig.json && typeof platformConfig.json === 'object') {
        record('PASS', '/platform/config answers for a signed-in account', `plan=${platformConfig.json.plan?.code ?? 'n/a'}`)
      } else {
        record('FAIL', '/platform/config answers for a signed-in account', `status=${platformConfig.status}`)
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
      const { createHash } = await import('node:crypto')
      const pepper = local.AUTH_PEPPER || local.AUTH_JWT_SECRET || ''
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
    }
  } finally {
    // Always clean up, even when an assertion threw above.
    if (ids.length) {
      await client.query('delete from public.audit_logs where actor_id = any($1::uuid[])', [ids])
      await client.query('delete from public.users where id = any($1::uuid[])', [ids])
    }
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
