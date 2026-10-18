import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { PGlite } from '@electric-sql/pglite'

// The name and number the sign-up form collects, driven through the real Hono
// app against real PostgreSQL.
//
// `tests/profile.test.ts` proves the rules. This proves the wiring, which is the
// part a rule cannot: that `POST /auth/register` actually writes `full_name` and
// `phone`, that `PATCH /auth/me` writes only the fields it was sent, and that a
// refusal leaves the stored row exactly as it was.
//
// The database is PostgreSQL compiled to WASM with every migration applied, so
// nothing here touches a deployment — the same approach `tests/migrations.test.ts`
// takes for the SQL that enforces sharing and quotas.

const PEPPER = 'profile-route-test-pepper'
const JWT_SECRET = 'profile-route-test-secret-long-enough'
const PASSWORD = 'Basalt-Harbour-314-Lantern'
const MEMBER = 'profile-route@example.invalid'

const holder = vi.hoisted(() => ({
  db: null as null | { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> }
}))

// `withContext` is the app's only door to the database. Standing it up on PGlite
// keeps the SQL the routes actually send under test instead of stubbed away.
vi.mock('../platform/api/db', () => ({
  withContext: async (
    userId: string | null,
    role: string,
    fn: (q: { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> }) => Promise<unknown>
  ) => {
    const db = holder.db
    if (!db) throw new Error('the test database is not ready')
    await db.query("select set_config('app.user_id', $1, false)", [userId ?? ''])
    await db.query("select set_config('app.role', $1, false)", [role])
    return fn(db)
  }
}))

import app from '../platform/api/index'

const migrationsDir = join(__dirname, '..', 'database', 'migrations')

async function one<T>(sql: string, params: unknown[] = []): Promise<T> {
  const db = holder.db
  if (!db) throw new Error('the test database is not ready')
  const res = await db.query(sql, params)
  return res.rows[0] as T
}

interface Answer {
  status: number
  body: Record<string, unknown> & { ok?: boolean; error?: { code: string; message: string }; account?: never }
}

async function call(path: string, init: { method?: string; body?: unknown; token?: string } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (init.token) headers.authorization = `Bearer ${init.token}`
  const res = await app.request(path, {
    method: init.method ?? 'GET',
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body)
  })
  return { status: res.status, body: (await res.json()) as Answer['body'] }
}

/** The code row a mailbox would have produced, hashed exactly as the API hashes it. */
async function mintCode(email: string): Promise<string> {
  const code = '424242'
  const digest = createHash('sha256').update(`${PEPPER}:${code}`).digest('hex')
  await one(
    `insert into public.auth_otps (email, code_hash, magic_hash, expires_at)
     values ($1, $2, $3, now() + interval '10 minutes') returning id`,
    [email, digest, `${digest}-magic`]
  )
  return code
}

let token = ''

beforeAll(async () => {
  process.env.AUTH_JWT_SECRET = JWT_SECRET
  process.env.AUTH_PEPPER = PEPPER
  process.env.WEB_ACCOUNT_URL = 'https://alpha-website-lime.vercel.app'
  process.env.ALLOWED_ORIGINS = 'https://alpha-website-lime.vercel.app'
  // Every migration, in order, against the in-process database.
  const db = new PGlite()
  for (const file of readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort()) {
    try {
      await db.exec(readFileSync(join(migrationsDir, file), 'utf8'))
    } catch (error) {
      throw new Error(`migration ${file} failed: ${(error as Error).message}`)
    }
  }
  holder.db = db as unknown as typeof holder.db

  // A member signs up the way the card does, then redeems the code so the
  // session the update route needs exists.
  const registered = await call('/auth/register', {
    method: 'POST',
    body: { email: MEMBER, password: PASSWORD, fullName: 'Ada Lovelace', phone: '+1 (555) 010-2030' }
  })
  if (registered.status !== 202) {
    throw new Error(`sign-up failed in setup: ${registered.status} ${JSON.stringify(registered.body)}`)
  }
  const verified = await call('/auth/verify', { method: 'POST', body: { email: MEMBER, code: await mintCode(MEMBER) } })
  token = String(verified.body.accessToken ?? '')
  if (!token) throw new Error(`verify failed in setup: ${verified.status} ${JSON.stringify(verified.body)}`)
}, 180_000)

