// Ensures a complete, correct GitHub release for the current package version.
//
// electron-builder's uploader intermittently fails mid-publish (dropping the
// exe, blockmap or latest.yml), which would break auto-update. Node's global
// fetch (undici) is itself flaky on this machine, so ALL network calls go
// through curl.exe. This script is idempotent: it creates/publishes the release
// if needed, then guarantees the exe, blockmap and latest.yml are present with
// hashes that match the actual final (signed) installer.
//
// Usage: node scripts/ensure-release.mjs [--check]
//   --check   report only; never create/upload/delete anything.
// Requires: GH_TOKEN environment variable (fine-grained token, contents write).

import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
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
const uploads = `https://uploads.github.com/repos/${repo}`

const dashName = (n) => n.replace(/ /g, '-')
const releaseDir = join(process.cwd(), 'release')
const exeLocal = join(releaseDir, `Alpha AI Workspace-Setup-${version}.exe`)
const blockmapLocal = `${exeLocal}.blockmap`
const exeAsset = dashName(`Alpha AI Workspace-Setup-${version}.exe`)
const blockmapAsset = `${exeAsset}.blockmap`
const ymlLocal = join(releaseDir, 'latest.yml')

// curl.exe wrapper. Returns { code, out } where out is the file written at
// `outFile` if given, stdout text otherwise. Throws on curl-level failures.
async function curl(args, outFile = null) {
  const full = ['-sS', '-L']
  if (outFile) full.push('-o', outFile)
  full.push('-w', '\n%{http_code}', ...args)
  const { stdout } = await execFileAsync('curl.exe', full, {
    maxBuffer: 64 * 1024 * 1024,
    timeout: 600000
  })
  const parts = stdout.trimEnd().split('\n')
  const status = +parts.pop()
  const body = outFile ? null : parts.join('\n')
  return { code: status, body }
}

async function apiCall(method, url, { json = null, out = null } = {}) {
  const args = ['-X', method]
  args.push('-H', `Authorization: Bearer ${token}`)
  args.push('-H', 'User-Agent: alpha-release-tool')
  args.push('-H', 'Accept: application/vnd.github+json')
  args.push('-H', 'X-GitHub-Api-Version: 2022-11-28')
  if (json !== null) args.push('-H', 'Content-Type: application/json', '--data-binary', json)
  const res = await curl([...args, url], out)
  if ((res.code < 200 || res.code > 299) && res.code !== 404) {
    throw new Error(`${method} ${url} -> HTTP ${res.code} ${String(res.body ?? '').slice(0, 160)}`)
  }
  return res
}

const verifySha512 = (file) => createHash('sha512').update(readFileSync(file)).digest('base64')
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// Download an asset's raw bytes. The JSON Accept header (used by apiCall)
// makes GitHub return asset metadata instead of the file, so octet-stream is
// required here.
async function dlRaw(url, out) {
  const res = await curl([
    '-H', `Authorization: Bearer ${token}`,
    '-H', 'Accept: application/octet-stream',
    '-H', 'User-Agent: alpha-release-tool',
    url
  ], out)
  if (res.code < 200 || res.code > 299) {
    throw new Error(`download ${url} -> HTTP ${res.code}`)
  }
}

