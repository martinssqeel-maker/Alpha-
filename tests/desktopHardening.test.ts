/**
 * Release hardening: the three fixes plus release-sync invariants.
 *
 *   1. PowerShell arguments — user text must never be interpolated into a script,
 *      and values that reach a cmdlet parameter must be escaped for it.
 *   2. HUD delivery — a state push must be refused when there is no live receiver.
 *   3. Ollama probing — transient connection failures retry; HTTP answers do not.
 *
 * Plus the release invariants: one version number across the app, and no
 * hardcoded version in the static site (it resolves the published release).
 */
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { canDeliverHudState } from '../src/main/services/hudGuard'
import {
  clampElementId,
  INTERACTIVE_CONTROL_TYPES,
  normalizeKeys,
  sanitizeEnvValue
} from '../src/main/services/desktopInput'
import {
  isRetryableProbeError,
  OLLAMA_PROBE_DELAYS_MS,
  OllamaAdapter,
  retryWithBackoff
} from '../src/main/services/providers/ollama'
import { APP_VERSION } from '../src/shared/types'

afterEach(() => {
  vi.restoreAllMocks()
})

const repoRoot = path.resolve(__dirname, '..')
const read = (relative: string): string => fs.readFileSync(path.join(repoRoot, relative), 'utf8')

/**
 * Pull the PowerShell script literals out of a source file.
 *
 * Matches `const FOO_SCRIPT = \`…\`` and `export const FOO_PRELUDE = \`…\``.
 * The scripts are plain template literals containing no backticks of their own,
 * which is what makes this extraction reliable; if that ever stops being true,
 * the "has no script literals" assertion below fails loudly.
 */
function extractPowerShellScripts(source: string): Array<{ name: string; body: string }> {
  const pattern = /(?:export\s+)?const\s+([A-Z][A-Z0-9_]*)\s*=\s*`([\s\S]*?)`/g
  const out: Array<{ name: string; body: string }> = []
  for (const match of source.matchAll(pattern)) {
    const [, name, body] = match
    if (!/_SCRIPT$|_PRELUDE$/.test(name)) continue
    out.push({ name, body })
  }
  return out
}

// ---------------------------------------------------------------------------
// 1. PowerShell argument safety
// ---------------------------------------------------------------------------

describe('PowerShell argument safety', () => {
  it('strips NUL, which would truncate the environment block', () => {
    expect(sanitizeEnvValue('Bob\0s App')).toBe('Bobs App')
    expect(sanitizeEnvValue('a\0b\0c')).toBe('abc')
  })

  it('caps a value at the practical environment-variable limit', () => {
    expect(sanitizeEnvValue('x'.repeat(50_000))).toHaveLength(32_000)
  })

  it('coerces non-strings rather than passing undefined to a child process', () => {
    expect(sanitizeEnvValue(undefined as unknown as string)).toBe('')
    expect(sanitizeEnvValue(42 as unknown as string)).toBe('42')
  })

  it('runs every script through -EncodedCommand so no value passes a command line', () => {
    const source = read('src/main/services/desktopService.ts')
    expect(source).toContain("'—EncodedCommand'".replace('—', '-'))
    expect(source).toContain('utf16le')
    // The script is encoded, so quoting rules cannot be violated by data.
    expect(source).toMatch(/Buffer\.from\(script, 'utf16le'\)\.toString\('base64'\)/)
  })

  it('never interpolates data into PowerShell script text', () => {
    for (const file of [
      'src/main/services/desktopService.ts',
      'src/main/services/computerUseService.ts'
    ]) {
      const scripts = extractPowerShellScripts(read(file))
      // The files must actually contain scripts; a refactor that renamed every
      // constant would otherwise make this test pass vacuously.
      expect(scripts.length, `${file} has no script literals`).toBeGreaterThan(0)

      for (const script of scripts) {
        // Inside a script literal the only allowed `${...}` is a build-time
        // constant assembled from another constant (the result marker, a shared
        // prelude). A runtime value spliced in here would be the injection.
        const interpolations = [...script.body.matchAll(/\$\{([^}]*)\}/g)].map((m) => m[1].trim())
        const offenders = interpolations.filter(
          (name) => !/^(RESULT_MARKER|PS_[A-Z_]+|[A-Z][A-Z0-9_]*PRELUDE|[A-Z][A-Z0-9_]*_SCRIPT)$/.test(name)
        )
        expect(offenders, `${file} → ${script.name} interpolates: ${offenders.join(', ')}`).toEqual([])
      }
    }
  })

  it('reads user data from the environment, never from the script body', () => {
    const scripts = [
      ...extractPowerShellScripts(read('src/main/services/desktopService.ts')),
      ...extractPowerShellScripts(read('src/main/services/computerUseService.ts'))
    ]
    const all = scripts.map((s) => s.body).join('\n')
    // Every value that crosses the boundary does so as ALPHA_*.
    expect(all).toContain('$env:ALPHA_APP_QUERY')
    expect(all).toContain('$env:ALPHA_WINDOW_HANDLE')
    expect(all).toContain('$env:ALPHA_CLIP_FILE')
  })

  it('escapes wildcard characters before matching an application name', () => {
    const source = read('src/main/services/desktopService.ts')
    // `-like "*$q*"` throws on '[' and over-matches on '*' — neither may remain.
    expect(source).not.toMatch(/-like\s+"\*\$q\*"/)
    expect(source).toContain('WildcardPattern]::Escape')
    expect(source).toContain('function Test-AlphaContains')
    // The launch search must use the escaping helpers.
    expect(source).toMatch(/Test-AlphaContains \$_\.\w+ \$q/)
  })

  it('uses -LiteralPath for values that can contain brackets', () => {
    const source = read('src/main/services/desktopService.ts')
    // Installed paths such as "C:\\Program Files\\App [x64]\\app.exe".
    expect(source).toContain('Test-Path -LiteralPath $exe')
    expect(source).toContain('Get-Content -Raw -LiteralPath')
    expect(source).toContain('Get-ChildItem -LiteralPath $dir')

    const clipboard = read('src/main/services/computerUseService.ts')
    expect(clipboard).toContain('Get-Content -Raw -LiteralPath $file')
  })

  it('sends clipboard payloads through a temp file, not an environment variable', () => {
    const source = read('src/main/services/computerUseService.ts')
    expect(source).not.toContain('ALPHA_CLIP_TEXT')
    expect(source).toContain('ALPHA_CLIP_FILE')
    expect(source).toContain('private async setClipboard')
  })
})

