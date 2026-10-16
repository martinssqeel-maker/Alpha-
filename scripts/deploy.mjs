#!/usr/bin/env node
/**
 * Deploy the platform API to the Neon Function.
 *
 * Why this exists: `neon deploy --env .env.local` is documented, but CLI 8.3.5
 * fails to load the file (the Function bundler reports `AUTH_JWT_SECRET is
 * required` even when the key is present). So we read `.env.local` ourselves,
 * validate it, and hand the values to `neon deploy` through the child process
 * environment — the path that actually works.
 *
 * Safety rules baked in, because these are the exact mistakes that have bitten
 * this project before:
 *   * `AUTH_DEV_ECHO_OTP` truthy would make the deployed API return live
 *     sign-in codes/tokens to any caller. Deployment is refused unless
 *     `--allow-dev-echo` is passed (and even then it warns loudly).
 *   * Removing a key from `.env.local` does NOT clear it on the live Function
 *     (`neon.ts` only forwards keys that are present). Keys that must stay off
 *     are therefore set explicitly, never deleted.
 *   * Secret *values* are never printed, logged, or echoed — only key names.
 *
 * Usage:
 *   npm run deploy              # validate, then `neon deploy`
 *   npm run deploy -- --plan    # read-only diff: `neon config plan`
 *   npm run deploy -- --check   # validate the env file only, deploy nothing
 *   npm run deploy -- --env-file .env.staging
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { callbackUrlProblems } from './envRules.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const argv = process.argv.slice(2)
function flag(name) {
  const i = argv.indexOf(name)
  if (i === -1) return undefined
  const next = argv[i + 1]
  return next && !next.startsWith('--') ? next : true
}

const mode = flag('--plan') ? 'plan' : flag('--check') ? 'check' : 'deploy'
const allowDevEcho = Boolean(flag('--allow-dev-echo'))
const envFile = path.resolve(repoRoot, String(flag('--env-file') || '.env.local'))

/** Parse a dotenv file: comments, blank lines, `export`, quoted values, CRLF. */
export function parseEnvFile(contents) {
  const out = {}
  const crlfFree = contents.replace(/\r\n?/g, '\n')
  for (const rawLine of crlfFree.split('\n')) {
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
      if (quote === '"') value = value.replace(/\\n/g, '\n')
    } else {
      // Unquoted: strip a trailing inline comment, then trailing whitespace.
      const hash = value.indexOf(' #')
      if (hash >= 0) value = value.slice(0, hash)
      value = value.trim()
    }
    out[key] = value
  }
  return out
}

const problems = []
const warnings = []

let env = {}
let raw = ''
if (!fs.existsSync(envFile)) {
  problems.push(`${path.relative(repoRoot, envFile) || envFile} not found. Create it (see .env.example).`)
} else {
  raw = fs.readFileSync(envFile, 'utf8')
  env = parseEnvFile(raw)
}
const set = (key) => typeof env[key] === 'string' && env[key] !== ''
const truthy = (key) => ['1', 'true', 'yes', 'on'].includes((env[key] ?? '').toLowerCase())

// ── Required for the API to boot or to authenticate anybody ──────────────────
if (!set('AUTH_JWT_SECRET')) {
  problems.push('AUTH_JWT_SECRET is missing. The Function cannot sign session tokens.')
} else if (env.AUTH_JWT_SECRET.length < 32) {
  problems.push(`AUTH_JWT_SECRET is only ${env.AUTH_JWT_SECRET.length} chars; use 32+ random bytes.`)
}
if (!set('AUTH_PEPPER')) {
  problems.push('AUTH_PEPPER is missing. OTP codes and refresh tokens would be hashed without it.')
}
// An empty assignment (`AUTH_PEPPER=`) is uploaded as "", which deletes the live key.
if (/^\s*(export\s+)?AUTH_PEPPER\s*=\s*$/m.test(raw)) {
  problems.push('AUTH_PEPPER is present but empty (`AUTH_PEPPER=`). Set a real value; an empty one is sent as "".')
}