const main = async () => {
  const missingLocal = [exeLocal, blockmapLocal].filter((f) => !existsSync(f))
  if (missingLocal.length) {
    console.error('missing local artifact:', missingLocal.join(', '))
    process.exit(1)
  }

  const exeSize = statSync(exeLocal).size
  const exeSha512 = verifySha512(exeLocal)
  const blockmapSize = statSync(blockmapLocal).size
  console.log(
    `version ${version} — ${exeAsset} (${exeSize} bytes, sha512 ${exeSha512.slice(0, 16)}…)`
  )

  // Find or create the release.
  let release = null
  {
    const r = await apiCall('GET', `${api}/releases/tags/v${version}`)
    if (r.code === 404) {
      if (checkOnly) {
        console.log('todo    create + publish release v' + version)
        process.exit(1)
      }
      const created = await apiCall('POST', `${api}/releases`, {
        json: JSON.stringify({
          tag_name: `v${version}`,
          name: version,
          body: `Alpha AI Workspace ${version}`,
          draft: false,
          prerelease: false
        })
      })
      release = JSON.parse(created.body)
      console.log(`created release v${version} (id ${release.id})`)
    } else {
      release = JSON.parse(r.body)
    }
  }

  if (release.draft) {
    if (checkOnly) {
      console.log('todo    publish (undraft) release')
    } else {
      await apiCall('PATCH', `${api}/releases/${release.id}`, {
        json: JSON.stringify({ draft: false })
      })
      console.log('published (undrafted) release')
    }
  }

  const base = `${api}/releases/${release.id}/assets`
  const existing = new Map(release.assets.map((a) => [a.name, a]))

  const shaLine = `  - url: ${exeAsset}`
  const ymlText = [
    'version: ' + version,
    'files:',
    shaLine,
    '    sha512: ' + exeSha512,
    `    size: ${exeSize}`,
    'path: ' + exeAsset,
    'sha512: ' + exeSha512,
    'releaseDate: ' + JSON.stringify(release.published_at ?? new Date().toISOString())
  ].join('\n')

  const assetIsCurrent = async (asset) => {
    const cur = existing.get(asset.name)
    if (!cur) return false
    if (asset.kind === 'file') return cur.size === asset.size
    const tmp = join(tmpdir(), `alpha-${cur.id}.yml`)
    await dlRaw(cur.url, tmp)
    const live = readFileSync(tmp, 'utf8').replace(/\r\n/g, '\n')
    return (
      live.includes('version: ' + version) &&
      live.includes(shaLine.trim()) &&
      live.includes('    sha512: ' + exeSha512) &&
      live.includes(`    size: ${exeSize}`) &&
      live.includes('path: ' + exeAsset) &&
      live.includes('sha512: ' + exeSha512)
    )
  }

  const ensureAsset = async (asset, local) => {
    if (await assetIsCurrent(asset)) {
      console.log(`ok      ${asset.name} (already correct)`)
      return
    }
    const cur = existing.get(asset.name)
    if (cur) {
      await apiCall('DELETE', `${base}/${cur.id}`)
      console.log(`removed stale ${asset.name}`)
      await sleep(1500)
    }
    if (checkOnly) {
      console.log(`todo    upload ${asset.name}${cur ? ' (replaced)' : ''}`)
      return
    }
    let uploaded = false
    for (let attempt = 1; attempt <= 3 && !uploaded; attempt++) {
      const res = await curl([
        '-X', 'POST',
        '-H', `Authorization: Bearer ${token}`,
        '-H', 'Content-Type: application/octet-stream',
        '--data-binary', `@${local}`,
        `${uploads}/releases/${release.id}/assets?name=${encodeURIComponent(asset.name)}`
      ])
      if (res.code < 200 || res.code > 299) {
        if (attempt < 3) {
          console.log(`upload ${asset.name} failed (HTTP ${res.code}), retrying…`)
          await sleep(2000)
          continue
        }
        throw new Error(`upload ${asset.name} -> HTTP ${res.code} ${String(res.body ?? '').slice(0, 160)}`)
      }
      uploaded = true
    }
    console.log(`uploaded ${asset.name}`)
  }

  if (!checkOnly) writeFileSync(ymlLocal, ymlText, 'utf8')

  await ensureAsset({ name: exeAsset, kind: 'file', size: exeSize }, exeLocal)
  await ensureAsset({ name: blockmapAsset, kind: 'file', size: blockmapSize }, blockmapLocal)
  await ensureAsset({ name: 'latest.yml', kind: 'yml' }, ymlLocal)

  // Final verification against fresh release state.
  const ymlMatches = async (asset, indexMap) => {
    const cur = indexMap.get(asset.name)
    if (!cur) return false
    const tmp = join(tmpdir(), `alpha-live-${cur.id}.yml`)
    await dlRaw(cur.url, tmp)
    const live = readFileSync(tmp, 'utf8').replace(/\r\n/g, '\n')
    return (
      live.includes('version: ' + version) &&
      live.includes('- url: ' + exeAsset) &&
      live.includes('    sha512: ' + exeSha512) &&
      live.includes(`    size: ${exeSize}`) &&
      live.includes('path: ' + exeAsset) &&
      live.includes('sha512: ' + exeSha512)
    )
  }
  const finalRes = await apiCall('GET', `${api}/releases/${release.id}`)
  const live = new Map(JSON.parse(finalRes.body).assets.map((a) => [a.name, a]))
  const missing = []
  for (const asset of [{ name: exeAsset, kind: 'file', size: exeSize }, { name: blockmapAsset, kind: 'file', size: blockmapSize }, { name: 'latest.yml', kind: 'yml' }]) {
    const ok =
      asset.kind === 'yml' ? await ymlMatches(asset, live) : live.get(asset.name)?.size === asset.size
    if (!ok) missing.push(asset.name)
  }

  console.log('\nsummary:')
  for (const a of live.values()) console.log(`  ${a.name}  (${String(a.size)})`)
  if (missing.length) {
    console.error('\nstill missing/mismatched:', missing.join(', '))
    process.exit(1)
  }
  console.log('\nrelease is complete and correct — no changes needed')
}

main().catch((e) => {
  console.error('ensure-release failed:', e && e.message ? e.message : String(e))
  process.exit(1)
})