describe('keystroke specs', () => {
  it('defaults to a plain paste when nothing usable is given', () => {
    expect(normalizeKeys('')).toBe('^v')
    expect(normalizeKeys('   ')).toBe('^v')
    // `$` is not a SendKeys character, so a spec of only `$` collapses.
    expect(normalizeKeys('$$$')).toBe('^v')
  })

  it('keeps SendKeys modifiers and drops anything else', () => {
    expect(normalizeKeys('^v')).toBe('^v')
    expect(normalizeKeys('^+s')).toBe('^+s')
    expect(normalizeKeys('%{F4}')).toBe('%{F4}')
    expect(normalizeKeys('^{ENTER}')).toBe('^{ENTER}')
  })

  it('strips characters that are neither keys nor modifiers', () => {
    // `;` and `/` are stripped; `-` and spaces are kept because they are safe.
    expect(normalizeKeys('^v; rm -rf /')).toBe('^v rm -rf')
    // Control whitespace is removed outright (it is not in the allowed set);
    // a real space survives and runs of it collapse to one.
    expect(normalizeKeys('a\nb\tc')).toBe('abc')
    expect(normalizeKeys('a   b')).toBe('a b')
    expect(normalizeKeys('"quoted"')).toBe('quoted')
  })

  it('caps the number of synthetic keystrokes', () => {
    expect(normalizeKeys('a'.repeat(500))).toHaveLength(120)
  })
})

describe('UI Automation element ids', () => {
  it('clamps to a 1-based index inside the inspected range', () => {
    expect(clampElementId(0)).toBe(1)
    expect(clampElementId(-4)).toBe(1)
    expect(clampElementId(7)).toBe(7)
    expect(clampElementId(9999, 150)).toBe(150)
    expect(clampElementId('12')).toBe(12)
    expect(clampElementId(Number.NaN)).toBe(1)
    expect(clampElementId(3.9)).toBe(3)
  })

  it('exposes one control-type list for every script that numbers the tree', () => {
    expect(INTERACTIVE_CONTROL_TYPES).toContain('Button')
    expect(INTERACTIVE_CONTROL_TYPES).toContain('Edit')
    // The scripts are generated from this list; it must not contain duplicates.
    expect(new Set(INTERACTIVE_CONTROL_TYPES).size).toBe(INTERACTIVE_CONTROL_TYPES.length)
  })
})

// ---------------------------------------------------------------------------
// 2. HUD delivery guard
// ---------------------------------------------------------------------------

describe('canDeliverHudState', () => {
  const live = {
    disposed: false,
    ready: true,
    windowDestroyed: false,
    hasWebContents: true,
    contentsDestroyed: false
  }

  it('allows delivery to a live, loaded surface', () => {
    expect(canDeliverHudState(live)).toBe(true)
  })

  it('refuses after dispose, so a queued event cannot resurrect the pill', () => {
    expect(canDeliverHudState({ ...live, disposed: true })).toBe(false)
  })

  it('refuses before the document has loaded', () => {
    expect(canDeliverHudState({ ...live, ready: false })).toBe(false)
  })

  it('refuses a destroyed window', () => {
    expect(canDeliverHudState({ ...live, windowDestroyed: true })).toBe(false)
  })

  it('refuses a missing or destroyed webContents', () => {
    expect(canDeliverHudState({ ...live, hasWebContents: false })).toBe(false)
    expect(canDeliverHudState({ ...live, contentsDestroyed: true })).toBe(false)
  })

  it('is what the HUD actually calls before every send', () => {
    const source = read('src/main/hudWindow.ts')
    expect(source).toContain('canDeliverHudState(')
    // The three classic hazards must all appear as guards in the module.
    expect(source).toMatch(/contents\.isDestroyed\(\)/)
    expect(source).toContain('win.webContents')
    expect(source).toContain('this.disposed')
    expect(source).toMatch(/render-process-gone/)
  })
})

