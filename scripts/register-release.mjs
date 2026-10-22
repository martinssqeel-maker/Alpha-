#!/usr/bin/env node
/**
 * Register the installer built in ./release as the version the product hands out.
 *
 * Why this exists: publishing to GitHub Releases updates *auto-update*, but the
 * gated surface — `GET /downloads/latest`, and the download panel on the signed-in
 * dashboard — reads `public.releases`, which the migration seeded once with 1.0.4
 * and nothing since. Measured 2026-10-17: the table still held a single 1.0.4 row
 * while 1.0.5 and 1.0.6 were public on GitHub, so every signed-in account was
 * handed an installer three versions old. The admin portal only *lists* releases,
 * so there was no in-product way to close that gap.
 *
 * Deliberate properties, mirroring scripts/admin-grant.mjs:
 *
 *   * The row must describe bytes that are really downloadable: the version is
 *     refused unless the GitHub asset exists and its advertised length equals the
 *     local installer's, and the advertised sha512 is computed from that local file.
 *   * It never invents a version — the artifact for the current package version has
 *     to be built first.
 *   * It is idempotent (`on conflict (version, channel, platform) do update`) and
 *     writes the same `release.upsert` audit row the admin route writes.
 *   * It never fabricates an actor: the audit row records `actor_id = null` and
 *     says which script did it, exactly like the role grant.
 *   * `--check` reports what it would do and changes nothing.
 *
 * Usage:
 *   npm run release:register                       # register the built version
 *   npm run release:register -- --check
 *   npm run release:register -- --notes "What changed"
 *   npm run release:register -- --minimum 1.0.4    # minimum supported client
 *   npm run release:register -- --no-verify        # offline: skip the asset probe
 *
 * Requires: the built installer in ./release and DATABASE_URL (env or .env.local).
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const flagValue = (name) => {
  const i = argv.indexOf(name)
  return i === -1 ? undefined : argv[i + 1]
}
const checkOnly = argv.includes('--check')
const verifyAsset = !argv.includes('--no-verify')

/** Same coordinates electron-builder.yml and scripts/ensure-release.mjs use. */
const GITHUB_REPO = 'martinssqeel-maker/Alpha-'
const PRODUCT_NAME = 'Alpha AI Workspace'

const pkg = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'))
const version = (flagValue('--version') ?? pkg.version).trim()

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

/** Build from URL parts: a password containing `@` or `/` must not re-parse as host. */
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
  if (!existsSync(file)) {
    console.error('DATABASE_URL is not set and .env.local does not exist.')
    process.exit(1)
  }
  const env = parseEnvFile(readFileSync(file, 'utf8'))
  const url = env.DATABASE_URL_UNPOOLED || env.DATABASE_URL
  if (!url) {
    console.error('DATABASE_URL is missing from .env.local.')
    process.exit(1)
  }
  return url
}

function artifactName(v) {
  return `${PRODUCT_NAME}-Setup-${v}.exe`
}

/**
 * The asset name as published, for the two ways this repository has produced it.
 *
 * `ensure-release.mjs` uploads `${productName}` with spaces replaced by dashes,
 * while electron-builder's own upload collapses them to dots — v1.0.7 landed as
 * `Alpha.AI.Workspace-Setup-1.0.7.exe` even though this script assumed dashes,
 * so the URL it built answered 404 and registration could only have succeeded
 * with `--no-verify`, storing a dead link. Both spellings are tried, and the
 * GitHub API is asked first so the real name always wins.
 */
function assetNameCandidates(v) {
  const base = artifactName(v)
  return [...new Set([base.replace(/ /g, '.'), base.replace(/ /g, '-'), base])]
}

