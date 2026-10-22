/**
 * Release registration must point at an asset that actually exists.
 *
 * Regression guard for a real defect: `register-release.mjs` built the installer
 * URL by replacing the spaces in `productName` with dashes, but v1.0.7 was
 * published by electron-builder as `Alpha.AI.Workspace-Setup-1.0.7.exe` (dots).
 * The guessed URL answered 404, so with verification enabled registration could
 * only fail, and with `--no-verify` it would have written a dead link into
 * `public.releases` — every signed-in user handed a 404.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const script = fs.readFileSync(path.resolve(__dirname, '../scripts/register-release.mjs'), 'utf8')

describe('release registration', () => {
  it('resolves the published asset from the GitHub API instead of guessing', () => {
    expect(script).toContain('releases/tags/v${v}')
    expect(script).toContain('browser_download_url')
  })

  it('knows both spellings this repository has produced', () => {
    // Dashes come from ensure-release.mjs, dots from electron-builder's upload.
    expect(script).toContain("base.replace(/ /g, '.')")
    expect(script).toContain("base.replace(/ /g, '-')")
  })

  it('never picks the blockmap or a non-executable', () => {
    expect(script).toContain('.exe$')
    expect(script).toContain('blockmap')
  })

  it('keeps the safety checks that stop a row describing bytes nobody can download', () => {
    expect(script).toContain('did not report a length')
    expect(script).toContain('the local')
    expect(script).toContain('--no-verify')
  })

  it('still requires a built installer and a database URL', () => {
    expect(script).toContain("path.join(repoRoot, 'release'")
    expect(script).toContain('DATABASE_URL')
  })
})