// ---------------------------------------------------------------------------
// 3. Ollama probe retry
// ---------------------------------------------------------------------------

describe('Ollama probe retry', () => {
  it('classifies transient connection failures as retryable', () => {
    const refused = Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } })
    expect(isRetryableProbeError(refused)).toBe(true)
    expect(isRetryableProbeError(new Error('socket hang up'))).toBe(true)
    expect(isRetryableProbeError(Object.assign(new Error('x'), { code: 'ECONNRESET' }))).toBe(true)
  })

  it('does not retry an abort or an HTTP answer', () => {
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' })
    expect(isRetryableProbeError(abort)).toBe(false)
    expect(isRetryableProbeError(new Error('Ollama returned HTTP 500'))).toBe(false)
    expect(isRetryableProbeError(new Error('Unknown model'))).toBe(false)
  })

  it('retries the configured number of times and then succeeds', async () => {
    let attempts = 0
    const value = await retryWithBackoff(
      async () => {
        attempts++
        if (attempts < 3) throw Object.assign(new Error('fetch failed'), { code: 'ECONNREFUSED' })
        return 'ok'
      },
      { delays: [0, 0] }
    )
    expect(value).toBe('ok')
    expect(attempts).toBe(3)
  })

  it('gives up after the schedule and rethrows the last error', async () => {
    let attempts = 0
    await expect(
      retryWithBackoff(
        async () => {
          attempts++
          throw Object.assign(new Error('fetch failed'), { code: 'ECONNREFUSED' })
        },
        { delays: [0, 0] }
      )
    ).rejects.toThrow(/fetch failed/)
    expect(attempts).toBe(3)
  })

  it('does not retry when the failure is not transient', async () => {
    let attempts = 0
    await expect(
      retryWithBackoff(
        async () => {
          attempts++
          throw new Error('permission denied')
        },
        { delays: [0, 0] }
      )
    ).rejects.toThrow(/permission denied/)
    expect(attempts).toBe(1)
  })

  it('has a short schedule: the UI is loading while this runs', () => {
    expect(OLLAMA_PROBE_DELAYS_MS.length).toBeGreaterThan(0)
    expect(Math.max(...OLLAMA_PROBE_DELAYS_MS)).toBeLessThanOrEqual(3000)
  })

  it('recovers when Ollama comes up between two probes', async () => {
    let calls = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        calls++
        if (calls === 1) {
          throw Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } })
        }
        return new Response(
          JSON.stringify({
            models: [
              { name: 'qwen3:1.7b', model: 'qwen3:1.7b', size: 1, capabilities: ['tools'] }
            ]
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      })
    )

    const adapter = new OllamaAdapter()
    const models = await adapter.listModels('http://127.0.0.1:11434', null)
    expect(models.map((m) => m.id)).toEqual(['qwen3:1.7b'])
    expect(models[0].capabilities.tools).toBe(true)
    expect(calls).toBe(2)
  }, 15_000)

  it('reports an HTTP error once, without retrying', async () => {
    let calls = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        calls++
        return new Response('boom', { status: 500 })
      })
    )
    const adapter = new OllamaAdapter()
    await expect(adapter.listModels('http://127.0.0.1:11434', null)).rejects.toThrow(/HTTP 500/)
    expect(calls).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Release sync invariants
// ---------------------------------------------------------------------------

describe('release version sync', () => {
  it('keeps package.json and the shared APP_VERSION identical', () => {
    const pkg = JSON.parse(read('package.json')) as { version: string }
    expect(pkg.version).toBe(APP_VERSION)
    expect(pkg.version).toBe('1.0.7')
  })

  it('does not hardcode an old version anywhere in the static site', () => {
    // The site resolves the published release; a literal here would be a page
    // that keeps advertising a version after the next release.
    const html = fs
      .readdirSync(path.join(repoRoot, 'website'))
      .filter((name) => name.endsWith('.html'))
    for (const file of html) {
      const source = read(path.join('website', file))
      expect(source, `${file} mentions an old version`).not.toMatch(/\b1\.0\.[0-6]\b/)
    }
  })

  it('resolves the release version and tagged link from GitHub, not from a constant', () => {
    const source = read('website/assets/app.js')
    expect(source).toContain('api.github.com/repos/')
    expect(source).toContain('releases/latest')
    expect(source).toContain('data-release-link')
    expect(source).toContain('data-version')
  })

  it('points the download page at the release feed with a static fallback', () => {
    const page = read('website/download.html')
    expect(page).toContain('data-version')
    expect(page).toContain('data-release-link')
    expect(page).toContain('releases/latest')
    expect(page).toContain('assets/app.js')
  })

  it('keeps the updater publishing to the repository the app is built from', () => {
    const builder = read('electron-builder.yml')
    expect(builder).toContain('owner: martinssqeel-maker')
    expect(builder).toContain('repo: Alpha-')
    expect(builder).toContain('provider: github')
  })
})