async function installerUrl(v) {
  const explicit = flagValue('--url')
  if (explicit) return explicit
  try {
    const response = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/tags/v${v}`, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'alpha-release-register' }
    })
    if (response.ok) {
      const release = await response.json()
      const asset = (release.assets ?? []).find(
        (candidate) => /\.exe$/i.test(candidate.name) && !/blockmap/i.test(candidate.name)
      )
      if (asset?.browser_download_url) return asset.browser_download_url
    }
  } catch {
    /* offline or rate-limited: fall back to the known spellings below */
  }
  return `https://github.com/${GITHUB_REPO}/releases/download/v${v}/${assetNameCandidates(v)[0]}`
}

/**
 * The length of the published asset, or null when it cannot be established.
 * GitHub answers the download URL with a redirect to a signed blob URL, which
 * supports HEAD; when a proxy strips it, a one-byte ranged GET still reports the
 * total in `content-range`.
 */
async function publishedAssetSize(url) {
  const attempt = async (init) => {
    const response = await fetch(url, { redirect: 'follow', ...init })
    if (!response.ok) return { status: response.status, size: null }
    const length = Number(response.headers.get('content-length'))
    const range = response.headers.get('content-range')
    const total = range ? Number(range.split('/')[1]) : length
    return { status: response.status, size: Number.isFinite(total) && total > 0 ? total : null }
  }
  try {
    const head = await attempt({ method: 'HEAD' })
    if (head.size !== null) return head
    if (head.status === 405 || head.status === 403 || head.status === 404) {
      return attempt({ method: 'GET', headers: { range: 'bytes=0-0' } })
    }
    return head
  } catch {
    return { status: 0, size: null }
  }
}

function localArtifact() {
  const file = path.join(repoRoot, 'release', artifactName(version))
  if (!existsSync(file)) {
    console.error(
      `No installer at release/${artifactName(version)}.\n` +
        'Build it first (npm run dist), then publish it (node scripts/ensure-release.mjs).'
    )
    process.exit(1)
  }
  const { size } = statSync(file)
  const sha512 = createHash('sha512').update(readFileSync(file)).digest('base64')
  return { file, size, sha512 }
}

async function main() {
  const minimum = (flagValue('--minimum') ?? version).trim()
  const notes = flagValue('--notes') ?? null
  const url = await installerUrl(version)
  const local = localArtifact()

  console.log(`version ${version} — release/${artifactName(version)} (${local.size} bytes)`)
  console.log(`installer ${url}`)
  console.log(`sha512    ${local.sha512.slice(0, 24)}…`)

  if (verifyAsset) {
    const published = await publishedAssetSize(url)
    if (published.size === null) {
      console.error(
        `\nRefusing to register: ${url} did not report a length (HTTP ${published.status}).\n` +
          'Publish the release first (node scripts/ensure-release.mjs), or pass --no-verify\n' +
          'if you know the asset is there and the network cannot be reached.'
      )
      process.exit(1)
    }
    if (published.size !== local.size) {
      console.error(
        `\nRefusing to register: the published asset is ${published.size} bytes but the local\n` +
          `installer is ${local.size}. Rebuild (npm run dist) and re-publish, or the hash this\n` +
          'row advertises would not describe the file users download.'
      )
      process.exit(1)
    }
    console.log(`verified  the published asset is ${published.size} bytes`)
  } else {
    console.log('skipped   asset verification (--no-verify)')
  }

  const payload = {
    version,
    channel: 'stable',
    platform: 'win',
    notes,
    installerUrl: url,
    installerSize: local.size,
    sha512: local.sha512,
    minimumSupportedVersion: minimum,
    published: true
  }

  const client = new pg.Client(connectionConfig(databaseUrl()))
  await client.connect()

  try {
    const previous = (
      await client.query(
        "select version from public.releases where channel = 'stable' and platform = 'win' and published order by released_at desc limit 1"
      )
    ).rows[0]

    if (checkOnly) {
      console.log(
        `\n--check: would register ${version} (currently serving ${previous?.version ?? 'nothing'}), ` +
          'and write a release.upsert audit row. Nothing was changed.'
      )
      return
    }

    await client.query('begin')
    try {
      const row = (
        await client.query(
          `insert into public.releases (
             version, channel, platform, notes, installer_url, installer_size, sha512,
             minimum_supported_version, published, released_at
           ) values ($1, $2, $3, $4, $5, $6::bigint, $7, $8, $9, now())
           on conflict (version, channel, platform) do update set
             notes = excluded.notes,
             installer_url = excluded.installer_url,
             installer_size = excluded.installer_size,
             sha512 = excluded.sha512,
             minimum_supported_version = excluded.minimum_supported_version,
             published = excluded.published,
             released_at = excluded.released_at,
             updated_at = now()
           returning version, installer_size, sha512, released_at, installer_url`,
          [
            payload.version,
            payload.channel,
            payload.platform,
            payload.notes,
            payload.installerUrl,
            payload.installerSize,
            payload.sha512,
            payload.minimumSupportedVersion,
            payload.published
          ]
        )
      ).rows[0]

      await client.query(
        `insert into public.audit_logs (actor_id, action, target, detail)
         values (null, 'release.upsert', $1, $2::jsonb)`,
        [
          payload.version,
          JSON.stringify({ ...payload, via: 'scripts/register-release.mjs', replaced: previous?.version ?? null })
        ]
      )
      await client.query('commit')

      const serving = (
        await client.query("select public.latest_release('stable', 'win') as release")
      ).rows[0].release

      console.log(`\nregistered ${row.version} (${row.installer_size} bytes, released ${row.released_at.toISOString()})`)
      if (previous?.version && previous.version !== version) {
        console.log(`replaced   ${previous.version} as the version handed to signed-in accounts`)
      }
      console.log(`serving    /downloads/latest now answers version ${serving?.version ?? '(none)'}`)
      if (serving?.version !== version) {
        console.error('The API would not serve this version — check published/released_at ordering.')
        process.exit(1)
      }
    } catch (error) {
      await client.query('rollback').catch(() => {})
      throw error
    }
  } finally {
    await client.end()
  }
}

main().catch((error) => {
  console.error('\nFailed:', error.message || error)
  process.exit(1)
})
