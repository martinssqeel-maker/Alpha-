import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { BrowserWindow, desktopCapturer } from 'electron'
import type {
  DesktopWindowInfo,
  ScreenshotResult,
  ToolVerification,
  WindowElement,
  WindowInspection
} from '@shared/types'
import { redactSensitiveText } from '@shared/redactSensitive'
import { clampElementId, normalizeKeys } from './desktopInput'
import { getLogger } from './logger'
import { DesktopError, type DesktopService } from './desktopService'

/**
 * Windows UI automation, the clipboard bridge and screen vision.
 *
 * ## The reliability hierarchy
 *
 * The agent tries these in order and only descends when the level above cannot
 * express the action:
 *
 *  1. Native CLI / file API / COM  — no UI involved at all.
 *  2. UI Automation patterns       — cursor-free: `Invoke()` on a button and
 *     `SetValue()` on an edit box work even while the user is typing elsewhere,
 *     and they do not move the mouse.
 *  3. Focus + clipboard + keys     — for apps that only accept typed input.
 *  4. Simulated mouse              — last resort for canvas-drawn UIs (Godot,
 *     games, custom renderers) where UIA can see nothing but a pane.
 *
 * Levels 2–4 all require target identification, so `inspectWindow` first builds
 * a numbered map (`[1] Button "Save"`). Models are far better at "click element
 * 3" than at emitting coordinates, and the numbering gives the same reference to
 * the text model and to a vision model looking at an annotated screenshot.
 */

export type ElementAction =
  | 'invoke'
  | 'click'
  | 'setValue'
  | 'type'
  | 'focus'
  | 'toggle'
  | 'select'
  | 'expand'
  | 'collapse'
  | 'read'

export interface InteractResult {
  ok: boolean
  element?: WindowElement
  usedPattern?: string
  fellBackToMouse?: boolean
  message?: string
  verification: ToolVerification
}

const MAX_ELEMENTS = 150
const SCREENSHOT_MAX_WIDTH = 1600

export class ComputerUseService {
  constructor(
    private readonly desktop: DesktopService,
    private readonly options: { allowMouseFallback: () => boolean; screenshotsDir: () => string }
  ) {}

  get supported(): boolean {
    return this.desktop.supported
  }

  killAll(): void {
    this.desktop.killAll()
  }

  // -------------------------------------------------------------------------
  // Level 2: UI Automation
  // -------------------------------------------------------------------------

  /**
   * Walk a window's interactive UIA tree and number the results.
   *
   * The order is the same every time (breadth-first over the Control View), which
   * is what makes "element 4" stable between the inspect and the interaction
   * call in a later turn.
   */
  async inspectWindow(target: string | number): Promise<WindowInspection> {
    this.assertWindows('Inspecting windows')
    const window = await this.resolveWindow(target)
    if (!window) {
      return {
        ok: false,
        windowTitle: '',
        processId: 0,
        elements: [],
        totalElements: 0,
        truncated: false,
        message: `No open window matched "${String(target)}". Ask for a window title or list the open windows first.`
      }
    }
    const handle = this.windowHandleFor(window)
    if (!handle) {
      return {
        ok: false,
        windowTitle: window.title,
        processId: window.processId,
        elements: [],
        totalElements: 0,
        truncated: false,
        message: 'The window has no native handle; it may be a suspended packaged app.'
      }
    }

    try {
      const result = await this.desktop.powerShell<{ ok: boolean; elements?: WindowElement[]; total?: number; message?: string }>(
        INSPECT_SCRIPT,
        { env: { ALPHA_WINDOW_HANDLE: String(handle), ALPHA_MAX_ELEMENTS: String(MAX_ELEMENTS) }, timeoutMs: 30_000 }
      )
      const elements = (result.elements ?? []).map((element, index) => ({
        ...element,
        id: index + 1,
        name: String(element.name ?? '').slice(0, 200),
        patterns: Array.isArray(element.patterns) ? element.patterns : []
      }))
      return {
        ok: Boolean(result.ok),
        windowTitle: window.title,
        processId: window.processId,
        windowHandle: String(handle),
        elements,
        totalElements: result.total ?? elements.length,
        truncated: (result.total ?? elements.length) > elements.length,
        message: result.message
      }
    } catch (error) {
      return {
        ok: false,
        windowTitle: window.title,
        processId: window.processId,
        windowHandle: String(handle),
        elements: [],
        totalElements: 0,
        truncated: false,
        message: (error as Error).message
      }
    }
  }

