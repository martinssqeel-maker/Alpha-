#!/usr/bin/env node
// Applies database/migrations/*.sql to the Neon database in DATABASE_URL.
// Usage: node scripts/db-migrate.mjs  [--check]
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

const __dirname = dirname(fileURLToPath(import.meta.url))
const migrationsDir = join(__dirname, '..', 'database', 'migrations')

const url = process.env.DATABASE_URL
if (!url) {
  console.error('DATABASE_URL is not set. Set it as an environment variable first.')
  process.exit(1)
}

const local = /localhost|127\.0\.0\.1/.test(url)
const client = new pg.Client({ connectionString: url, ssl: local ? undefined : { rejectUnauthorized: false } })
const check = process.argv.includes('--check')

async function main() {
  await client.connect()

  await client.query(`create table if not exists public.schema_migrations (
    name text primary key,
    applied_at timestamptz not null default now())`)

  const applied = new Set(
    (await client.query('select name from public.schema_migrations')).rows.map((r) => r.name)
  )
  const files = readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort()

  let ran = 0
  for (const file of files) {
    if (applied.has(file)) {
      console.log(`skip    ${file}`)
      continue
    }
    if (check) {
      console.log(`pending ${file}`)
      continue
    }
    const sql = readFileSync(join(migrationsDir, file), 'utf8')
    process.stdout.write(`apply   ${file} ... `)
    try {
      await client.query('begin')
      await client.query(sql)
      await client.query('insert into public.schema_migrations (name) values ($1)', [file])
      await client.query('commit')
      console.log('ok')
      ran++
    } catch (err) {
      await client.query('rollback').catch(() => {})
      console.log('FAILED')
      throw err
    }
  }

  const tables = await client.query(
    `select tablename from pg_tables where schemaname = 'public' order by tablename`
  )
  console.log('\ntables:', tables.rows.map((r) => r.tablename).join(', '))
  console.log(check ? 'check complete' : ran ? `applied ${ran} migration(s)` : 'nothing to apply')

  await client.end()
}

main().catch((err) => {
  console.error('\nMigration failed:')
  console.error(err.message || err)
  process.exit(1)
})
