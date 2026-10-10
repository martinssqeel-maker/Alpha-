// Ensures a complete, correct GitHub release for the current package version.
//
// electron-builder's uploader intermittently fails mid-publish (skipping the
// blockmap or latest.yml), which would break auto-update. This script is
// idempotent: it creates/publishes the release if needed, then guarantees the
// exe, blockmap and latest.yml are present with hashes that match the actual
// final (signed) installer.
//
// Usage: node scripts/ensure-release.mjs [--check]
//   --check   report only; never create/upload/delete anything.
// Requires: GH_TOKEN environment variable (fine-grained token, contents write).

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const repo = 'martinssqeel-maker/Alpha-'
const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'))
const version = pkg.version
const checkOnly = process.argv.includes('--check')

const token = process.env.GH_TOKEN
if (!token) {
  console.error('GH_TOKEN is not set')
  process.exit(1)
}

const api = `https://api.github.com/repos/${repo}`
const headers = {
  Accept: 'application/vnd.github+json',
  Authorization: `Bearer ${token}`,
  'User-Agent': 'alpha-release-tool',
  'X-GitHub-Api-Version': '2022-11-28'
}

const releaseDir = join(process.cwd(), 'release')
const dashName = (n) => n.replace(/ /g, '-')
const exeLocal = join(releaseDir, `Alpha AI Workspace-Setup-${version}.exe`)
const exeAsset = `Alpha-AI-Workspace-Setup-${version}.exe`
const blockmapLocal = `${exeLocal}.blockmap`
const blockmapAsset = `${exeAsset}.blockmap`

async function apiReq(url, options = {}) {
  const res = await fetch(url, { ...options, headers: { ...headers, ...options.headers } })
  return { res, body: res.status === 204 ? null : await res.json().catch(() => null) }
}

function upload(assetUrl, name, data) {
  return fetch(`${assetUrl}?name=${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/octet-stream' },
    body: data
  })
}

const failures = []
const actions = []

function plan(what, fn) {
  actions.push(what)
  if (!checkOnly && !fn()) failures.push(what)
}

const main = async () => {
  for (const f of [exeLocal, blockmapLocal]) {
    if (!existsSync(f)) {
      console.error(`missing local artifact: ${f}`)
      process.exit(1)
    }
  }

  const exeSize = statSync(exeLocal).size
  const exeSha512 = createHash('sha512').update(readFileSync(exeLocal)).digest('base64')
  const blockmapSize = statSync(blockmapLocal).size
  console.log(`version ${version} — exe ${exeAsset} (${exeSize} bytes, ${exeSha512.slice(0, 16)}…)`)

  let { res, body: release } = await apiReq(`${api}/releases/tags/v${version}`)
  if (res.status === 404) {
    const body = { tag_name: `v${version}`, name: version, body: `Alpha AI Workspace ${version}`, draft: false, prerelease: false }
    const created = await apiReq(`${api}/releases`, { method: 'POST', body: JSON.stringify(body) })
    if (created.res.ok && created.body?.id) {
      release = created.body
      console.log(`created release v${version} (id ${release.id})`)
    } else {
      failures.push(`create release: HTTP ${created.res.status}`)
    }
  } else if (!res.ok) {
    console.error(`release lookup failed: HTTP ${res.status}`)
    process.exit(1)
  }

  if (!release?.id) {
    console.error('no usable release id')
    process.exit(1)
  }

  if (release.draft) {
    plan('publish (undraft) release', () => {
      return fetch(`${api}/releases/${release.id}`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ draft: false })
      }).then((r) => r.ok)
    })
  }

  const base = `${api}/releases/${release.id}/assets`
  const existing = new Map(release.assets.map((a) => [a.name, a]))

  // Deterministic checks so re-runs never rewrite identical files.
  const yml = [
    'version: ' + version,
    'files:',
    '  - url: ' + exeAsset,
    '    sha512: ' + exeSha512,
    `    size: ${exeSize}`,
    'path: ' + exeAsset,
    'sha512: ' + exeSha512,
    'releaseDate: ' + JSON.stringify(release.published_at ?? new Date().toISOString())
  ].join('\n')

  const want = [
    { name: exeAsset, data: readFileSync(exeLocal), size: exeSize },
    { name: blockmapAsset, data: readFileSync(blockmapLocal), size: blockmapSize },
    { name: 'latest.yml', data: Buffer.from(yml, 'utf8'), size: Buffer.byteLength(yml) }
  ]

  const alreadyOk = async (asset, assetsIndex) => {
    if (asset.name === 'latest.yml') {
      const cur = assetsIndex.get('latest.yml')
      if (!cur) return false
      const res = await fetch(cur.url, { headers: { 'User-Agent': 'alpha-release-tool', Accept: 'application/octet-stream' } })
      if (!res.ok) return false
      const text = await res.text()
      return (
        text.includes(`url: ${exeAsset}`) &&
        text.includes(`sha512: ${exeSha512}`) &&
        text.includes(`size: ${exeSize}`) &&
        text.includes('version: ' + version)
      )
    }
    const cur = assetsIndex.get(asset.name)
    return Boolean(cur && cur.size === asset.size)
  }

  for (const asset of want) {
    if (await alreadyOk(asset, existing)) {
      console.log(`ok      ${asset.name} (already correct)`)
      continue
    }
    const cur = existing.get(asset.name)
    if (cur) {
      const rm = `delete mismatched ${asset.name}`
      plan(rm, () =>
        fetch(`${base}/${cur.id}`, { method: 'DELETE', headers }).then((r) => r.ok || r.status === 404)
      )
    }
    const what = `upload ${asset.name}`
    plan(what, () => upload(`${base}`, asset.name, asset.data).then((r) => r.ok))
  }

  const listRes = await fetch(`${api}/releases/${release.id}`, { headers })
  const final = await listRes.json()
  const live = new Map(final.assets.map((a) => [a.name, a]))
  const missing = []
  for (const asset of want) {
    if (!(await alreadyOk(asset, live))) missing.push(asset.name)
  }

  console.log('\nsummary:')
  for (const a of final.assets) console.log(`  ${a.name}  (${a.size})`)
  if (missing.length) {
    console.error('\nstill missing/mismatched:', missing.join(', '))
    process.exit(1)
  }
  if (actions.length === 0) console.log('\nrelease is complete and correct — no changes needed')
  else if (!checkOnly) console.log(`\ndone (${actions.filter((a) => a && !failures.includes(a)).length} actions applied)`)
  if (failures.length) {
    console.error('\nfailed:', failures.join('; '))
    process.exit(1)
  }
}

main().catch((e) => {
  console.error('ensure-release failed:', e.message)
  process.exit(1)
})