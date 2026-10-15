#!/usr/bin/env node
/**
 * Are the configured OAuth credentials actually accepted by the providers?
 *
 * Why this exists: a Google client secret that does not belong to the configured
 * client id is accepted at the consent screen and then rejected by the token
 * endpoint with `401 invalid_client`. That failure only shows up *after* a
 * deploy, in the Function logs, after a user has already tried to sign in. This
 * asks the providers directly, before deploying anything.
 *
 * How it decides, without ever needing a real user:
 *   Google  -> a deliberately invalid code is sent to the token endpoint. If the
 *              client credentials are good, Google answers `invalid_grant`
 *              ("the code is bad"), which is the *pass* signal. `invalid_client`
 *              means the id/secret pair is wrong.
 *   GitHub  -> the same trick: good credentials give `bad_verification_code`,
 *              while a wrong pair gives `incorrect_client_credentials`.
 *
 * Safety: secret *values* are never printed, logged or echoed — only the verdict
 * and the provider's own machine-readable error code. Nothing is written.
 *
 * Usage:
 *   npm run check:oauth                 # reads .env.local
 *   npm run check:oauth -- --env-file .env.staging
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const flagIndex = argv.indexOf('--env-file')
const envFile = path.resolve(repoRoot, flagIndex >= 0 && argv[flagIndex + 1] ? argv[flagIndex + 1] : '.env.local')

/** Parse a dotenv file: comments, blank lines, `export`, quoted values, CRLF. */
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

if (!fs.existsSync(envFile)) {
  console.error(`${path.relative(repoRoot, envFile) || envFile} not found. Create it (see .env.example).`)
  process.exit(1)
}
const env = parseEnvFile(fs.readFileSync(envFile, 'utf8'))
const rel = path.relative(repoRoot, envFile) || envFile

const results = []

/** Ask Google whether it accepts this client id + secret. */
async function checkGoogle() {
  const clientId = env.GOOGLE_CLIENT_ID
  const clientSecret = env.GOOGLE_CLIENT_SECRET
  if (!clientId || !clientSecret) {
    results.push({ provider: 'google', status: 'NOT CONFIGURED', detail: 'both values must be set to turn Google on' })
    return
  }
  const redirectUri =
    env.GOOGLE_REDIRECT_URI ||
    `${(env.NEON_FUNCTION_API_BASE_URL || '').replace(/\/+$/, '')}/auth/google/callback`
  if (!/^https?:\/\//.test(redirectUri)) {
    results.push({
      provider: 'google',
      status: 'CANNOT CHECK',
      detail: 'no GOOGLE_REDIRECT_URI and no NEON_FUNCTION_API_BASE_URL to derive one from'
    })
    return
  }
  try {
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code: 'not-a-real-code',
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code'
      })
    })
    const body = await res.json().catch(() => ({}))
    const code = typeof body.error === 'string' ? body.error : `http_${res.status}`
    if (code === 'invalid_grant') {
      results.push({ provider: 'google', status: 'ACCEPTED', detail: 'Google accepted the client id + secret' })
    } else if (code === 'invalid_client') {
      results.push({
        provider: 'google',
        status: 'REJECTED',
        detail:
          'Google says the client secret is invalid for this client id — re-copy the secret for that client (GOCSPX-…)'
      })
    } else if (code === 'redirect_uri_mismatch') {
      results.push({
        provider: 'google',
        status: 'REJECTED',
        detail: `Google does not recognise this callback: ${redirectUri}`
      })
    } else {
      results.push({ provider: 'google', status: 'UNEXPECTED', detail: `error=${code}` })
    }
  } catch (e) {
    results.push({ provider: 'google', status: 'CANNOT CHECK', detail: `network: ${e.message}` })
  }
}

/** Ask GitHub whether it accepts this client id + secret. */
async function checkGithub() {
  const clientId = env.GITHUB_CLIENT_ID
  const clientSecret = env.GITHUB_CLIENT_SECRET
  if (!clientId || !clientSecret) {
    results.push({ provider: 'github', status: 'NOT CONFIGURED', detail: 'both values must be set to turn GitHub on' })
    return
  }
  try {
    const res = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/x-www-form-urlencoded',
        'user-agent': 'alpha-platform-credential-check'
      },
      body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, code: 'not-a-real-code' })
    })
    const body = await res.json().catch(() => ({}))
    // GitHub answers 200 even for failures, so the body is what matters.
    const code = typeof body.error === 'string' ? body.error : null
    if (body.access_token) {
      results.push({ provider: 'github', status: 'UNEXPECTED', detail: 'GitHub returned a token for a fake code' })
    } else if (code === 'bad_verification_code' || code === 'unverified_user') {
      results.push({ provider: 'github', status: 'ACCEPTED', detail: 'GitHub accepted the client id + secret' })
    } else if (code === 'incorrect_client_credentials') {
      results.push({
        provider: 'github',
        status: 'REJECTED',
        detail: 'GitHub says the client id and secret do not match — re-copy them from the OAuth App'
      })
    } else {
      results.push({ provider: 'github', status: 'UNEXPECTED', detail: code ? `error=${code}` : `http_${res.status}` })
    }
  } catch (e) {
    results.push({ provider: 'github', status: 'CANNOT CHECK', detail: `network: ${e.message}` })
  }
}

console.log(`OAuth credential check\nenv file: ${rel}\n`)
await checkGoogle()
await checkGithub()

for (const r of results) console.log(`${r.provider.padEnd(7)} ${r.status.padEnd(15)} ${r.detail}`)

const configured = results.filter((r) => r.status !== 'NOT CONFIGURED')
const rejected = configured.filter((r) => r.status === 'REJECTED' || r.status === 'UNEXPECTED')
if (configured.length === 0) {
  console.log('\nNo provider credentials are set, so there is nothing to check.')
  process.exit(0)
}
if (rejected.length) {
  console.log(`\n${rejected.length} provider(s) would fail sign-in. Fix before deploying.`)
  process.exit(1)
}
const unchecked = configured.filter((r) => r.status === 'CANNOT CHECK')
if (unchecked.length) {
  console.log(`\n${unchecked.length} provider(s) could not be checked (see above).`)
  process.exit(2)
}
console.log('\nEvery configured provider accepted its credentials.')