  /**
   * Act on a numbered element, preferring a cursor-free UIA pattern.
   *
   * When the control exposes no usable pattern (a canvas, a custom renderer) and
   * mouse fallback is allowed, this focuses the window and clicks the element's
   * centre. The result says which route was taken so the activity log is honest
   * about what happened to the user's pointer.
   */
  async interact(
    target: string | number,
    elementId: number,
    action: ElementAction,
    value?: string
  ): Promise<InteractResult> {
    this.assertWindows('Controlling windows')
    const window = await this.resolveWindow(target)
    if (!window) {
      return {
        ok: false,
        message: `No open window matched "${String(target)}".`,
        verification: { verified: false, note: 'Target window not found.', check: 'window' }
      }
    }
    const handle = this.windowHandleFor(window)
    if (!handle) {
      return {
        ok: false,
        message: 'The window has no native handle.',
        verification: { verified: false, note: 'No window handle.', check: 'window' }
      }
    }

    let result: {
      ok: boolean
      pattern?: string
      element?: WindowElement
      needsMouse?: boolean
      valueAfter?: string
      message?: string
    }
    try {
      result = await this.desktop.powerShell(INTERACT_SCRIPT, {
        env: {
          ALPHA_WINDOW_HANDLE: String(handle),
          ALPHA_ELEMENT_INDEX: String(clampElementId(elementId, MAX_ELEMENTS)),
          ALPHA_ACTION: action,
          ALPHA_VALUE: value ?? '',
          ALPHA_MAX_ELEMENTS: String(MAX_ELEMENTS)
        },
        timeoutMs: 30_000
      })
    } catch (error) {
      return {
        ok: false,
        message: (error as Error).message,
        verification: { verified: false, note: (error as Error).message, check: 'uia' }
      }
    }

    if (result.ok) {
      const element = result.element ? { ...result.element, id: elementId } : undefined
      // A pattern that returns is not proof by itself for value changes: confirm
      // the control actually holds the text we asked for.
      const verified =
        action === 'read' || action === 'focus'
          ? Boolean(result.ok)
          : result.valueAfter === undefined
            ? Boolean(result.ok)
            : result.valueAfter === (value ?? '')
      return {
        ok: true,
        element,
        usedPattern: result.pattern,
        verification: {
          verified,
          note: verified
            ? `UIA ${result.pattern ?? action} succeeded on element ${elementId}${element?.name ? ` ("${element.name}")` : ''}.`
            : `UIA ${result.pattern ?? action} ran but element ${elementId} holds "${result.valueAfter ?? ''}" instead of the requested value.`,
          check: 'uia'
        }
      }
    }

    // No pattern: fall back to a real click, if the user allows it.
    if ((result.needsMouse || !result.pattern) && this.options.allowMouseFallback()) {
      const clicked = await this.clickElementCenter(handle, window, clampElementId(elementId, MAX_ELEMENTS))
      return {
        ok: clicked.ok,
        element: result.element ? { ...result.element, id: elementId } : undefined,
        fellBackToMouse: clicked.ok,
        message: clicked.ok
          ? 'The control exposes no UI Automation pattern, so the agent clicked its centre coordinates.'
          : clicked.message,
        verification: {
          verified: clicked.ok,
          note: clicked.ok
            ? `Clicked the centre of element ${elementId}; the control has no invokable pattern, so success is inferred from focus.`
            : clicked.message ?? 'Mouse fallback failed.',
          check: 'mouse'
        }
      }
    }

    return {
      ok: false,
      element: result.element ? { ...result.element, id: elementId } : undefined,
      message:
        result.message ??
        `Element ${elementId} exposes no pattern for "${action}". Re-inspect the window; the numbers may have shifted.`,
      verification: {
        verified: false,
        note: result.message ?? `No UIA pattern available for ${action} on element ${elementId}.`,
        check: 'uia'
      }
    }
  }

  // -------------------------------------------------------------------------
  // Level 3: clipboard
  // -------------------------------------------------------------------------

