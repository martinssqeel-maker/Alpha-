#!/usr/bin/env node
/**
 * Live smoke check for the deployed Alpha platform API.
 *
 * Read-only by default: it never signs anything in and never creates a session.
 * Every request is an unauthenticated probe, so it is safe to run against
 * production.
 *
 * Usage:
 *   npm run smoke                                # against the recorded API base URL
 *   npm run smoke -- --url https://...           # a different Function/branch
 *   npm run smoke -- --website https://...       # also check the website config
 *   npm run smoke -- --email you@example.com     # ALSO exercise the sign-in path
 *
 * ```--email``` is opt in because `POST /auth/request` creates an OTP row and,
 * when EMAIL_PROVIDER=resend, actually sends mail. Use an address you own.
 *
 * Exit status: 0 when nothing failed (warnings allowed), 1 on any failure.
 */
const DEFAULT_API = 'https://br-flat-morning-b41hcfhc-api.compute.c-6.us-east-2.aws.neon.tech'
const TIMEOUT_MS = 20_000

const argv = process.argv.slice(2)
function value(name, fallback) {
  const i = argv.indexOf(name)
  if (i === -1) return fallback
  const next = argv[i + 1]
  return next && !next.startsWith('--') ? next : fallback
}

const apiBase = (value('--url', process.env.SMOKE_API_BASE_URL || DEFAULT_API) || '').replace(/\/+$/, '')
const website = value('--website', process.env.SMOKE_WEBSITE_URL)
const probeEmail = value('--email', null)

const results = []
function record(status, name, detail) {
  results.push({ status, name, detail })
  const tag = status === 'PASS' ? 'PASS' : status === 'WARN' ? 'WARN' : 'FAIL'
  console.log(`${tag}  ${name}${detail ? ` — ${detail}` : ''}`)
}

/**
 * One request with a bounded timeout, releasing its socket afterwards.
 * Aborting once the body is in hand closes the keep-alive connection, so the
 * process can exit immediately instead of waiting for the idle timeout.
 */
async function rawFetch(url, init = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(url, { ...init, signal: controller.signal })
    const text = await res.text()
    return { res, text }
  } finally {
    clearTimeout(timer)
    controller.abort()
  }
}

async function request(pathname, init = {}) {
  const { res, text } = await rawFetch(`${apiBase}${pathname}`, init)
  let json
  try {
    json = JSON.parse(text)
  } catch {
    /* non-JSON body is reported as-is */
  }
  return { res, text, json }
}

/** Assert a protected route rejects an anonymous caller. */
async function expectUnauthorized(name, pathname, init) {
  try {
    const { res, json } = await request(pathname, init)
    if (res.status !== 401) {
      record('FAIL', name, `expected 401, got ${res.status}`)
      return
    }
    const code = json?.error?.code ?? '(no error code)'
    record('PASS', name, `401 ${code}`)
  } catch (error) {
    record('FAIL', name, error.message)
  }
}

console.log(`Alpha platform smoke check\napi: ${apiBase}\n`)

// 1. Liveness. The root and /health routes are unauthenticated by design.
try {
  const { res, json } = await request('/health')
  if (res.status === 200 && json?.ok === true && json?.service === 'alpha-platform-api') {
    record('PASS', 'GET /health', `200 service=alpha-platform-api branch=${json.branch ?? '?'}`)
  } else {
    record('FAIL', 'GET /health', `status=${res.status} body=${JSON.stringify(json)?.slice(0, 120)}`)
  }
} catch (error) {
  record('FAIL', 'GET /health', error.name === 'AbortError' ? `no response in ${TIMEOUT_MS} ms` : error.message)
}

// 2. Every private surface must require a bearer token.
await expectUnauthorized('GET /platform/config requires auth', '/platform/config')
await expectUnauthorized('GET /gateway/models requires auth', '/gateway/models')
await expectUnauthorized('POST /admin/rpc requires auth', '/admin/rpc', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ fn: 'admin_overview', params: {} })
})

// 3. Input validation must reject junk before it reaches the OTP/email path.
try {
  const { res, json } = await request('/auth/request', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'not-an-email' })
  })
  if (res.status === 400 && json?.error?.code === 'invalid_email') {
    record('PASS', 'POST /auth/request rejects malformed email', '400 invalid_email')
  } else {
    record('FAIL', 'POST /auth/request rejects malformed email', `status=${res.status} body=${JSON.stringify(json)?.slice(0, 120)}`)
  }
} catch (error) {
  record('FAIL', 'POST /auth/request rejects malformed email', error.message)
}

// 4. CORS must not reflect an origin that is not ours. A reflected
//    `access-control-allow-origin` means ALLOWED_ORIGINS is still unset/"*".
const PROBE_ORIGIN = 'https://smoke-probe.invalid'
try {
  const { res } = await request('/health', { headers: { origin: PROBE_ORIGIN } })
  const acao = res.headers.get('access-control-allow-origin')
  if (!acao) {
    record('PASS', 'CORS does not reflect arbitrary origins', 'no access-control-allow-origin returned')
  } else if (acao === PROBE_ORIGIN || acao === '*') {
    record('WARN', 'CORS reflects arbitrary origins', `ALLOWED_ORIGINS is unset or "*" (got "${acao}")`)
  } else {
    record('PASS', 'CORS does not reflect arbitrary origins', `answered with "${acao}"`)
  }
} catch (error) {
  record('FAIL', 'CORS probe', error.message)
}

// 5. The critical regression check: a sign-in request must never return the live
//    code or magic-link token. Opt in, because it also sends mail / writes a row.
if (probeEmail) {
  try {
    const { res, json, text } = await request('/auth/request', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: probeEmail })
    })
    const leaked = ['devCode', 'devMagicToken'].filter((key) => text.includes(key))
    if (leaked.length) {
      record('FAIL', 'POST /auth/request does not leak sign-in secrets', `response contains ${leaked.join(', ')}`)
    } else if (res.status === 200 && json?.ok === true) {
      record('PASS', 'POST /auth/request does not leak sign-in secrets', `200 for ${probeEmail}, no dev fields`)
    } else {
      record('FAIL', 'POST /auth/request does not leak sign-in secrets', `status=${res.status} body=${text.slice(0, 120)}`)
    }
  } catch (error) {
    record('FAIL', 'POST /auth/request does not leak sign-in secrets', error.message)
  }
} else {
  console.log('SKIP  sign-in secret-leak check — pass --email <you@example.com> to include it')
}

// 6. Optional: the website must have generated a configured config.js.
if (website) {
  const base = website.replace(/\/+$/, '')
  try {
    const { res, text } = await rawFetch(`${base}/config.js`)
    const match = text.match(/apiBaseUrl"\s*:\s*"([^"]*)"/)
    if (res.status !== 200) {
      record('FAIL', 'website config.js reachable', `status=${res.status}`)
    } else if (!match || !match[1]) {
      record('FAIL', 'website config.js is configured', 'apiBaseUrl is empty — set API_BASE_URL on the host')
    } else {
      record('PASS', 'website config.js is configured', match[1])
    }
  } catch (error) {
    record('FAIL', 'website config.js is configured', error.message)
  }
}

const failed = results.filter((entry) => entry.status === 'FAIL').length
const warned = results.filter((entry) => entry.status === 'WARN').length
console.log(`\n${results.length - failed} passed, ${warned} warning(s), ${failed} failed`)

// Set the code instead of calling process.exit(): fetch keeps sockets alive, and
// exiting underneath them trips a libuv assertion on Windows that reports a bogus
// status (127) instead of 1. Letting the loop drain exits with the right code.
process.exitCode = failed ? 1 : 0
