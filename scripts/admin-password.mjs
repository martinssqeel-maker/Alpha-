#!/usr/bin/env node
/**
 * Set an administrator's password.
 *
 * Runs on the operator's machine against DATABASE_URL (from .env.local), so the
 * password itself never leaves the computer, is never sent to the API, is never
 * printed, and never lands in shell history or a chat window. Only a scrypt
 * digest reaches the database — the same format the API verifies against.
 *
 * Usage:
 *   npm run admin:password                  # prompts for email + password
 *   npm run admin:password -- --email you@example.com
 *   npm run admin:password -- --revoke      # remove the credential entirely
 *
 * Requirements: the account must already exist (sign in once with a one-time
 * link) and must hold an admin role. This script refuses otherwise, so it cannot
 * be used to promote an ordinary account.
 */
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'
import { randomBytes, scryptSync } from 'node:crypto'
import pg from 'pg'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const flagValue = (name) => {
  const i = argv.indexOf(name)
  return i === -1 ? undefined : argv[i + 1]
}
const revoke = argv.includes('--revoke')

// ── scrypt digest, byte-compatible with platform/api/password.ts ─────────────
const N = 16_384
const R = 8
const P = 1
const KEY_LEN = 64
const MIN_LENGTH = 12

function hashPassword(password) {
  const salt = randomBytes(16)
  const digest = scryptSync(password, salt, KEY_LEN, { N, r: R, p: P, maxmem: 64 * 1024 * 1024 })
  return ['scrypt', N, R, P, salt.toString('base64url'), digest.toString('base64url')].join('$')
}

function passwordProblem(password) {
  if (password.length < MIN_LENGTH) return `Use at least ${MIN_LENGTH} characters.`
  if (password.trim() !== password) return 'Remove leading or trailing spaces.'
  const lower = password.toLowerCase()
  const weak = ['password', 'letmein', 'changeme', 'qwerty', '123456', 'alpha123']
  if (weak.some((entry) => lower.includes(entry))) return 'That password contains a well-known weak phrase.'
  return null
}

/** Read a line without echoing it to the terminal. */
function askHidden(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true })
    const stdoutWrite = process.stdout.write.bind(process.stdout)
    process.stdout.write(question)
    process.stdout.write = (chunk, ...rest) => {
      if (String(chunk).includes('\n')) return stdoutWrite('\n', ...rest)
      return true
    }
    rl.question('', (answer) => {
      process.stdout.write = stdoutWrite
      rl.close()
      resolve(answer)
    })
  })
}

function askVisible(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    rl.question(question, (answer) => {
      rl.close()
      resolve(answer)
    })
  })
}

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

function databaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL
  const file = path.join(repoRoot, '.env.local')
  if (!fs.existsSync(file)) {
    console.error('DATABASE_URL is not set and .env.local does not exist.')
    process.exit(1)
  }
  const env = parseEnvFile(fs.readFileSync(file, 'utf8'))
  if (!env.DATABASE_URL) {
    console.error('DATABASE_URL is missing from .env.local.')
    process.exit(1)
  }
  return env.DATABASE_URL
}

async function main() {
  const url = databaseUrl()
  const local = /localhost|127\.0\.0\.1/.test(url)
  const client = new pg.Client({ connectionString: url, ssl: local ? undefined : { rejectUnauthorized: false } })
  await client.connect()

  const email = (flagValue('--email') ?? (await askVisible('Administrator email: '))).trim().toLowerCase()
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    console.error('That is not a valid email address.')
    process.exit(1)
  }

  const found = await client.query(
    `select u.id, u.email, u.status, public.is_admin(u.id) as is_admin
       from public.users u where lower(u.email) = $1 limit 1`,
    [email]
  )
  const user = found.rows[0]
  if (!user) {
    console.error(`No account exists for ${email}. Sign in once on the website, then run this again.`)
    await client.end()
    process.exit(1)
  }
  if (!user.is_admin) {
    console.error(`${email} is not an administrator. Grant the role first; this script will not promote accounts.`)
    await client.end()
    process.exit(1)
  }

  if (revoke) {
    await client.query('delete from public.password_credentials where user_id = $1', [user.id])
    console.log(`Removed the password credential for ${user.email}.`)
    await client.end()
    return
  }

  const first = await askHidden('New password: ')
  const problem = passwordProblem(first)
  if (problem) {
    console.error(problem)
    await client.end()
    process.exit(1)
  }
  const second = await askHidden('Repeat password: ')
  if (first !== second) {
    console.error('The passwords did not match.')
    await client.end()
    process.exit(1)
  }

  await client.query(
    `insert into public.password_credentials (user_id, password_hash, algo)
     values ($1, $2, 'scrypt')
     on conflict (user_id) do update set password_hash = excluded.password_hash, updated_at = now()`,
    [user.id, hashPassword(first)]
  )
  await client.query(
    `insert into public.audit_logs (actor_id, action, target, detail)
     values ($1, 'auth.password_set', $2, jsonb_build_object('via', 'scripts/admin-password.mjs'))`,
    [user.id, user.id]
  )
  console.log(`Password set for ${user.email}. Sign in at the admin portal with it now.`)
  await client.end()
}

main().catch((error) => {
  console.error('\nFailed:', error.message || error)
  process.exit(1)
})
