#!/usr/bin/env node
/**
 * Grant an administrator role to an account that already exists.
 *
 * Why this exists: the control centre decides every permission from
 * `public.admin_users`, so a fresh deployment has an administrator dashboard
 * nobody can open. The only supported ways in are an existing administrator —
 * of which there are none yet — or this script, run by the operator on their own
 * machine with database credentials.
 *
 * Deliberate properties, because this is the one script that can hand out
 * privileged access:
 *
 *   * It cannot create an account. The address must already be registered, so a
 *     typo grants nothing instead of minting an empty administrator.
 *   * It refuses a suspended or disabled account: an administrator who cannot
 *     sign in is not an administrator, and granting one would leave a role that
 *     can never be revoked through the dashboard.
 *   * It is idempotent and refuses to *silently* change an existing role, so
 *     re-running it cannot quietly demote or promote anybody.
 *   * It writes an append-only `audit_logs` row recording who was granted what
 *     and how, using the same table the dashboard reads for its audit view.
 *   * `--check` reports exactly what it would do and changes nothing.
 *
 * Usage:
 *   npm run admin:grant                          # prompts for the address
 *   npm run admin:grant -- --email you@example.com
 *   npm run admin:grant -- --email you@example.com --role admin
 *   npm run admin:grant -- --email you@example.com --check
 */
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const flagValue = (name) => {
  const i = argv.indexOf(name)
  return i === -1 ? undefined : argv[i + 1]
}
const check = argv.includes('--check')
const force = argv.includes('--force')

/** Roles the database seeds; anything else is refused rather than invented. */
const KNOWN_ROLES = ['owner', 'admin', 'support']

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

/**
 * Build the connection from URL parts rather than handing the string to `pg`.
 * A password containing an `@`, `#` or `/` is otherwise re-parsed as host or
 * fragment, which fails with a confusing DNS error instead of an auth error.
 */
function connectionConfig(url) {
  const parsed = new URL(url)
  const local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(parsed.hostname)
  return {
    host: parsed.hostname,
    port: parsed.port ? Number(parsed.port) : 5432,
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    database: parsed.pathname.replace(/^\//, '') || 'postgres',
    ssl: local ? undefined : { rejectUnauthorized: false }
  }
}

function databaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL
  const file = path.join(repoRoot, '.env.local')
  if (!fs.existsSync(file)) {
    console.error('DATABASE_URL is not set and .env.local does not exist.')
    process.exit(1)
  }
  const env = parseEnvFile(fs.readFileSync(file, 'utf8'))
  const url = env.DATABASE_URL_UNPOOLED || env.DATABASE_URL
  if (!url) {
    console.error('DATABASE_URL is missing from .env.local.')
    process.exit(1)
  }
  return url
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

async function main() {
  const role = (flagValue('--role') ?? 'owner').trim().toLowerCase()
  if (!KNOWN_ROLES.includes(role)) {
    console.error(`Unknown role "${role}". Known roles: ${KNOWN_ROLES.join(', ')}.`)
    process.exit(1)
  }

  const email = (flagValue('--email') ?? (await askVisible('Administrator email: '))).trim().toLowerCase()
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    console.error('That is not a valid email address.')
    process.exit(1)
  }

  const client = new pg.Client(connectionConfig(databaseUrl()))
  await client.connect()

  try {
    const account = (
      await client.query(
        `select u.id, u.email, u.status, u.created_at
           from public.users u
          where lower(u.email) = $1
          limit 1`,
        [email]
      )
    ).rows[0]

    // A missing account is a refusal, not an invitation to create one.
    if (!account) {
      console.error(
        `No account exists for ${email}.\n` +
          'Sign in once at the website (https://alpha-website-lime.vercel.app/account) so the account\n' +
          'exists, then run this again. This script will never create an account for you.'
      )
      process.exit(1)
    }

    if (account.status !== 'active') {
      console.error(
        `${email} is "${account.status}". Restore the account first — an administrator who cannot sign\n` +
          'in cannot manage anything, and an inactive role would be unreachable from the dashboard.'
      )
      process.exit(1)
    }

    const roleRow = (await client.query('select id, code from public.admin_roles where code = $1', [role])).rows[0]
    if (!roleRow) {
      console.error(`The database has no "${role}" role. Apply the migrations (npm run db:migrate) first.`)
      process.exit(1)
    }

    const existing = (
      await client.query(
        `select r.code from public.admin_users au
           join public.admin_roles r on r.id = au.role_id
          where au.user_id = $1`,
        [account.id]
      )
    ).rows[0]

    if (existing && existing.code === role) {
      console.log(`${email} already holds the "${role}" role. Nothing to do.`)
      await printRoster(client)
      return
    }
    if (existing && !force) {
      console.error(
        `${email} already holds the "${existing.code}" role. Refusing to change it by accident.\n` +
          'Pass --force to replace it with "' + role + '".'
      )
      process.exit(1)
    }

    const action = existing ? 'change' : 'grant'
    if (check) {
      console.log(
        `--check: would ${action} the "${role}" role for ${email}` +
          (existing ? ` (currently "${existing.code}")` : '') +
          `, and write an audit_logs row. Nothing was changed.`
      )
      await printRoster(client)
      return
    }

    await client.query('begin')
    try {
      await client.query(
        `insert into public.admin_users (user_id, role_id)
         values ($1, $2)
         on conflict (user_id) do update set role_id = excluded.role_id`,
        [account.id, roleRow.id]
      )
      await client.query(
        `insert into public.audit_logs (actor_id, action, target, detail)
         values (null, $1, $2, jsonb_build_object('via', 'scripts/admin-grant.mjs', 'role', $3::text, 'email', $4::text))`,
        [existing ? 'admin.role_changed' : 'admin.role_granted', account.id, role, email]
      )
      await client.query('commit')
    } catch (error) {
      await client.query('rollback').catch(() => {})
      throw error
    }

    console.log(`${action === 'grant' ? 'Granted' : 'Changed'} the "${role}" role to ${email}.`)
    console.log('Open the dashboard at https://alpha-website-lime.vercel.app/admin and sign in with this account.')
    await printRoster(client)
  } finally {
    await client.end()
  }
}

/** The current administrators, so the operator can see the result immediately. */
async function printRoster(client) {
  const rows = (
    await client.query(
      `select u.email, r.code, u.status
         from public.admin_users au
         join public.users u on u.id = au.user_id
         join public.admin_roles r on r.id = au.role_id
        order by r.code, u.email`
    )
  ).rows
  if (rows.length === 0) {
    console.log('\nAdministrators: (none)')
    return
  }
  console.log(`\nAdministrators (${rows.length}):`)
  for (const row of rows) console.log(`  ${row.code.padEnd(8)} ${row.email}  [${row.status}]`)
}

main().catch((error) => {
  console.error('\nFailed:', error.message || error)
  process.exit(1)
})