afterAll(() => {
  delete process.env.AUTH_JWT_SECRET
  delete process.env.AUTH_PEPPER
  delete process.env.WEB_ACCOUNT_URL
  delete process.env.ALLOWED_ORIGINS
})

describe('POST /auth/register stores the profile it asks for', () => {
  it('writes the name and the number, normalized, onto the account row', async () => {
    const row = await one<{ full_name: string; phone: string }>(
      'select full_name, phone from public.users where lower(email) = $1',
      [MEMBER]
    )
    expect(row.full_name).toBe('Ada Lovelace')
    // As typed: `+1 (555) 010-2030` must land as what the card promises to save.
    expect(row.phone).toBe('+15550102030')
  })

  it('does not rewrite a name or number an account already has', async () => {
    // Signing up again from the form is how someone re-enters a flow they left;
    // it must not let whoever holds the address replace what is on the row.
    const again = await call('/auth/register', {
      method: 'POST',
      body: {
        email: MEMBER,
        password: PASSWORD,
        fullName: 'Someone Else',
        phone: '+44 20 7946 0958'
      }
    })
    expect(again.status).toBe(202)
    const row = await one<{ full_name: string; phone: string }>(
      'select full_name, phone from public.users where lower(email) = $1',
      [MEMBER]
    )
    expect(row.full_name).toBe('Ada Lovelace')
    expect(row.phone).toBe('+15550102030')
  })
})

describe('PATCH /auth/me saves what the profile card sends', () => {
  it('refuses a caller with no session', async () => {
    const res = await call('/auth/me', { method: 'PATCH', body: { fullName: 'Nobody' } })
    expect(res.status).toBe(401)
  })

  it('refuses a body that changes nothing', async () => {
    const res = await call('/auth/me', { method: 'PATCH', body: {}, token })
    expect(res.status).toBe(400)
    expect(res.body.error?.code).toBe('invalid_request')
  })

  it('saves a name and a number and answers with the account', async () => {
    const res = await call('/auth/me', {
      method: 'PATCH',
      body: { fullName: 'Grace Hopper', phone: '+44 20 7946 0958' },
      token
    })
    expect(res.status).toBe(200)
    expect(res.body.account).toMatchObject({ fullName: 'Grace Hopper', phone: '+442079460958' })
    const row = await one<{ full_name: string; phone: string }>(
      'select full_name, phone from public.users where lower(email) = $1',
      [MEMBER]
    )
    expect(row).toMatchObject({ full_name: 'Grace Hopper', phone: '+442079460958' })
  })

  it('writes only the field that was sent, so saving a name cannot blank a number', async () => {
    const res = await call('/auth/me', { method: 'PATCH', body: { fullName: 'Ada Lovelace' }, token })
    expect(res.status).toBe(200)
    expect(res.body.account).toMatchObject({ fullName: 'Ada Lovelace', phone: '+442079460958' })
  })

  it('refuses a number that cannot be dialled and leaves the stored one alone', async () => {
    const res = await call('/auth/me', { method: 'PATCH', body: { phone: 'nope' }, token })
    expect(res.status).toBe(400)
    expect(res.body.error?.code).toBe('invalid_phone')
    const row = await one<{ phone: string }>('select phone from public.users where lower(email) = $1', [MEMBER])
    expect(row.phone).toBe('+442079460958')
  })

  it('refuses a name sign-up would not have accepted', async () => {
    const res = await call('/auth/me', { method: 'PATCH', body: { fullName: 'A' }, token })
    expect(res.status).toBe(400)
    expect(res.body.error?.code).toBe('invalid_name')
  })

  it('removes the number when the field is cleared', async () => {
    const res = await call('/auth/me', { method: 'PATCH', body: { phone: '' }, token })
    expect(res.status).toBe(200)
    expect(res.body.account).toMatchObject({ fullName: 'Ada Lovelace', phone: null })
    const row = await one<{ phone: string | null }>(
      'select phone from public.users where lower(email) = $1',
      [MEMBER]
    )
    expect(row.phone).toBeNull()
  })

  it('reads the saved record back through GET /auth/me', async () => {
    const res = await call('/auth/me', { token })
    expect(res.status).toBe(200)
    expect(res.body.account).toMatchObject({ email: MEMBER, fullName: 'Ada Lovelace', phone: null })
  })
})