  /**
   * Move text through the clipboard without destroying what the user had.
   *
   * `paste_text` snapshots the current clipboard, sets ours, activates the target
   * window, sends Ctrl+V, then restores the snapshot on a short delay — long
   * enough for the target to consume it. Reading sanitises via
   * `redactSensitive` because a clipboard routinely holds tokens and passwords.
   */
  async clipboardBridge(input: {
    action: 'read' | 'write' | 'paste_text'
    text?: string
    targetWindow?: string | number
    keys?: string
  }): Promise<{ ok: boolean; text?: string; message?: string; verification: ToolVerification }> {
    this.assertWindows('Using the clipboard')

    if (input.action === 'read') {
      try {
        const result = await this.desktop.powerShell<{ text?: string }>(READ_CLIPBOARD_SCRIPT, {
          timeoutMs: 10_000
        })
        const raw = result.text ?? ''
        return {
          ok: true,
          text: redactSensitiveText(raw).slice(0, 8000),
          verification: {
            verified: true,
            note: `Read ${raw.length} characters from the clipboard (secrets redacted).`,
            check: 'clipboard'
          }
        }
      } catch (error) {
        return {
          ok: false,
          message: (error as Error).message,
          verification: { verified: false, note: (error as Error).message, check: 'clipboard' }
        }
      }
    }

    const text = input.text ?? ''
    if (!text) {
      return {
        ok: false,
        message: 'No text was supplied for the clipboard.',
        verification: { verified: false, note: 'Empty text.', check: 'input' }
      }
    }

    // 1. Back up the user's clipboard so we can put it back.
    let backup: string | null = null
    try {
      const previous = await this.desktop.powerShell<{ text?: string }>(READ_CLIPBOARD_SCRIPT, {
        timeoutMs: 8000
      })
      backup = previous.text ?? null
    } catch {
      backup = null
    }

    try {
      await this.setClipboard(text)

      if (input.action === 'write') {
        return {
          ok: true,
          verification: {
            verified: true,
            note: `Wrote ${text.length} characters to the clipboard (previous contents kept in memory for restore).`,
            check: 'clipboard'
          }
        }
      }

      // 2. paste_text: focus the target, then synthesise the keystroke.
      if (input.targetWindow === undefined) {
        return {
          ok: false,
          message: 'paste_text needs a targetWindow so the text lands somewhere.',
          verification: { verified: false, note: 'No target window.', check: 'input' }
        }
      }
      const window = await this.resolveWindow(input.targetWindow)
      if (!window) {
        return {
          ok: false,
          message: `No open window matched "${String(input.targetWindow)}".`,
          verification: { verified: false, note: 'Target window not found.', check: 'window' }
        }
      }
      const handle = this.windowHandleFor(window)
      if (!handle) {
        return {
          ok: false,
          message: 'The target window has no native handle.',
          verification: { verified: false, note: 'No window handle.', check: 'window' }
        }
      }

      await this.desktop.powerShell(PASTE_SCRIPT, {
        env: {
          ALPHA_WINDOW_HANDLE: String(handle),
          ALPHA_KEYS: normalizeKeys(input.keys ?? '^v'),
          ALPHA_TARGET_PID: String(window.processId)
        },
        timeoutMs: 20_000
      })

      // 3. Give the target a moment to consume the clipboard, then restore.
      await sleep(900)
      if (backup !== null) {
        try {
          await this.setClipboard(backup)
        } catch {
          getLogger().warn('computer', 'clipboard restore failed; user clipboard now holds pasted text')
        }
      }

      const foreground = await this.desktop.powerShell<{ processId?: number }>(FOREGROUND_SCRIPT, {
        timeoutMs: 8000
      })
      const verified = Number(foreground.processId) === window.processId
      return {
        ok: true,
        verification: {
          verified,
          note: verified
            ? `Sent the paste keystroke to "${window.title}" (foreground confirmed) and restored the previous clipboard.`
            : `The paste keystroke was sent, but "${window.title}" was not confirmed as the foreground window. The text may have gone elsewhere.`,
          check: 'foreground-window'
        }
      }
    } catch (error) {
      return {
        ok: false,
        message: (error as Error).message,
        verification: { verified: false, note: (error as Error).message, check: 'clipboard' }
      }
    }
  }

  // -------------------------------------------------------------------------
  // Level 4 + vision
  // -------------------------------------------------------------------------

  /**
   * Put text on the clipboard via a temp file.
   *
   * A document-sized paste is hundreds of kilobytes; an environment variable
   * cannot carry that, and passing it as an argument would mean quoting it. The
   * file is the transport, `-LiteralPath` is the read, and the value is deleted
   * in `finally` even when PowerShell fails.
   */
  private async setClipboard(text: string): Promise<void> {
    const file = path.join(os.tmpdir(), `alpha-clip-${process.pid}-${Date.now()}.txt`)
    fs.writeFileSync(file, text, 'utf8')
    try {
      await this.desktop.powerShell(SET_CLIPBOARD_SCRIPT, {
        env: { ALPHA_CLIP_FILE: file },
        timeoutMs: 20_000
      })
    } finally {
      try {
        fs.rmSync(file, { force: true })
      } catch {
        /* temp file only */
      }
    }
  }

