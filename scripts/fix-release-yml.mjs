// Re-writes the published latest.yml for the given version so its sha512/size
// match the ACTUAL installer that was uploaded.
//
// Needed because electron-builder on Windows can sign/re-touch the NSIS exe
// AFTER generating latest.yml, so the staged hash no longer matches the file it
// uploads -> auto-update integrity would fail. This script recomputes the hash
// from the final local exe and re-uploads latest.yml.
//
// Usage: node scripts/fix-release-yml.mjs <version>   (e.g. 1.0.1)
// Requires: GH_TOKEN environment variable (fine-grained token, contents write).

import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const repo = 'martinssqeel-maker/Alpha-'
const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'))
const version = process.argv[2] ?? pkg.version

const token = process.env.GH_TOKEN
if (!token) {
  console.error('GH_TOKEN is not set')
  process.exit(1)
}

const api = `https://api.github.com/repos/${repo}`
const headers = {
  Accept: 'application/vnd.github+json',
  Authorization: `Bearer ${token}`,
  'User-Agent': 'alpha-release-fix',
  'X-GitHub-Api-Version': '2022-11-28'
}

const exeFile = join(process.cwd(), 'release', `Alpha AI Workspace-Setup-${version}.exe`)
const exeName = `Alpha-AI-Workspace-Setup-${version}.exe`

try {
  const size = statSync(exeFile).size
  const sha512 = createHash('sha512').update(readFileSync(exeFile)).digest('base64')
  console.log(`exe: ${exeName} (${size} bytes)`)
  console.log(`sha512: ${sha512}`)

  const releaseRes = await fetch(`${api}/releases/tags/v${version}`, { headers })
  if (!releaseRes.ok) throw new Error(`release lookup failed: ${releaseRes.status} ${await releaseRes.text()}`)
  const release = await releaseRes.json()
  console.log(`release id ${release.id} (${release.tag_name})`)

  const oldYml = release.assets.find((a) => a.name === 'latest.yml')
  const uploadBase = `https://uploads.github.com/repos/${repo}/releases/${release.id}/assets`

  if (oldYml) {
    const del = await fetch(`${api}/releases/assets/${oldYml.id}`, { method: 'DELETE', headers })
    if (!del.ok) throw new Error(`delete old latest.yml failed: ${del.status}`)
    console.log('deleted old latest.yml')
  }

  const ymlBody = [
    'version: ' + version,
    'files:',
    '  - url: ' + exeName,
    '    sha512: ' + sha512,
    `    size: ${size}`,
    'path: ' + exeName,
    'sha512: ' + sha512,
    'releaseDate: ' + JSON.stringify(new Date().toISOString())
  ].join('\n')

  const upload = await fetch(
    `${uploadBase}?name=latest.yml`,
    {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/octet-stream' },
      body: Buffer.from(ymlBody, 'utf8')
    }
  )
  if (!upload.ok) throw new Error(`upload latest.yml failed: ${upload.status} ${await upload.text()}`)
  console.log('uploaded corrected latest.yml')
} catch (e) {
  console.error('fix-release-yml failed:', e.message)
  process.exit(1)
}