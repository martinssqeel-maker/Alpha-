import { execFile, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type {
  AppLaunchResult,
  DesktopWindowInfo,
  ToolVerification
} from '@shared/types'
import { getLogger } from './logger'
import { sanitizeEnvValue } from './desktopInput'
import type { AuthorizedRoots } from './authorizedRoots'

/**
 * Windows application discovery, window control and the Office document bridge.
 *
 * ## Why PowerShell and not native addons
 *
 * The alternative is a `node-gyp` module (or `robotjs`-style binding), which
 * means a native rebuild for every Electron version and an ABI break on every
 * upgrade. This project deliberately has no native dependencies — `sql.js`
 * exists for exactly that reason — so the OS integration uses PowerShell,
 * which is present on every supported Windows install.
 *
 * ## Injection discipline
 *
 * No user or model supplied value is ever concatenated into a script. Every
 * script is a fixed string; all data arrives through environment variables and
 * is read with `$env:NAME`. PowerShell parses the value, not the shell, so a
 * app name of `"; Remove-Item C:\ -Recurse; "` is inert text. Large structured
 * payloads (document content) go through a temporary file whose path is the
 * only thing in the environment.
 */

export class DesktopError extends Error {
  code: string
  constructor(message: string, code = 'desktop_error') {
    super(message)
    this.code = code
  }
}

/** Marker the scripts print before their JSON payload. */
const RESULT_MARKER = '__ALPHA_JSON__'
const DEFAULT_TIMEOUT_MS = 20_000
const LAUNCH_TIMEOUT_MS = 35_000

export interface PowerShellOptions {
  env?: Record<string, string>
  timeoutMs?: number
  signal?: AbortSignal
}

export interface DocumentBlock {
  type: 'title' | 'heading' | 'paragraph' | 'bullet' | 'table' | 'pagebreak'
  text?: string
  level?: number
  rows?: string[][]
}

export interface DocumentRequest {
  app: 'word' | 'excel'
  path: string
  title?: string
  blocks: DocumentBlock[]
  sheets?: { name: string; rows: string[][] }[]
}

export class DesktopService {
  private children = new Set<ChildProcess>()

  constructor(
    private readonly roots: AuthorizedRoots,
    private readonly platform: NodeJS.Platform = process.platform
  ) {}

  get supported(): boolean {
    return this.platform === 'win32'
  }

  dispose(): void {
    this.killAll()
  }

  /** Terminate every in-flight PowerShell process (emergency kill-switch). */
  killAll(): void {
    for (const child of this.children) {
      try {
        child.kill()
      } catch {
        /* already gone */
      }
    }
    this.children.clear()
  }

  // -------------------------------------------------------------------------
  // Application discovery
  // -------------------------------------------------------------------------

  /**
   * Find an installed application by name and bring it to the foreground.
   *
   * Search order is deliberate and mirrors how a person looks for an app:
   * something already running, then the Start menu's app list, then Start menu
   * and desktop shortcuts, then the App Paths registry keys, then `PATH`. The
   * first hit wins and the caller is told which step matched, because "found it
   * in PATH" and "focused the window you already had open" are different
   * outcomes worth distinguishing in the activity log.
   */
  async findAndLaunchApp(query: string): Promise<AppLaunchResult & { verification: ToolVerification }> {
    this.assertWindows('Opening applications')
    const trimmed = query.trim()
    if (!trimmed) {
      return {
        ok: false,
        query,
        message: 'An application name is required.',
        verification: { verified: false, note: 'No application name was supplied.', check: 'input' }
      }
    }

    let raw: LaunchProbe
    try {
      raw = await this.powerShell<LaunchProbe>(LAUNCH_APP_SCRIPT, {
        env: { ALPHA_APP_QUERY: trimmed },
        timeoutMs: LAUNCH_TIMEOUT_MS
      })
    } catch (error) {
      const message = (error as Error).message
      return {
        ok: false,
        query: trimmed,
        message: `Could not search for "${trimmed}": ${message}`,
        verification: { verified: false, note: `Discovery failed: ${message}`, check: 'powershell' }
      }
    }

    if (!raw.found) {
      return {
        ok: false,
        query: trimmed,
        message: `No installed application matched "${trimmed}". Try the exact Start-menu name.`,
        verification: {
          verified: false,
          note: `Searched running processes, Start apps, shortcuts, App Paths and PATH; no match for "${trimmed}".`,
          check: 'app-discovery'
        }
      }
    }

    // Trust, but verify: the window is what proves the app actually opened.
    const window = await this.waitForWindow(raw.processId, raw.windowTitle, 8000)
    const launchedPid = raw.processId
    const verified = typeof launchedPid === 'number' && isProcessAlive(launchedPid)
    return {
      ok: true,
      query: trimmed,
      appName: raw.name ?? trimmed,
      executablePath: raw.executablePath,
      processId: raw.processId,
      windowTitle: window?.title ?? raw.windowTitle,
      windowHandle: window?.windowHandle,
      discoveredVia: raw.via,
      alreadyRunning: raw.via === 'running',
      message: raw.via === 'running' ? 'The application was already running; focused it.' : undefined,
      verification: {
        verified,
        note: verified
          ? `Process ${launchedPid} is running${window?.title ? ` with window "${window.title}"` : ' (window still initialising)'}.`
          : 'The launcher reported success but the process is not alive.',
        check: 'process'
      }
    }
  }

  /** Every visible top-level window, foreground first. */
  async listOpenWindows(): Promise<DesktopWindowInfo[]> {
    this.assertWindows('Listing windows')
    const result = await this.powerShell<{ windows?: RawWindow[] }>(LIST_WINDOWS_SCRIPT, {
      timeoutMs: 15_000
    })
    const windows = result.windows ?? []
    return windows
      .map((w) => ({
        processId: Number(w.processId) || 0,
        windowHandle: String(w.windowHandle ?? ''),
        title: String(w.title ?? ''),
        processName: w.processName,
        bounds:
          w.x !== undefined && w.width !== undefined
            ? { x: Number(w.x), y: Number(w.y), width: Number(w.width), height: Number(w.height) }
            : undefined,
        isForeground: Boolean(w.isForeground)
      }))
      .filter((w) => w.processId > 0 && w.title.trim().length > 0)
      .sort((a, b) => Number(b.isForeground) - Number(a.isForeground))
  }

  /** Bring a window to the foreground by PID or by a title fragment. */
  async focusWindow(
    target: string | number
  ): Promise<{ ok: boolean; title?: string; processId?: number; message?: string; verification: ToolVerification }> {
    this.assertWindows('Focusing windows')
    const resolved = await this.resolveWindowTarget(target)
    if (!resolved) {
      return {
        ok: false,
        message: `No open window matched "${String(target)}".`,
        verification: { verified: false, note: 'No matching window.', check: 'window' }
      }
    }
    const result = await this.powerShell<{ ok: boolean; message?: string }>(FOCUS_WINDOW_SCRIPT, {
      env: { ALPHA_TARGET_PID: String(resolved.processId) },
      timeoutMs: 12_000
    })
    const foreground = await this.foregroundProcessId()
    const verified = Boolean(result.ok) && foreground === resolved.processId
    return {
      ok: Boolean(result.ok),
      title: resolved.title,
      processId: resolved.processId,
      message: result.message,
      verification: {
        verified,
        note: verified
          ? `"${resolved.title}" is the foreground window.`
          : `Activation was requested but the foreground process is ${foreground ?? 'unknown'}.`,
        check: 'foreground-window'
      }
    }
  }

  /** Ask a window to close; force-kills only after a grace period. */
  async closeWindow(
    target: string | number
  ): Promise<{ ok: boolean; message?: string; verification: ToolVerification }> {
    this.assertWindows('Closing windows')
    const resolved = await this.resolveWindowTarget(target)
    if (!resolved) {
      return {
        ok: false,
        message: `No open window matched "${String(target)}".`,
        verification: { verified: false, note: 'No matching window.', check: 'window' }
      }
    }
    await this.powerShell<{ ok: boolean }>(CLOSE_WINDOW_SCRIPT, {
      env: { ALPHA_TARGET_PID: String(resolved.processId) },
      timeoutMs: 20_000
    })
    await sleep(600)
    const stillAlive = isProcessAlive(resolved.processId)
    return {
      ok: !stillAlive,
      message: stillAlive ? `"${resolved.title}" is still running.` : undefined,
      verification: {
        verified: !stillAlive,
        note: stillAlive
          ? `Process ${resolved.processId} is still alive after the close request.`
          : `Process ${resolved.processId} exited.`,
        check: 'process'
      }
    }
  }

  // -------------------------------------------------------------------------
  // Office / document bridge
  // -------------------------------------------------------------------------

  /**
   * Create or format a Word/Excel document, preferring live COM automation so
   * the user watches it being written, with an honest local fallback when Office
   * is not installed.
   */
  async createDocument(
    request: DocumentRequest
  ): Promise<{
    ok: boolean
    path: string
    engine: 'word-com' | 'excel-com' | 'file-fallback'
    message?: string
    verification: ToolVerification
  }> {
    this.assertWindows('Creating documents')

    // Resolve and authorise the destination first: COM would happily write to
    // C:\Windows, and we must not let it.
    const target = this.roots.resolve(request.path)
    const ext = path.extname(target.abs).toLowerCase()
    const wanted = request.app === 'excel' ? '.xlsx' : '.docx'
    const finalPath = ext === wanted ? target.abs : replaceExtension(target.abs, wanted)
    this.roots.ensureParent(finalPath)

    const payloadFile = path.join(os.tmpdir(), `alpha-doc-${process.pid}-${Date.now()}.json`)
    const payload = {
      app: request.app,
      path: finalPath,
      title: request.title ?? null,
      blocks: request.blocks.map((b) => ({
        type: b.type,
        text: b.text ?? '',
        level: b.level ?? 1,
        rows: b.rows ?? []
      })),
      sheets: request.sheets ?? []
    }
    fs.writeFileSync(payloadFile, JSON.stringify(payload), 'utf8')

    try {
      const result = await this.powerShell<{ ok: boolean; engine?: string; message?: string }>(
        request.app === 'excel' ? EXCEL_SCRIPT : WORD_SCRIPT,
        { env: { ALPHA_DOC_JSON: payloadFile }, timeoutMs: 90_000 }
      )

      if (result.ok && (result.engine === 'word-com' || result.engine === 'excel-com')) {
        return {
          ok: true,
          path: finalPath,
          engine: result.engine,
          verification: this.verifyFile(finalPath, 'office-com')
        }
      }
    } catch (error) {
      getLogger().warn('desktop', `COM automation failed: ${(error as Error).message}`)
    } finally {
      try {
        fs.rmSync(payloadFile, { force: true })
      } catch {
        /* temp file only */
      }
    }

    // Office absent or COM blocked: still produce something real and say so.
    const fallbackPath = replaceExtension(finalPath, '.rtf')
    fs.writeFileSync(fallbackPath, renderRtf(request), 'utf8')
    const verification = this.verifyFile(fallbackPath, 'fs.stat')
    return {
      ok: verification.verified,
      path: fallbackPath,
      engine: 'file-fallback',
      message: `Microsoft ${request.app === 'excel' ? 'Excel' : 'Word'} automation was unavailable, so the content was written as ${path.basename(fallbackPath)} (rich text, opens in Word).`,
      verification: {
        ...verification,
        note: `Office automation unavailable; wrote ${path.basename(fallbackPath)} instead. ${verification.note}`
      }
    }
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  /** Shared proof-of-work probe for anything that claims to have written a file. */
  verifyFile(absPath: string, check = 'fs.stat'): ToolVerification {
    try {
      const stat = fs.statSync(absPath)
      if (!stat.isFile()) {
        return { verified: false, note: `${absPath} exists but is not a file.`, check }
      }
      if (stat.size === 0) {
        return { verified: false, note: `${absPath} was created but is empty.`, check }
      }
      return {
        verified: true,
        note: `Wrote ${stat.size} bytes to ${absPath} at ${new Date(stat.mtimeMs).toISOString()}.`,
        check
      }
    } catch {
      return { verified: false, note: `No file exists at ${absPath}.`, check }
    }
  }

  private async resolveWindowTarget(target: string | number): Promise<DesktopWindowInfo | null> {
    const windows = await this.listOpenWindows()
    if (typeof target === 'number') {
      return windows.find((w) => w.processId === target) ?? null
    }
    const probe = target.trim().toLowerCase()
    if (!probe) return null
    // Exact title, then prefix, then substring — and prefer the foreground copy.
    return (
      windows.find((w) => w.title.toLowerCase() === probe) ??
      windows.find((w) => w.title.toLowerCase().startsWith(probe)) ??
      windows.find((w) => w.title.toLowerCase().includes(probe)) ??
      null
    )
  }

  private async foregroundProcessId(): Promise<number | null> {
    try {
      const result = await this.powerShell<{ processId?: number }>(FOREGROUND_WINDOW_SCRIPT, {
        timeoutMs: 8000
      })
      return result.processId ? Number(result.processId) : null
    } catch {
      return null
    }
  }

  private async waitForWindow(
    processId: number | undefined,
    knownTitle: string | undefined,
    timeoutMs: number
  ): Promise<RawWindow | null> {
    if (!processId) return null
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      try {
        const windows = await this.listOpenWindows()
        const match = windows.find((w) => w.processId === processId && w.title.trim().length > 0)
        if (match) return match
      } catch {
        /* transient: keep polling until the deadline */
      }
      await sleep(700)
    }
    return knownTitle ? { processId, windowHandle: '', title: knownTitle, isForeground: false } : null
  }

  private assertWindows(action: string): void {
    if (!this.supported) {
      throw new DesktopError(`${action} is only available on Windows.`, 'unsupported_platform')
    }
  }

  /**
   * Run a fixed PowerShell script and parse the `__ALPHA_JSON__` line it emits.
   *
   * `-NonInteractive` guarantees a hung prompt fails instead of blocking forever,
   * and the timeout is a second line of defence because a COM call can stall
   * inside the Word process itself.
   */
  async powerShell<T>(script: string, options: PowerShellOptions = {}): Promise<T> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    // UTF-16LE is what `-EncodedCommand` requires. Encoding the *script* means no
    // argument ever passes through a command line, so quoting rules cannot be
    // violated by a value in the first place.
    const encoded = Buffer.from(script, 'utf16le').toString('base64')
    // Environment values are transport only, but they still get coerced: a NUL
    // truncates the block on Windows and a multi-megabyte value fails to spawn.
    const env: NodeJS.ProcessEnv = { ...process.env }
    for (const [key, value] of Object.entries(options.env ?? {})) {
      env[key] = sanitizeEnvValue(value)
    }

    const child = execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      {
        windowsHide: true,
        env,
        maxBuffer: 8 * 1024 * 1024,
        timeout: timeoutMs,
        signal: options.signal
      }
    )
    this.children.add(child)
    child.once('exit', () => this.children.delete(child))

    return new Promise<T>((resolve, reject) => {
      let stdout = ''
      let stderr = ''
      child.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8')
      })
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8')
      })
      child.once('error', (error) => {
        this.children.delete(child)
        reject(new DesktopError(`PowerShell could not run: ${error.message}`, 'spawn_failed'))
      })
      child.once('close', (code, signal) => {
        this.children.delete(child)
        if (signal) {
          reject(new DesktopError(`PowerShell was stopped (${signal}).`, 'cancelled'))
          return
        }
        const line = stdout
          .split(/\r?\n/)
          .reverse()
          .find((l) => l.startsWith(RESULT_MARKER))
        if (!line) {
          const detail = firstLine(stderr) || firstLine(stdout) || `exit code ${code}`
          reject(new DesktopError(`The Windows action failed: ${detail}`, 'script_failed'))
          return
        }
        try {
          resolve(JSON.parse(line.slice(RESULT_MARKER.length)) as T)
        } catch (error) {
          reject(new DesktopError(`Unreadable result from PowerShell: ${(error as Error).message}`, 'bad_output'))
        }
      })
    })
  }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