  /** Click the centre of an element, or raw coordinates when the caller has them. */
  async clickCoordinates(
    target: string | number,
    point: { x: number; y: number }
  ): Promise<{ ok: boolean; message?: string; verification: ToolVerification }> {
    this.assertWindows('Clicking')
    const window = await this.resolveWindow(target)
    if (!window) {
      return {
        ok: false,
        message: `No open window matched "${String(target)}".`,
        verification: { verified: false, note: 'Target window not found.', check: 'window' }
      }
    }
    if (!this.options.allowMouseFallback()) {
      return {
        ok: false,
        message: 'Mouse control is disabled in Settings → Agent.',
        verification: { verified: false, note: 'Mouse fallback is turned off by the user.', check: 'policy' }
      }
    }
    const handle = this.windowHandleFor(window)
    if (!handle) {
      return {
        ok: false,
        message: 'The window has no native handle.',
        verification: { verified: false, note: 'No window handle.', check: 'window' }
      }
    }
    try {
      await this.desktop.powerShell(CLICK_SCRIPT, {
        env: {
          ALPHA_WINDOW_HANDLE: String(handle),
          ALPHA_TARGET_PID: String(window.processId),
          ALPHA_CLICK_X: String(Math.round(point.x)),
          ALPHA_CLICK_Y: String(Math.round(point.y))
        },
        timeoutMs: 20_000
      })
      return {
        ok: true,
        verification: {
          verified: true,
          note: `Clicked (${Math.round(point.x)}, ${Math.round(point.y)}) inside "${window.title}".`,
          check: 'mouse'
        }
      }
    } catch (error) {
      return {
        ok: false,
        message: (error as Error).message,
        verification: { verified: false, note: (error as Error).message, check: 'mouse' }
      }
    }
  }

