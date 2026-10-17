#!/usr/bin/env node
/**
 * Live verification of the Admin Control Center's *effects*.
 *
 * `verify:auth` proves the admin surface cannot be reached without administrator
 * rights. This script answers the other half of the requirement: that every
 * control the portal presents is connected to something real. For each control it
 * changes the value through the same REST route the portal calls, then reads the
 * result back through the surface a *user* actually sees — the desktop app's own
 * `/platform/config`, `/downloads/latest`, and the public sign-in route.
 *
 *   npm run verify:admin
 *
 * Before any product data is written the script checks every route it is about
 * to drive against the deployment, using the ordinary session it just minted: a
 * route that exists refuses that account with `403`, while a route that has been
 * removed answers `404 not_found`. That preflight is what stops this file from
 * silently drifting out of date with the API again — it used to drive a retired
 * `admin/rpc` endpoint, and reported the resulting 404s as product failures.
 *
 * (An anonymous probe cannot do this job: `requireAuth` mounts on the whole
 * admin router, so a retired route answers `401` too.)
 *
 * It writes to the database, so it is not a read-only probe. Everything it
 * touches is restored in a `finally` block: a throwaway administrator and user
 * are created and deleted, the feature flag and announcement it creates are
 * removed, and `maintenance` / `desktop_versions` are written back exactly as
 * they were found. Temporary accounts are named `verify-admin-<stamp>` /
 * `verify-user-<stamp>` at `@example.invalid`.
 *
 * Requires DATABASE_URL (for setup, restoration and cross-checks) and the API
 * base URL, both read from `.env.local`.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash, randomBytes, scryptSync } from 'node:crypto'
import pg from 'pg'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

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
const DATABASE_URL = process.env.DATABASE_URL || local.DATABASE_URL || ''
const PEPPER = local.AUTH_PEPPER || local.AUTH_JWT_SECRET || ''

if (!API || !DATABASE_URL) {
  console.error('Set NEON_FUNCTION_API_BASE_URL and DATABASE_URL in .env.local first.')
  process.exit(1)
}

/**
 * Every administrative control this script drives, as the route the portal
 * itself calls. `tests/adminRouteParity.test.ts` asserts these paths are mounted
 * by `platform/api/admin.ts`, so a route that moves breaks a test instead of
 * producing fifteen misleading failures against a live deployment.
 */
const ROUTES = {
  metrics: ['GET', '/admin/metrics'],
  overview: ['GET', '/admin/overview'],
  system: ['GET', '/admin/system'],
  audit: ['GET', '/admin/audit'],
  releases: ['GET', '/admin/releases'],
  settings: ['POST', '/admin/settings'],
  flags: ['POST', '/admin/flags'],
  announcements: ['POST', '/admin/announcements'],
  userStatus: ['POST', '/admin/users/:id/status']
}

const PLACEHOLDER_ID = '00000000-0000-0000-0000-000000000000'