// ── Security guards ──────────────────────────────────────────────────────────
if (truthy('AUTH_DEV_ECHO_OTP')) {
  const message =
    'AUTH_DEV_ECHO_OTP is enabled: the deployed API would return live sign-in codes and ' +
    'magic-link tokens to ANY caller, allowing sign-in as any email address.'
  if (allowDevEcho) warnings.push(`${message} (deploying anyway: --allow-dev-echo)`)
  else problems.push(`${message} Set it to 0, or pass --allow-dev-echo if this is a throwaway branch.`)
}

const origins = (env.ALLOWED_ORIGINS ?? '').trim()
if (!origins || origins === '*') {
  warnings.push(
    'ALLOWED_ORIGINS is unset or "*", so CORS reflects any origin. Set the real website + admin ' +
      'origins (comma-separated). Bearer-only auth keeps this from being credential theft, but it ' +
      'is the last open item from the auth-leak finding.'
  )
} else if (origins.split(',').some((entry) => entry.trim() === '*')) {
  warnings.push('ALLOWED_ORIGINS contains a "*" entry alongside real origins; remove it.')
}

const emailProvider = (env.EMAIL_PROVIDER ?? 'log').toLowerCase()
if (emailProvider === 'resend' && !set('RESEND_API_KEY')) {
  problems.push('EMAIL_PROVIDER=resend but RESEND_API_KEY is empty, so every sign-in email would fail.')
}
if (emailProvider === 'log') {
  warnings.push(
    'EMAIL_PROVIDER=log sends NO mail — the API still replies "we sent a code". Fine for testing, ' +
      'wrong for real users.'
  )
}
if (set('WEB_ACCOUNT_URL') && !/^https:\/\//.test(env.WEB_ACCOUNT_URL)) {
  warnings.push('WEB_ACCOUNT_URL should be an https URL; magic links are built from it.')
}

// A callback URL that is not the callback route breaks Google and GitHub sign-in
// in a way that looks like a provider outage. Refuse the deploy instead.
problems.push(...callbackUrlProblems(env))

if (set('NEON_AI_GATEWAY_BASE_URL') && set('NEON_AI_GATEWAY_TOKEN')) {
  warnings.push('Neon AI Gateway env is set; it takes precedence over per-provider keys.')
} else if (!set('PROVIDER_API_KEY_OPENAI') && !set('PROVIDER_API_KEY_ANTHROPIC') && !set('PROVIDER_API_KEY_GROQ')) {
  warnings.push(
    'Neither the Neon AI Gateway nor any provider key is set, so /gateway/chat/completions will ' +
      'return 502 provider_unavailable. Fine until cloud chat is needed.'
  )
}

/** Print the validation outcome and exit. Never prints secret values. */
function report() {
  const rel = path.relative(repoRoot, envFile) || envFile
  const names = Object.keys(env).sort()
  console.log(`env file: ${rel} (${names.length} keys)`)
  if (names.length) console.log(`  ${names.join(', ')}`)
  for (const warning of warnings) console.log(`  ! ${warning}`)
  if (problems.length) {
    console.error(`\nRefusing to deploy — ${problems.length} problem(s):`)
    for (const problem of problems) console.error(`  x ${problem}`)
    process.exit(1)
  }
  console.log('\nEnvironment looks deployable.')
  return true
}

if (mode === 'check') {
  report()
  console.log('(--check: nothing deployed)')
  process.exit(0)
}

console.log('Pre-flight checks:')
report()

const neonArgs = mode === 'plan' ? ['config', 'plan'] : ['deploy']
console.log(`\n> neon ${neonArgs.join(' ')}`)

// `neon` is a global .cmd shim on Windows, which Node refuses to spawn without a
// shell. All arguments here are fixed literals, so shell expansion is not a risk.
const child = spawnSync('neon', neonArgs, {
  stdio: 'inherit',
  env: { ...process.env, ...env },
  shell: process.platform === 'win32'
})

if (child.error) {
  console.error(`\nFailed to run the neon CLI: ${child.error.message}`)
  console.error('Install it with `npm i -g @neon/cli`, then re-run.')
  process.exit(1)
}
process.exit(child.status ?? 1)