  /**
   * Capture a window (or the screen) to PNG.
   *
   * With `annotate`, the numbered element map is composited onto the image using
   * an offscreen renderer, so a vision model sees `[3]` over the control the text
   * model called element 3. That shared numbering is what lets the two halves of
   * the agent agree without a second description pass.
   */
  async captureScreenshot(input: {
    target?: string | number
    annotate?: boolean
    screen?: boolean
  }): Promise<ScreenshotResult> {
    this.assertWindows('Capturing the screen')
    let window: DesktopWindowInfo | null = null
    let handle: string | null = null
    if (!input.screen) {
      if (input.target === undefined) {
        return { ok: false, message: 'Name a window to capture, or set screen: true.' }
      }
      window = await this.resolveWindow(input.target)
      if (!window) return { ok: false, message: `No open window matched "${String(input.target)}".` }
      handle = this.windowHandleFor(window)
    }

    const sources = await desktopCapturer.getSources({
      types: input.screen ? ['screen'] : ['window'],
      thumbnailSize: { width: SCREENSHOT_MAX_WIDTH, height: SCREENSHOT_MAX_WIDTH }
    })
    if (!sources.length) {
      return { ok: false, message: 'No capturable source was returned by Windows.' }
    }

    // Electron window sources are `window:<hwnd>:<n>` on Windows, so the handle
    // identifies the exact window even when two share a title.
    const source = input.screen
      ? sources[0]
      : sources.find((s) => handle && s.id.includes(`window:${handle}:`)) ??
        sources.find((s) => window && s.name && s.name.includes(window.title.slice(0, 40)))

    if (!source) {
      return {
        ok: false,
        message: `Windows did not expose a capturable surface for "${window?.title ?? 'that window'}". It may be minimised or hardware-accelerated into a surface Electron cannot read.`
      }
    }

    let image = source.thumbnail
    if (image.isEmpty()) {
      return { ok: false, message: 'The capture came back empty. Restore the window and try again.' }
    }

    const elements = input.annotate && window ? (await this.inspectWindow(window.processId)).elements : []
    if (input.annotate && elements.length) {
      image = await this.annotate(image, elements).catch((error) => {
        getLogger().warn('computer', `annotation failed: ${(error as Error).message}`)
        return image
      })
    }

    const directory = this.options.screenshotsDir()
    fs.mkdirSync(directory, { recursive: true })
    const filePath = path.join(directory, `shot-${Date.now()}.png`)
    fs.writeFileSync(filePath, image.toPNG())

    const size = image.getSize()
    return {
      ok: true,
      path: filePath,
      width: size.width,
      height: size.height,
      annotated: Boolean(input.annotate && elements.length)
    }
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private async clickElementCenter(
    handle: string | number,
    window: DesktopWindowInfo,
    elementId: number
  ): Promise<{ ok: boolean; message?: string }> {
    try {
      const result = await this.desktop.powerShell<{ ok: boolean; x?: number; y?: number; message?: string }>(
        ELEMENT_CENTER_SCRIPT,
        {
          env: {
            ALPHA_WINDOW_HANDLE: String(handle),
            ALPHA_ELEMENT_INDEX: String(elementId),
            ALPHA_MAX_ELEMENTS: String(MAX_ELEMENTS),
            ALPHA_TARGET_PID: String(window.processId)
          },
          timeoutMs: 25_000
        }
      )
      if (!result.ok || result.x === undefined || result.y === undefined) {
        return { ok: false, message: result.message ?? 'The element has no on-screen bounds.' }
      }
      await this.desktop.powerShell(CLICK_SCRIPT, {
        env: {
          ALPHA_WINDOW_HANDLE: String(handle),
          ALPHA_TARGET_PID: String(window.processId),
          ALPHA_CLICK_X: String(Math.round(result.x)),
          ALPHA_CLICK_Y: String(Math.round(result.y))
        },
        timeoutMs: 20_000
      })
      return { ok: true }
    } catch (error) {
      return { ok: false, message: (error as Error).message }
    }
  }

  private async resolveWindow(target: string | number): Promise<DesktopWindowInfo | null> {
    const windows = await this.desktop.listOpenWindows()
    if (typeof target === 'number') return windows.find((w) => w.processId === target) ?? null
    const probe = String(target).trim().toLowerCase()
    if (!probe) return null
    return (
      windows.find((w) => w.title.toLowerCase() === probe) ??
      windows.find((w) => w.title.toLowerCase().startsWith(probe)) ??
      windows.find((w) => w.title.toLowerCase().includes(probe)) ??
      null
    )
  }

  private windowHandleFor(window: DesktopWindowInfo): string | null {
    return window.windowHandle && window.windowHandle !== '0' ? window.windowHandle : null
  }

  /**
   * Draw the element map onto the screenshot with an offscreen renderer.
   *
   * An HTML canvas is used rather than pixel manipulation because labels are
   * text: compositing them by hand would need a font rasteriser the project
   * deliberately does not depend on.
   */
  private async annotate(image: Electron.NativeImage, elements: WindowElement[]): Promise<Electron.NativeImage> {
    const size = image.getSize()
    if (!size.width || !size.height) return image
    const boxes = elements
      .filter((element) => element.bounds && element.bounds.width > 0 && element.bounds.height > 0)
      .slice(0, 60)
    if (!boxes.length) return image

    const html = buildAnnotatedHtml(image.toDataURL(), size.width, size.height, boxes)
    const directory = this.options.screenshotsDir()
    fs.mkdirSync(directory, { recursive: true })
    const htmlPath = path.join(directory, `annotate-${process.pid}-${Date.now()}.html`)
    fs.writeFileSync(htmlPath, html, 'utf8')

    const win = new BrowserWindow({
      width: size.width,
      height: size.height,
      show: false,
      frame: false,
      transparent: true,
      webPreferences: { offscreen: true, sandbox: true, contextIsolation: true }
    })
    try {
      await win.loadFile(htmlPath)
      await sleep(180)
      const captured = await win.webContents.capturePage()
      return captured.isEmpty() ? image : captured
    } finally {
      try {
        win.destroy()
      } catch {
        /* already gone */
      }
      try {
        fs.rmSync(htmlPath, { force: true })
      } catch {
        /* temp file only */
      }
    }
  }

  private assertWindows(action: string): void {
    if (!this.supported) throw new DesktopError(`${action} is only available on Windows.`, 'unsupported_platform')
  }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}



function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** Build the overlay document: the screenshot plus numbered boxes and a legend. */
function buildAnnotatedHtml(
  dataUrl: string,
  width: number,
  height: number,
  elements: WindowElement[]
): string {
  const boxes = elements
    .map((element) => {
      const b = element.bounds!
      const label = `[${element.id}]`
      return `<div class="box" style="left:${b.x}px;top:${b.y}px;width:${b.width}px;height:${b.height}px">
        <span class="tag">${label}</span>
      </div>`
    })
    .join('')
  const legend = elements
    .slice(0, 60)
    .map((element) => `[${element.id}] ${escapeHtml(element.controlType)} "${escapeHtml(element.name)}"`)
    .join(' · ')
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  * { box-sizing: border-box; }
  body { margin:0; width:${width}px; height:${height}px; background:#000; font-family:Segoe UI, sans-serif; }
  img { position:absolute; inset:0; width:${width}px; height:${height}px; }
  .box { position:absolute; border:2px solid #ff3b30; background:rgba(255,59,48,0.10); }
  .tag { position:absolute; top:-1px; left:-1px; background:#ff3b30; color:#fff; font-size:11px;
         font-weight:700; padding:0 3px; line-height:14px; }
  .legend { position:absolute; left:0; right:0; bottom:0; background:rgba(0,0,0,0.72); color:#fff;
            font-size:11px; line-height:1.35; padding:6px 8px; max-height:22%; overflow:hidden; }
  </style></head><body>
  <img src="${dataUrl}">
  ${boxes}
  <div class="legend">${escapeHtml(legend)}</div>
  </body></html>`
}


// ---------------------------------------------------------------------------
// Fixed scripts. Data arrives through environment variables only.
// ---------------------------------------------------------------------------

const RESULT_MARKER = '__ALPHA_JSON__'

const UIA_PRELUDE = `$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
function Emit($obj) { Write-Output ('${RESULT_MARKER}' + ($obj | ConvertTo-Json -Compress -Depth 8)) }
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -Namespace AlphaNative -Name Win -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(System.IntPtr h);
[DllImport("user32.dll")] public static extern bool ShowWindow(System.IntPtr h, int c);
[DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
[DllImport("user32.dll")] public static extern void mouse_event(uint f, uint x, uint y, uint d, System.UIntPtr e);
'@

# The walk must be identical in every script so element numbers stay stable.
function Get-AlphaElements([IntPtr]$handle, [int]$limit) {
  $root = [System.Windows.Automation.AutomationElement]::FromHandle($handle)
  if (-not $root) { return @() }
  $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
  $queue = New-Object System.Collections.Queue
  $queue.Enqueue($root)
  $out = @()
  $visited = 0
  while ($queue.Count -gt 0 -and $out.Count -lt $limit -and $visited -lt 4000) {
    $node = $queue.Dequeue()
    $visited++
    $child = $walker.GetFirstChild($node)
    while ($child -ne $null) {
      $queue.Enqueue($child)
      $child = $walker.GetNextSibling($child)
    }
    if ($node -eq $root) { continue }
    $type = $node.Current.ControlType.ProgrammaticName -replace 'ControlType\\.', ''
    $interactive = @('Button','Edit','MenuItem','Document','ComboBox','CheckBox','RadioButton','TabItem',
                     'Hyperlink','ListItem','Slider','Spinner','TreeItem','Text','SplitButton','ToolBar','Pane')
    if ($interactive -notcontains $type) { continue }
    $rect = $node.Current.BoundingRectangle
    if ($rect.Width -le 0 -or $rect.Height -le 0) { continue }
    $patterns = @()
    foreach ($pair in @(
      @('Invoke', [System.Windows.Automation.InvokePattern]::Pattern),
      @('Value', [System.Windows.Automation.ValuePattern]::Pattern),
      @('Toggle', [System.Windows.Automation.TogglePattern]::Pattern),
      @('SelectionItem', [System.Windows.Automation.SelectionItemPattern]::Pattern),
      @('ExpandCollapse', [System.Windows.Automation.ExpandCollapsePattern]::Pattern),
      @('ScrollItem', [System.Windows.Automation.ScrollItemPattern]::Pattern)
    )) {
      $obj = $null
      if ($node.TryGetCurrentPattern($pair[1], [ref]$obj)) { $patterns += $pair[0] }
    }
    $value = $null
    if ($patterns -contains 'Value') {
      try {
        $vp = $node.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
        $value = [string]$vp.Current.Value
        if ($value.Length -gt 300) { $value = $value.Substring(0, 300) }
      } catch { }
    }
    $out += [ordered]@{
      controlType = $type
      name = [string]$node.Current.Name
      automationId = [string]$node.Current.AutomationId
      className = [string]$node.Current.ClassName
      value = $value
      enabled = [bool]$node.Current.IsEnabled
      bounds = [ordered]@{ x = [int]$rect.X; y = [int]$rect.Y; width = [int]$rect.Width; height = [int]$rect.Height }
      patterns = $patterns
    }
  }
  return $out
}
`

const INSPECT_SCRIPT = `${UIA_PRELUDE}
$handle = [IntPtr][int64]$env:ALPHA_WINDOW_HANDLE
$limit = [int]$env:ALPHA_MAX_ELEMENTS
try {
  $elements = @(Get-AlphaElements $handle $limit)
  Emit @{ ok = $true; elements = $elements; total = $elements.Count }
} catch {
  Emit @{ ok = $false; message = $_.Exception.Message; elements = @() }
}
`

const INTERACT_SCRIPT = `${UIA_PRELUDE}
$handle = [IntPtr][int64]$env:ALPHA_WINDOW_HANDLE
$limit = [int]$env:ALPHA_MAX_ELEMENTS
$index = [int]$env:ALPHA_ELEMENT_INDEX
$action = $env:ALPHA_ACTION
$value = $env:ALPHA_VALUE
try {
  $elements = @(Get-AlphaElements $handle $limit)
  if ($index -lt 1 -or $index -gt $elements.Count) {
    Emit @{ ok = $false; message = "Element $index is out of range (1..$($elements.Count))." }
    exit 0
  }
  $meta = $elements[$index - 1]

  # Re-walk and grab the live AutomationElement at the same position.
  $root = [System.Windows.Automation.AutomationElement]::FromHandle($handle)
  $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
  $queue = New-Object System.Collections.Queue
  $queue.Enqueue($root)
  $matched = $null
  $count = 0
  $visited = 0
  while ($queue.Count -gt 0 -and $count -lt $limit -and $visited -lt 4000) {
    $node = $queue.Dequeue()
    $visited++
    $child = $walker.GetFirstChild($node)
    while ($child -ne $null) { $queue.Enqueue($child); $child = $walker.GetNextSibling($child) }
    if ($node -eq $root) { continue }
    $type = $node.Current.ControlType.ProgrammaticName -replace 'ControlType\\.', ''
    $interactive = @('Button','Edit','MenuItem','Document','ComboBox','CheckBox','RadioButton','TabItem',
                     'Hyperlink','ListItem','Slider','Spinner','TreeItem','Text','SplitButton','ToolBar','Pane')
    if ($interactive -notcontains $type) { continue }
    $rect = $node.Current.BoundingRectangle
    if ($rect.Width -le 0 -or $rect.Height -le 0) { continue }
    $count++
    if ($count -eq $index) { $matched = $node; break }
  }
  if (-not $matched) {
    Emit @{ ok = $false; message = 'The window changed since it was inspected. Inspect it again.'; element = $meta }
    exit 0
  }

  [void][AlphaNative.Win]::SetForegroundWindow($handle)
  Start-Sleep -Milliseconds 120

  $used = $null
  switch ($action) {
    'invoke' { $p = $null; if ($matched.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$p)) { $p.Invoke(); $used = 'Invoke' } }
    'click'  { $p = $null; if ($matched.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$p)) { $p.Invoke(); $used = 'Invoke' }
               elseif ($matched.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$p)) { $p.Select(); $used = 'SelectionItem' } }
    'setValue' { $p = $null; if ($matched.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$p)) { $p.SetValue([string]$value); $used = 'Value' } }
    'type'   { $p = $null; if ($matched.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$p)) { $p.SetValue([string]$value); $used = 'Value' } }
    'focus'  { $matched.SetFocus(); $used = 'Focus' }
    'toggle' { $p = $null; if ($matched.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$p)) { $p.Toggle(); $used = 'Toggle' } }
    'select' { $p = $null; if ($matched.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$p)) { $p.Select(); $used = 'SelectionItem' } }
    'expand' { $p = $null; if ($matched.TryGetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern, [ref]$p)) { $p.Expand(); $used = 'ExpandCollapse' } }
    'collapse' { $p = $null; if ($matched.TryGetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern, [ref]$p)) { $p.Collapse(); $used = 'ExpandCollapse' } }
    'read'   { $used = 'Read' }
  }

  if (-not $used) {
    Emit @{ ok = $false; needsMouse = $true; element = $meta; message = "No UI Automation pattern supports $action on this control." }
    exit 0
  }

  Start-Sleep -Milliseconds 220
  $valueAfter = $null
  try {
    $vp = $null
    if ($matched.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$vp)) {
      $valueAfter = [string]$vp.Current.Value
    }
  } catch { }

  Emit @{ ok = $true; pattern = $used; element = $meta; valueAfter = $valueAfter }
} catch {
  Emit @{ ok = $false; message = $_.Exception.Message }
}
`

const ELEMENT_CENTER_SCRIPT = `${UIA_PRELUDE}
$handle = [IntPtr][int64]$env:ALPHA_WINDOW_HANDLE
$limit = [int]$env:ALPHA_MAX_ELEMENTS
$index = [int]$env:ALPHA_ELEMENT_INDEX
try {
  $elements = @(Get-AlphaElements $handle $limit)
  if ($index -lt 1 -or $index -gt $elements.Count) {
    Emit @{ ok = $false; message = "Element $index is out of range." }
    exit 0
  }
  $b = $elements[$index - 1].bounds
  Emit @{ ok = $true; x = [int]($b.x + $b.width / 2); y = [int]($b.y + $b.height / 2) }
} catch {
  Emit @{ ok = $false; message = $_.Exception.Message }
}
`

const CLICK_SCRIPT = `${UIA_PRELUDE}
$handle = [IntPtr][int64]$env:ALPHA_WINDOW_HANDLE
$x = [int]$env:ALPHA_CLICK_X
$y = [int]$env:ALPHA_CLICK_Y
try {
  [void][AlphaNative.Win]::ShowWindow($handle, 9)
  [void][AlphaNative.Win]::SetForegroundWindow($handle)
  Start-Sleep -Milliseconds 200
  [void][AlphaNative.Win]::SetCursorPos($x, $y)
  Start-Sleep -Milliseconds 80
  [AlphaNative.Win]::mouse_event(0x0002, 0, 0, 0, [System.UIntPtr]::Zero)
  [AlphaNative.Win]::mouse_event(0x0004, 0, 0, 0, [System.UIntPtr]::Zero)
  Emit @{ ok = $true }
} catch {
  Emit @{ ok = $false; message = $_.Exception.Message }
}
`

const CLIPBOARD_PRELUDE = `$ErrorActionPreference = 'Stop'
function Emit($obj) { Write-Output ('${RESULT_MARKER}' + ($obj | ConvertTo-Json -Compress -Depth 6)) }
`

const READ_CLIPBOARD_SCRIPT = `${CLIPBOARD_PRELUDE}
try {
  $text = Get-Clipboard -Raw -Format Text -ErrorAction SilentlyContinue
  if ($null -eq $text) { $text = '' }
  Emit @{ ok = $true; text = [string]$text }
} catch {
  Emit @{ ok = $false; text = ''; message = $_.Exception.Message }
}
`

const SET_CLIPBOARD_SCRIPT = `${CLIPBOARD_PRELUDE}
try {
  $file = [string]$env:ALPHA_CLIP_FILE
  if (-not $file) { Emit @{ ok = $false; message = 'No clipboard payload was provided.' }; exit 0 }
  # -LiteralPath: a temp path can legitimately contain brackets.
  $text = Get-Content -Raw -LiteralPath $file -Encoding UTF8
  if ($null -eq $text) { $text = '' }
  Set-Clipboard -Value $text
  Emit @{ ok = $true }
} catch {
  Emit @{ ok = $false; message = $_.Exception.Message }
}
`

const PASTE_SCRIPT = `${UIA_PRELUDE}
Add-Type -AssemblyName Microsoft.VisualBasic
Add-Type -AssemblyName System.Windows.Forms
$handle = [IntPtr][int64]$env:ALPHA_WINDOW_HANDLE
$targetPid = [int]$env:ALPHA_TARGET_PID
$keys = $env:ALPHA_KEYS
try {
  [void][AlphaNative.Win]::ShowWindow($handle, 9)
  try { [Microsoft.VisualBasic.Interaction]::AppActivate($targetPid) } catch {
    [void][AlphaNative.Win]::SetForegroundWindow($handle)
  }
  Start-Sleep -Milliseconds 350
  [System.Windows.Forms.SendKeys]::SendWait($keys)
  Emit @{ ok = $true }
} catch {
  Emit @{ ok = $false; message = $_.Exception.Message }
}
`

const FOREGROUND_SCRIPT = `${CLIPBOARD_PRELUDE}
Add-Type -Namespace AlphaNative -Name Fg -MemberDefinition @'
[DllImport("user32.dll")] public static extern System.IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(System.IntPtr h, out uint pid);
'@
$h = [AlphaNative.Fg]::GetForegroundWindow()
$pidOut = 0
[void][AlphaNative.Fg]::GetWindowThreadProcessId($h, [ref]$pidOut)
Emit @{ processId = [int]$pidOut }
`