const results = []
function record(status, name, detail) {
  results.push({ status, name })
  console.log(`${status.padEnd(7)} ${name}${detail ? ` — ${detail}` : ''}`)
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

/** Same digest format as platform/api/password.ts; drift shows up as a failed login. */
function hashPassword(password) {
  const salt = randomBytes(16)
  const digest = scryptSync(password, salt, 64, { N: 16_384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 })
  return ['scrypt', 16_384, 8, 1, salt.toString('base64url'), digest.toString('base64url')].join('$')
}

const stamp = Date.now()
const adminEmail = `verify-admin-${stamp}@example.invalid`
const userEmail = `verify-user-${stamp}@example.invalid`
const adminPassword = `Basalt-Harbour-${stamp}-Quarry`
const flagKey = `verify_toggle_${stamp}`
const maintenanceMarker = `VERIFY-MAINTENANCE-${stamp}`

const isLocal = /localhost|127\.0\.0\.1/.test(DATABASE_URL)
const client = new pg.Client({
  connectionString: DATABASE_URL,
  ssl: isLocal ? undefined : { rejectUnauthorized: false }
})

let adminToken = null
let userToken = null
let userId = null
let adminId = null
let announcementId = null
let previousSettings = {}

/**
 * Drive one administrative control exactly as the portal does, and hand back the
 * unwrapped `data` payload. The API answers `{ok:true, data}` on success and
 * `{ok:false, error}` otherwise, so a status of 200 plus a `data` field is the
 * only shape that counts as a real answer.
 */
async function adminCall(name, { id, body, token = adminToken, query } = {}) {
  const [method, template] = ROUTES[name]
  let pathname = template.replace(':id', id ?? PLACEHOLDER_ID)
  if (query) {
    const search = new URLSearchParams(Object.entries(query).map(([k, v]) => [k, String(v)]))
    pathname += `?${search.toString()}`
  }
  const res = await call(pathname, { method, body, token })
  return { ...res, data: res.json?.data ?? null }
}

/**
 * Prove the deployment still serves every route about to be driven, before any
 * product setting is written.
 *
 * The probe uses the ordinary (non-administrator) session, which is the only
 * caller that can tell the two failure modes apart: an existing admin route stops
 * at `require_admin` with `403`, a removed route falls through to the router's
 * `404 not_found`. A body-less POST may be rejected as `400` before authorization
 * runs; that is still proof the route is mounted.
 */
async function preflight() {
  const missing = []
  const odd = []
  for (const [name, [method, template]] of Object.entries(ROUTES)) {
    const pathname = template.replace(':id', PLACEHOLDER_ID)
    const res = await call(pathname, { method, body: method === 'POST' ? {} : undefined, token: userToken })
    if (res.status === 404) missing.push(`${method} ${template}`)
    else if (![200, 400, 403, 409].includes(res.status)) odd.push(`${method} ${template} -> ${res.status}`)
  }

  if (missing.length) {
    record('FAIL', 'every admin route this script drives exists on the deployment', `missing ${missing.join(', ')}`)
    return false
  }
  record('PASS', 'every admin route this script drives exists on the deployment', `${Object.keys(ROUTES).length} routes`)
  for (const line of odd) record('WARN', 'preflight got an unexpected answer', line)
  return true
}

/** `/platform/config` through the eyes of the ordinary temp user. */
async function userConfig() {
  const res = await call('/platform/config', { token: userToken })
  return res.json
}

/** Mint a real session for a user via the one-time-code exchange the site uses. */
async function sessionFor(uid) {
  const code = randomBytes(32).toString('base64url')
  const codeHash = createHash('sha256').update(`${PEPPER}:${code}`).digest('hex')
  await client.query(
    `insert into public.auth_oauth_codes (code_hash, user_id, expires_at)
     values ($1, $2, now() + interval '5 minutes')`,
    [codeHash, uid]
  )
  const res = await call('/auth/oauth/exchange', { method: 'POST', body: { code } })
  return res.json?.accessToken ?? null
}

async function setSetting(key, value) {
  return adminCall('settings', { body: { key, value } })
}

async function setup() {
  await client.connect()

  const settings = await client.query('select key, value from public.system_settings')
  previousSettings = Object.fromEntries(settings.rows.map((r) => [r.key, r.value]))

  adminId = (await client.query('select public.provision_user($1) as id', [adminEmail])).rows[0].id
  userId = (await client.query('select public.provision_user($1) as id', [userEmail])).rows[0].id

  await client.query(
    `insert into public.admin_users (user_id, role_id)
     select $1, id from public.admin_roles where code = 'owner' on conflict do nothing`,
    [adminId]
  )
  await client.query(
    `insert into public.password_credentials (user_id, password_hash, algo)
     values ($1, $2, 'scrypt') on conflict (user_id) do update set password_hash = excluded.password_hash`,
    [adminId, hashPassword(adminPassword)]
  )

  const login = await call('/auth/password', {
    method: 'POST',
    body: { email: adminEmail, password: adminPassword }
  })
  adminToken = login.json?.accessToken ?? null
  if (login.status === 200 && adminToken) {
    record('PASS', 'administrator password sign-in works', `200 ${adminEmail}`)
  } else {
    record('FAIL', 'administrator password sign-in works', `status=${login.status}`)
  }

  userToken = await sessionFor(userId)
  if (userToken) record('PASS', 'an ordinary user session can be minted', userEmail)
  else record('FAIL', 'an ordinary user session can be minted', 'no access token')
}

async function authorization() {
  if (!userToken) return

  const overview = await adminCall('overview', { token: userToken })
  if (overview.status === 403 && overview.json?.error?.code === 'forbidden') {
    record('PASS', 'an ordinary session cannot read the admin overview', '403 forbidden')
  } else {
    record('FAIL', 'an ordinary session cannot read the admin overview', `status=${overview.status}`)
  }

  const system = await adminCall('system', { token: userToken })
  if (system.status === 403 && system.json?.error?.code === 'forbidden') {
    record('PASS', 'an ordinary session cannot read admin system status', '403 forbidden')
  } else {
    record('FAIL', 'an ordinary session cannot read admin system status', `status=${system.status}`)
  }
}

async function metricsAreReal() {
  const res = await adminCall('metrics')
  const total = res.data?.users?.total
  const actual = (await client.query('select count(*)::int as n from public.users')).rows[0].n

  if (res.status === 200 && total === actual) {
    record('PASS', 'dashboard metrics match the database', `users.total=${total}`)
  } else {
    record('FAIL', 'dashboard metrics match the database', `api=${total} db=${actual} status=${res.status}`)
  }
}

async function featureFlagEffect() {
  const before = await userConfig()
  if (before?.flags?.[flagKey] !== undefined) {
    record('FAIL', 'the test flag is not present before it is created', JSON.stringify(before?.flags))
    return
  }

  await adminCall('flags', {
    body: { key: flagKey, enabled: true, description: 'verify-admin temporary flag', rollout: 100 }
  })
  const on = await userConfig()
  const enabled = on?.flags?.[flagKey] === true

  await adminCall('flags', {
    body: { key: flagKey, enabled: false, description: 'verify-admin temporary flag', rollout: 100 }
  })
  const off = await userConfig()
  const hidden = off?.flags?.[flagKey] === undefined

  if (enabled && hidden) {
    record('PASS', 'a feature flag toggle reaches the desktop config', 'on -> present, off -> absent')
  } else {
    record('FAIL', 'a feature flag toggle reaches the desktop config', `enabled=${enabled} hiddenWhenOff=${hidden}`)
  }
}

async function announcementEffect() {
  const created = await adminCall('announcements', {
    body: {
      title: `Maintenance notice ${stamp}`,
      body: 'Created by scripts/verify-admin.mjs',
      level: 'warning',
      active: true
    }
  })
  announcementId = created.data ?? null

  const live = await userConfig()
  const visible = (live?.announcements ?? []).some((a) => a.title === `Maintenance notice ${stamp}`)

  await adminCall('announcements', { body: { id: announcementId, active: false } })
  const after = await userConfig()
  const hidden = !(after?.announcements ?? []).some((a) => a.title === `Maintenance notice ${stamp}`)

  if (announcementId && visible && hidden) {
    record('PASS', 'an announcement reaches the desktop config and can be withdrawn', 'visible then withdrawn')
  } else {
    record('FAIL', 'an announcement reaches the desktop config and can be withdrawn', `visible=${visible} hidden=${hidden}`)
  }
}

async function desktopSettingEffect() {
  // minVersion well below anything runs, so the probe can never block a client.
  const value = { current: '9.9.9-verify', minVersion: '0.0.0', recommendedVersion: '9.9.9-verify' }
  await setSetting('desktop_versions', value)
  const after = await userConfig()
  const reached =
    after?.desktop?.current === '9.9.9-verify' && after?.desktop?.recommendedVersion === '9.9.9-verify'

  if (reached) {
    record('PASS', 'the application-version control reaches the desktop config', JSON.stringify(after.desktop))
  } else {
    record('FAIL', 'the application-version control reaches the desktop config', JSON.stringify(after?.desktop))
  }
}

async function maintenanceEffect() {
  await setSetting('maintenance', { active: true, message: maintenanceMarker })

  const blocked = await call('/auth/request', {
    method: 'POST',
    body: { email: `verify-maintenance-${stamp}@example.invalid` }
  })
  const honest =
    blocked.status === 503 &&
    blocked.json?.error?.code === 'maintenance' &&
    String(blocked.json?.error?.message ?? '').includes(maintenanceMarker)

  const adminLogin = await call('/auth/password', {
    method: 'POST',
    body: { email: adminEmail, password: adminPassword }
  })
  const adminKeeps = adminLogin.status === 200

  await setSetting('maintenance', { active: false, message: '' })
  const restored = await call('/auth/request', {
    method: 'POST',
    body: { email: `verify-maintenance-${stamp}@example.invalid` }
  })
  const reopened = restored.status === 200

  if (honest && adminKeeps && reopened) {
    record('PASS', 'maintenance mode blocks ordinary sign-in with the admin message', `503 + "${maintenanceMarker}"`)
    record('PASS', 'maintenance mode leaves administrators a way in', 'admin 200 while blocked')
    record('PASS', 'leaving maintenance mode reopens sign-in', '200')
  } else {
    record('FAIL', 'maintenance mode blocks ordinary sign-in with the admin message', `honest=${honest} admin=${adminLogin.status} restored=${restored.status}`)
  }
}

async function accountStatusEffect() {
  const active = await call('/downloads/latest', { token: userToken })
  await adminCall('userStatus', { id: userId, body: { status: 'suspended' } })
  const suspended = await call('/downloads/latest', { token: userToken })
  await adminCall('userStatus', { id: userId, body: { status: 'active' } })
  const restored = await call('/downloads/latest', { token: userToken })

  if (active.status === 200 && suspended.status === 403 && restored.status === 200) {
    record('PASS', 'disabling an account really cuts the user off', '200 -> 403 -> 200')
  } else {
    record('FAIL', 'disabling an account really cuts the user off', `${active.status} -> ${suspended.status} -> ${restored.status}`)
  }

  const releaseVersion = restored.json?.release?.version ?? null
  const published = await adminCall('releases')
  const publishedVersion = (published.data ?? []).find((r) => r.published)?.version ?? null
  if (releaseVersion && releaseVersion === publishedVersion) {
    record('PASS', 'the release the portal publishes is the one users download', `v${releaseVersion}`)
  } else {
    record('FAIL', 'the release the portal publishes is the one users download', `download=${releaseVersion} published=${publishedVersion}`)
  }
}

async function auditTrail() {
  const log = await adminCall('audit', { query: { limit: 50 } })
  const actions = new Set((log.data ?? []).map((row) => row.action))
  const expected = ['flag.upsert', 'announcement.upsert', 'setting.set', 'user.set_status']
  const missing = expected.filter((a) => !actions.has(a))
  if (missing.length === 0) {
    record('PASS', 'every admin change above was written to the audit log', expected.join(', '))
  } else {
    record('FAIL', 'every admin change above was written to the audit log', `missing ${missing.join(', ')}`)
  }

  const leaked = (log.text || '').match(/sk-[A-Za-z0-9]{8,}|password_hash|refresh_hash/)
  if (leaked) record('FAIL', 'the audit log carries no secrets', leaked[0])
  else record('PASS', 'the audit log carries no secrets', 'no key/hash patterns found')
}

console.log(`Alpha admin control verification\napi:  ${API}\nmode: write + restore\n`)

await setup()

// Nothing that changes the product is touched until the routes are known to
// exist. A stale script then costs two throwaway accounts and no settings churn.
const routesReady = await preflight()
if (!routesReady) {
  console.log('\nRefusing to drive the controls: the deployment does not serve every route above.')
} else {
  await authorization()
  await metricsAreReal()
  await featureFlagEffect()
  await announcementEffect()
  await desktopSettingEffect()
  await maintenanceEffect()
  await accountStatusEffect()
  await auditTrail()
}

// Restore everything, whatever happened above.
try {
  // Only write settings back if the run got far enough to change them.
  if (routesReady) {
    for (const [key, value] of Object.entries(previousSettings)) {
      await setSetting(key, value)
    }
  }
  if (announcementId) await client.query('delete from public.announcements where id = $1', [announcementId])
  // Any probe flag this script has ever created, not just this run's.
  await client.query("delete from public.feature_flags where key like 'verify_toggle_%'")
  if (adminId && userId) {
    await client.query('delete from public.audit_logs where actor_id = any($1::uuid[]) or target = any($2::text[])', [
      [adminId, userId],
      [adminId, userId, flagKey, announcementId].filter(Boolean)
    ])
    await client.query('delete from public.users where id = any($1::uuid[])', [[adminId, userId]])
  }
  await client.query('delete from public.auth_attempts where key like $1', [`%${stamp}%`])

  const settings = await client.query('select key, value from public.system_settings order by key')
  const flags = await client.query('select key from public.feature_flags where key = $1', [flagKey])
  const users = await client.query("select count(*)::int as n from public.users where email like '%@example.invalid'")
  console.log(
    `\nrestore: settings=${settings.rows.length} row(s), test flag removed=${flags.rowCount === 0}, leftover test accounts=${users.rows[0].n}`
  )
  for (const row of settings.rows) {
    console.log(`  ${row.key} = ${JSON.stringify(row.value)}`)
  }
} finally {
  await client.end()
}

const failed = results.filter((r) => r.status === 'FAIL').length
console.log(`\n${results.length - failed} passed, ${failed} failed`)
process.exitCode = failed ? 1 : 0