interface RawWindow {
  processId?: number
  windowHandle?: string
  title?: string
  processName?: string
  x?: number
  y?: number
  width?: number
  height?: number
  isForeground?: boolean
}

interface LaunchProbe {
  found: boolean
  via?: AppLaunchResult['discoveredVia']
  processId?: number
  windowTitle?: string
  executablePath?: string
  name?: string
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}


function firstLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l && !l.startsWith('#< CLIXML')) ?? ''
  ).slice(0, 300)
}

function replaceExtension(filePath: string, extension: string): string {
  const ext = path.extname(filePath)
  return ext ? filePath.slice(0, -ext.length) + extension : filePath + extension
}

export function isProcessAlive(pid: number): boolean {
  if (!pid || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM means the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * Minimal RTF so a formatted document still exists without Office. RTF is
 * deliberately chosen over writing text into a `.docx` path: the latter produces
 * a file Word refuses to open, which would make the verification a lie.
 */
export function renderRtf(request: DocumentRequest): string {
  const escape = (text: string): string =>
    text
      .replace(/\\/g, '\\\\')
      .replace(/[{}]/g, (m) => '\\' + m)
      .replace(/[\u0080-\uFFFF]/g, (m) => `\\u${m.charCodeAt(0)}?`)
      .replace(/\n/g, '\\par ')

  const parts: string[] = []
  if (request.title) {
    parts.push(`\\pard\\qc\\b\\fs36 ${escape(request.title)}\\b0\\par\\par `)
  }
  for (const block of request.blocks) {
    if (block.type === 'title') {
      parts.push(`\\pard\\qc\\b\\fs36 ${escape(block.text ?? '')}\\b0\\par\\par `)
    } else if (block.type === 'heading') {
      const size = block.level === 2 ? 28 : block.level === 3 ? 24 : 32
      parts.push(`\\pard\\b\\fs${size} ${escape(block.text ?? '')}\\b0\\par `)
    } else if (block.type === 'bullet') {
      parts.push(`\\pard\\bullet\\tx360 \\bullet\\tab ${escape(block.text ?? '')}\\par `)
    } else if (block.type === 'table' && block.rows?.length) {
      for (const row of block.rows) {
        parts.push(`\\pard\\trowd\\cellx3000\\cellx6000 ${row.map((cell) => `\\intbl ${escape(cell)}\\cell `).join('')}\\row `)
      }
      parts.push('\\pard ')
    } else if (block.type === 'pagebreak') {
      parts.push('\\page ')
    } else if (block.text) {
      parts.push(`\\pard ${escape(block.text)}\\par `)
    }
  }
  return `{\\rtf1\\ansi\\deff0{\\fonttbl{\\f0 Calibri;}}\\f0\\fs24 ${parts.join('')}}`
}

// ---------------------------------------------------------------------------
// Fixed scripts. Data travels only through environment variables.
// ---------------------------------------------------------------------------

/**
 * Shared preamble for every script below.
 *
 * Two rules hold for all of them, and they are what make user-supplied text
 * safe here:
 *
 * 1. **No data is ever interpolated into script text.** Scripts are fixed
 *    strings, base64-encoded as UTF-16LE and passed with `-EncodedCommand`, so
 *    PowerShell never parses the values as code. User data arrives only through
 *    environment variables and is read with `$env:NAME`.
 * 2. **Values that reach a cmdlet parameter are escaped for that parameter.**
 *    The environment variable is a transport, not a filter: a name like
 *    `App [x64]` or `O'Reilly` still has to be escaped before it meets `-like`
 *    (where `[` `]` `*` `?` are wildcards) or a path parameter (where brackets
 *    are wildcards too). `Test-AlphaMatch` and `-LiteralPath` below handle that.
 */
const PS_PRELUDE = `$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
function Emit($obj) { Write-Output ('${RESULT_MARKER}' + ($obj | ConvertTo-Json -Compress -Depth 8)) }

# Escape every wildcard character so a literal comparison cannot throw
# ("The specified wildcard character pattern is not valid") or over-match.
function Get-AlphaPattern([string]$text) {
  if (-not $text) { return '*' }
  return '*' + [System.Management.Automation.WildcardPattern]::Escape($text) + '*'
}

# Case-insensitive "contains", implemented without wildcards at all. Used where
# the input is a search term rather than a pattern.
function Test-AlphaContains([string]$haystack, [string]$needle) {
  if (-not $haystack) { return $false }
  if (-not $needle) { return $true }
  return $haystack.IndexOf($needle, [System.StringComparison]::OrdinalIgnoreCase) -ge 0
}
`

const LAUNCH_APP_SCRIPT = `${PS_PRELUDE}
$q = [string]$env:ALPHA_APP_QUERY
$result = [ordered]@{ found = $false }
if (-not $q) { Emit $result; exit 0 }

# 1. Already running with a visible window.
#    Matched with Test-AlphaContains rather than -like: an app called "Bob's App"
#    or "Tool [beta]" must not be treated as a wildcard pattern.
$running = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle } |
  Where-Object { (Test-AlphaContains $_.ProcessName $q) -or (Test-AlphaContains $_.MainWindowTitle $q) } |
  Select-Object -First 1
if ($running) {
  $result.found = $true; $result.via = 'running'; $result.processId = $running.Id
  $result.windowTitle = $running.MainWindowTitle; $result.name = $running.ProcessName
  try { $result.executablePath = $running.Path } catch { }
  Emit $result
  exit 0
}

# 2. Start-menu app list (UWP and packaged apps included).
$app = $null
try { $app = Get-StartApps | Where-Object { Test-AlphaContains $_.Name $q } | Select-Object -First 1 } catch { }
if ($app) {
  $before = @(Get-Process | Select-Object -ExpandProperty Id)
  Start-Process ('shell:AppsFolder\\' + $app.AppID)
  Start-Sleep -Milliseconds 1500
  $new = Get-Process | Where-Object { $before -notcontains $_.Id -and $_.MainWindowHandle -ne 0 } | Select-Object -First 1
  $result.found = $true; $result.via = 'start-app'; $result.name = $app.Name
  if ($new) { $result.processId = $new.Id; $result.windowTitle = $new.MainWindowTitle }
  Emit $result
  exit 0
}

# 3. Start-menu and desktop shortcuts.
$dirs = @(
  "$env:ProgramData\\Microsoft\\Windows\\Start Menu\\Programs",
  "$env:APPDATA\\Microsoft\\Windows\\Start Menu\\Programs",
  "$env:USERPROFILE\\Desktop",
  "$env:PUBLIC\\Desktop"
)
$lnk = $null
foreach ($dir in $dirs) {
  if (Test-Path -LiteralPath $dir) {
    $lnk = Get-ChildItem -LiteralPath $dir -Filter *.lnk -Recurse -ErrorAction SilentlyContinue |
      Where-Object { Test-AlphaContains $_.BaseName $q } | Select-Object -First 1
    if ($lnk) { break }
  }
}
if ($lnk) {
  $shell = New-Object -ComObject WScript.Shell
  $target = $shell.CreateShortcut($lnk.FullName).TargetPath
  $p = Start-Process -FilePath $lnk.FullName -PassThru
  Start-Sleep -Milliseconds 1200
  $result.found = $true; $result.via = 'shortcut'; $result.name = $lnk.BaseName
  $result.executablePath = $target; $result.processId = $p.Id
  Emit $result
  exit 0
}

# 4. App Paths registry keys.
$regRoots = @(
  'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths',
  'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths'
)
foreach ($root in $regRoots) {
  if (-not (Test-Path -LiteralPath $root)) { continue }
  $key = Get-ChildItem -LiteralPath $root | Where-Object { Test-AlphaContains $_.PSChildName $q } | Select-Object -First 1
  if ($key) {
    $exe = (Get-ItemProperty -LiteralPath $key.PSPath).'(default)'
    # Installed paths routinely contain brackets ("App [x64]\app.exe"), which
    # Test-Path reads as a wildcard unless -LiteralPath is used.
    if ($exe -and (Test-Path -LiteralPath $exe)) {
      $p = Start-Process -FilePath $exe -PassThru
      $result.found = $true; $result.via = 'registry'; $result.name = $key.PSChildName
      $result.executablePath = $exe; $result.processId = $p.Id
      Emit $result
      exit 0
    }
  }
}

# 5. Executables on PATH. -Name keeps the value a name lookup, never a path.
$cmd = Get-Command -Name $q -CommandType Application,ExternalScript -ErrorAction SilentlyContinue |
  Select-Object -First 1
if ($cmd) {
  $p = Start-Process -FilePath $cmd.Source -PassThru
  $result.found = $true; $result.via = 'path'; $result.name = $q
  $result.executablePath = $cmd.Source; $result.processId = $p.Id
  Emit $result
  exit 0
}

Emit $result
`

const WINDOW_PRELUDE = `${PS_PRELUDE}
Add-Type -Namespace AlphaNative -Name Win -MemberDefinition @'
[DllImport("user32.dll")] public static extern System.IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern bool GetWindowRect(System.IntPtr h, out RECT r);
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(System.IntPtr h, out uint pid);
[StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
'@
`

const LIST_WINDOWS_SCRIPT = `${WINDOW_PRELUDE}
$fg = [AlphaNative.Win]::GetForegroundWindow()
$list = @()
foreach ($p in Get-Process) {
  if ($p.MainWindowHandle -eq 0 -or -not $p.MainWindowTitle) { continue }
  $rect = New-Object AlphaNative.Win+RECT
  $ok = [AlphaNative.Win]::GetWindowRect($p.MainWindowHandle, [ref]$rect)
  $item = [ordered]@{
    processId = $p.Id
    windowHandle = $p.MainWindowHandle.ToString()
    title = $p.MainWindowTitle
    processName = $p.ProcessName
    isForeground = ($p.MainWindowHandle -eq $fg)
  }
  if ($ok) {
    $item.x = $rect.Left; $item.y = $rect.Top
    $item.width = $rect.Right - $rect.Left; $item.height = $rect.Bottom - $rect.Top
  }
  $list += $item
}
Emit @{ windows = $list }
`

const FOCUS_WINDOW_SCRIPT = `${PS_PRELUDE}
Add-Type -AssemblyName Microsoft.VisualBasic
$pidTarget = [int]$env:ALPHA_TARGET_PID
try {
  [Microsoft.VisualBasic.Interaction]::AppActivate($pidTarget)
  Start-Sleep -Milliseconds 400
  Emit @{ ok = $true }
} catch {
  Emit @{ ok = $false; message = $_.Exception.Message }
}
`

const CLOSE_WINDOW_SCRIPT = `${PS_PRELUDE}
$target = [int]$env:ALPHA_TARGET_PID
$p = Get-Process -Id $target -ErrorAction SilentlyContinue
if (-not $p) { Emit @{ ok = $true }; exit 0 }
[void]$p.CloseMainWindow()
if (-not $p.WaitForExit(4000)) { try { $p.Kill() } catch { } }
Emit @{ ok = $true }
`

const FOREGROUND_WINDOW_SCRIPT = `${PS_PRELUDE}
Add-Type -Namespace AlphaNative -Name Fg -MemberDefinition @'
[DllImport("user32.dll")] public static extern System.IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(System.IntPtr h, out uint pid);
'@
$h = [AlphaNative.Fg]::GetForegroundWindow()
$pidOut = 0
[void][AlphaNative.Fg]::GetWindowThreadProcessId($h, [ref]$pidOut)
Emit @{ processId = [int]$pidOut }
`

const WORD_SCRIPT = `${PS_PRELUDE}
$spec = Get-Content -Raw -LiteralPath ([string]$env:ALPHA_DOC_JSON) | ConvertFrom-Json
try {
  $word = New-Object -ComObject Word.Application
} catch {
  Emit @{ ok = $false; message = 'Microsoft Word is not available.' }
  exit 0
}
try {
  $word.Visible = $true
  $doc = $word.Documents.Add()
  $sel = $word.Selection
  if ($spec.title) {
    $sel.ParagraphFormat.Alignment = 1
    $sel.Style = 'Title'
    $sel.TypeText([string]$spec.title)
    $sel.TypeParagraph()
    $sel.ParagraphFormat.Alignment = 0
  }
  foreach ($b in $spec.blocks) {
    switch ($b.type) {
      'title' {
        $sel.Style = 'Title'; $sel.ParagraphFormat.Alignment = 1
        $sel.TypeText([string]$b.text); $sel.TypeParagraph(); $sel.ParagraphFormat.Alignment = 0
      }
      'heading' {
        $level = 1
        if ($b.level) { $level = [int]$b.level }
        $sel.Style = "Heading $level"
        $sel.TypeText([string]$b.text); $sel.TypeParagraph()
      }
      'bullet' {
        $sel.Style = 'List Bullet'
        $sel.TypeText([string]$b.text); $sel.TypeParagraph()
      }
      'pagebreak' { $sel.InsertBreak(7) }
      'table' {
        if ($b.rows.Count -gt 0) {
          $rowCount = $b.rows.Count
          $colCount = 1
          if ($b.rows[0].Count -gt 0) { $colCount = $b.rows[0].Count }
          $range = $sel.Range
          $table = $doc.Tables.Add($range, $rowCount, $colCount)
          $table.Borders.Enable = 1
          for ($r = 0; $r -lt $rowCount; $r++) {
            for ($c = 0; $c -lt $colCount; $c++) {
              $table.Cell($r + 1, $c + 1).Range.Text = [string]$b.rows[$r][$c]
            }
          }
          $sel.EndKey(6) | Out-Null
          $sel.TypeParagraph()
        }
      }
      default {
        $sel.Style = 'Normal'
        $sel.TypeText([string]$b.text); $sel.TypeParagraph()
      }
    }
  }
  $doc.SaveAs2([string]$spec.path, 16)
  $saved = $doc.Saved
  Emit @{ ok = $true; engine = 'word-com'; saved = $saved; path = [string]$spec.path }
} catch {
  try { if ($doc) { $doc.Close(0) } } catch { }
  Emit @{ ok = $false; message = $_.Exception.Message }
}
`

const EXCEL_SCRIPT = `${PS_PRELUDE}
$spec = Get-Content -Raw -LiteralPath ([string]$env:ALPHA_DOC_JSON) | ConvertFrom-Json
try {
  $excel = New-Object -ComObject Excel.Application
} catch {
  Emit @{ ok = $false; message = 'Microsoft Excel is not available.' }
  exit 0
}
try {
  $excel.Visible = $true
  $excel.DisplayAlerts = $false
  $book = $excel.Workbooks.Add()
  $sheets = @($spec.sheets)
  if ($sheets.Count -eq 0) {
    $sheets = @([pscustomobject]@{ name = 'Sheet1'; rows = @() })
  }
  $index = 1
  foreach ($s in $sheets) {
    if ($index -eq 1) { $sheet = $book.Worksheets.Item(1) } else { $sheet = $book.Worksheets.Add([System.Reflection.Missing]::Value, $book.Worksheets.Item($book.Worksheets.Count)) }
    if ($s.name) { $sheet.Name = [string]$s.name }
    $r = 1
    foreach ($row in $s.rows) {
      $c = 1
      foreach ($cell in $row) {
        $sheet.Cells.Item($r, $c).Value2 = [string]$cell
        $c++
      }
      $r++
    }
    if ($r -gt 1) {
      $sheet.Rows.Item(1).Font.Bold = $true
      $sheet.Columns.AutoFit() | Out-Null
    }
    $index++
  }
  $book.SaveAs([string]$spec.path, 51)
  Emit @{ ok = $true; engine = 'excel-com'; path = [string]$spec.path }
} catch {
  Emit @{ ok = $false; message = $_.Exception.Message }
}
`
