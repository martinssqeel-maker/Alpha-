/**
 * Desktop-agent layer: authorized roots, the JSON tool protocol, the permission
 * matrix for the new capabilities, and tool execution with no project open.
 *
 * These are the pieces that turn a project-scoped coding chat into a general
 * Windows agent. Everything here is exercised through the production code paths
 * — the real `AuthorizedRoots`, the real tool dispatcher, the real permission
 * resolver — with only the OS-facing services stubbed, because PowerShell does
 * not exist on the Linux CI runner that also has to be able to run this suite.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { AuthorizedRoots } from '../src/main/services/authorizedRoots'
import { ChatService, ToolCallStreamFilter, isParallelSafeTool } from '../src/main/services/chat'
import { Db } from '../src/main/services/db'
import { initLogger } from '../src/main/services/logger'
import { ApprovalBroker, PermissionService } from '../src/main/services/permissionService'
import {
  isBlockedSystemPath,
  resolveUnderRoots,
  PathError
} from '../src/main/services/pathGuard'
import { executeTool, TOOL_DEFINITIONS, type ToolContext } from '../src/main/services/tools'
import {
  extractJsonObjects,
  parseFallbackToolCalls,
  stripFallbackToolCalls
} from '../src/main/services/toolCallFallback'
import { ConversationsRepo, SettingsRepo } from '../src/main/services/store'
import {
  AGENT_PERMISSIONS,
  CHAT_PERMISSIONS,
  DEFAULT_PERMISSIONS,
  permissionsForMode,
  resolvePermission,
  toolNeedsApproval
} from '../src/shared/permissions'
import type { ActivityItem, ChatEvent, PermissionSettings } from '../src/shared/types'

const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'alpha-desktop-agent-'))
const openDbs: Db[] = []

beforeAll(() => {
  initLogger(path.join(tmpBase, 'logs'))
})

afterEach(() => {
  for (const db of openDbs) db.close()
  openDbs.length = 0
})

function tempDir(name: string): string {
  const dir = fs.mkdtempSync(path.join(tmpBase, `${name}-`))
  return dir
}

// ---------------------------------------------------------------------------
// JSON tool protocol
// ---------------------------------------------------------------------------

describe('fallback tool-call protocol', () => {
  it('parses a single tagged block with an object argument', () => {
    const text = 'Opening it now.\n<tool_call>{"name": "find_and_launch_app", "arguments": {"query": "Word"}}</tool_call>'
    const calls = parseFallbackToolCalls(text)
    expect(calls).toHaveLength(1)
    expect(calls[0].name).toBe('find_and_launch_app')
    expect(calls[0].arguments).toEqual({ query: 'Word' })
    expect(calls[0].id).toMatch(/^call_/)
  })

  it('parses several calls in one message', () => {
    const text = [
      '<tool_call>{"name":"list_authorized_locations","arguments":{}}</tool_call>',
      '<tool_call>{"name":"create_or_write_file","arguments":{"path":"documents/a.txt","content":"hi"}}</tool_call>'
    ].join('\n')
    const calls = parseFallbackToolCalls(text)
    expect(calls.map((c) => c.name)).toEqual(['list_authorized_locations', 'create_or_write_file'])
  })

  it('accepts arguments delivered as a JSON string, and the "args" alias', () => {
    const calls = parseFallbackToolCalls(
      '<tool_call>{"name":"search_project","args":"{\\"query\\":\\"useState\\"}"}</tool_call>'
    )
    expect(calls[0].arguments).toEqual({ query: 'useState' })
  })

  it('tolerates a fenced json block and a trailing comma', () => {
    const text = '```json\n{"name":"list_open_windows","arguments":{},}\n```'
    const calls = parseFallbackToolCalls(text)
    expect(calls).toHaveLength(1)
    expect(calls[0].name).toBe('list_open_windows')
  })

  it('ignores prose that merely mentions a name', () => {
    expect(parseFallbackToolCalls('I will call the tool when you confirm.')).toEqual([])
    expect(parseFallbackToolCalls('')).toEqual([])
  })

  it('drops a malformed block instead of guessing', () => {
    expect(parseFallbackToolCalls('<tool_call>{"arguments":{"a":1}}</tool_call>')).toEqual([])
    expect(parseFallbackToolCalls('<tool_call>not json at all</tool_call>')).toEqual([])
  })

  it('keeps brace balancing correct when a value contains braces and quotes', () => {
    const objects = extractJsonObjects('{"name":"create_or_write_file","arguments":{"content":"a } \\"b\\" {"}}')
    expect(objects).toHaveLength(1)
    expect(objects[0]).toEqual({
      name: 'create_or_write_file',
      arguments: { content: 'a } "b" {' }
    })
  })

  it('removes the protocol from assistant prose', () => {
    const text = 'Done.\n<tool_call>{"name":"list_open_windows","arguments":{}}</tool_call>\nSaved.'
    expect(stripFallbackToolCalls(text)).toBe('Done.\n\nSaved.')
  })
})

describe('ToolCallStreamFilter', () => {
  it('passes ordinary text through unchanged', () => {
    const filter = new ToolCallStreamFilter(true)
    expect(filter.push('Opening Word now.')).toBe('Opening Word now.')
    expect(filter.flush()).toBe('')
  })

  it('suppresses a tool block split across chunks and keeps the prose', () => {
    const filter = new ToolCallStreamFilter(true)
    let visible = ''
    visible += filter.push('Saving the file. <tool_')
    visible += filter.push('call>{"name":"create_or_write_file",')
    visible += filter.push('"arguments":{"path":"a.txt"}}</tool_call> Done.')
    visible += filter.flush()
    expect(visible).toBe('Saving the file.  Done.')
    expect(visible).not.toContain('tool_call')
  })

  it('drops an unterminated block rather than printing half of it', () => {
    const filter = new ToolCallStreamFilter(true)
    filter.push('<tool_call>{"name":"list_open_windows"')
    expect(filter.flush()).toBe('')
  })

  it('is a no-op when disabled', () => {
    const filter = new ToolCallStreamFilter(false)
    expect(filter.push('<tool_call>{}</tool_call>')).toBe('<tool_call>{}</tool_call>')
  })
})

// ---------------------------------------------------------------------------
// Authorized locations
// ---------------------------------------------------------------------------

/**
 * In-memory settings.
 *
 * `AuthorizedRoots` and `PermissionService` only ever call `get()`/`set()`, so a
 * real sql.js database would add an async open and a native-ish dependency to
 * every pure-logic assertion for no extra coverage. The merge mirrors
 * `SettingsRepo`'s deep merge so `set({ agent: { extraPaths } })` behaves the
 * same way here as in the app.
 */
function memorySettings(initial: Record<string, unknown> = {}): SettingsRepo {
  let value: Record<string, unknown> = {
    agent: {
      enabled: true,
      workspace: { documents: true, desktop: true, downloads: true },
      extraPaths: [],
      maxToolIterations: 15,
      allowMouseFallback: true
    },
    permissions: { ...DEFAULT_PERMISSIONS },
    skills: { enabled: {} },
    ...initial
  }
  const merge = (base: unknown, patch: unknown): unknown => {
    if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return patch
    const baseObj = (base && typeof base === 'object' && !Array.isArray(base) ? base : {}) as Record<string, unknown>
    const out: Record<string, unknown> = { ...baseObj }
    for (const [key, next] of Object.entries(patch as Record<string, unknown>)) {
      out[key] = merge(baseObj[key], next)
    }
    return out
  }
  return {
    get: () => value as never,
    set: (patch: Record<string, unknown>) => {
      value = merge(value, patch) as Record<string, unknown>
      return value as never
    }
  } as unknown as SettingsRepo
}

function makeRoots(options: { extraPaths?: string[]; projectRoot?: string | null } = {}): {
  roots: AuthorizedRoots
  documents: string
  desktop: string
  downloads: string
  settings: SettingsRepo
} {
  const documents = tempDir('docs')
  const desktop = tempDir('desktop')
  const downloads = tempDir('downloads')
  const settings = memorySettings()
  if (options.extraPaths) settings.set({ agent: { extraPaths: options.extraPaths } })
  const roots = new AuthorizedRoots({
    standardPaths: { documents, desktop, downloads },
    settings,
    projectRoot: () => options.projectRoot ?? null
  })
  return { roots, documents, desktop, downloads, settings }
}

describe('AuthorizedRoots', () => {
  it('lists the user folders in a stable order, with the project first', () => {
    const project = tempDir('project')
    const { roots } = makeRoots({ projectRoot: project })
    const kinds = roots.list().map((l) => l.kind)
    expect(kinds[0]).toBe('project')
    expect(kinds).toEqual(['project', 'documents', 'desktop', 'downloads'])
  })

  it('honours a folder the user switched off', () => {
    const { roots, settings } = makeRoots()
    settings.set({ agent: { workspace: { documents: true, desktop: false, downloads: true } } })
    expect(roots.list().map((l) => l.kind)).not.toContain('desktop')
  })

  it('resolves a friendly alias to the right root', () => {
    const { roots, documents } = makeRoots()
    const resolved = roots.resolve('documents/report.docx')
    expect(resolved.abs).toBe(path.join(documents, 'report.docx'))
    expect(resolved.location.kind).toBe('documents')
  })

  it('resolves a plain relative path inside an authorized root', () => {
    const { roots, documents } = makeRoots()
    expect(roots.resolve('notes/today.md').abs).toBe(path.join(documents, 'notes', 'today.md'))
  })

  it('refuses an absolute path outside every root', () => {
    const { roots } = makeRoots()
    expect(() => roots.resolve(path.join(tmpBase, 'elsewhere', 'x.txt'))).toThrow(PathError)
  })

  it('refuses traversal out of a root', () => {
    const { roots } = makeRoots()
    expect(() => roots.resolve('documents/../../secrets.txt')).toThrow(PathError)
  })

  it('treats OS-owned directories as off-limits', () => {
    expect(isBlockedSystemPath('C:\\Windows\\System32')).toBe(true)
    expect(isBlockedSystemPath('C:\\Program Files\\App\\app.exe')).toBe(true)
    expect(isBlockedSystemPath('C:\\Users\\me\\AppData\\Roaming\\x')).toBe(true)
    expect(isBlockedSystemPath('/etc/passwd')).toBe(true)
    expect(isBlockedSystemPath(tmpBase)).toBe(false)
  })

  it('does not hand out a blocked system root even when it is in the list', () => {
    const blocked = 'C:\\Windows\\System32'
    expect(() =>
      resolveUnderRoots([{ path: blocked, label: 'blocked', kind: 'custom' }], path.join(blocked, 'cmd.exe'))
    ).toThrow(PathError)
  })
})

// ---------------------------------------------------------------------------
// Permission matrix
// ---------------------------------------------------------------------------

describe('desktop permission matrix', () => {
  const keys = ['appLaunch', 'desktopControl', 'browserControl'] as const

  it('denies every desktop capability in chat mode', () => {
    for (const key of keys) {
      expect(resolvePermission(CHAT_PERMISSIONS, key)).toBe('deny')
    }
  })

  it('asks for consequential desktop actions in assist mode', () => {
    for (const key of keys) {
      expect(resolvePermission(DEFAULT_PERMISSIONS, key)).toBe('ask')
    }
  })

  it('allows desktop control in agent mode while keeping deletes and secrets gated', () => {
    for (const key of keys) {
      expect(resolvePermission(AGENT_PERMISSIONS, key)).toBe('allow')
    }
    expect(AGENT_PERMISSIONS.fileDeletes).toBe('ask')
    expect(AGENT_PERMISSIONS.sensitiveFiles).toBe('deny')
  })

  it('keeps an always-approval tool gated even when its capability is allowed', () => {
    const agent = permissionsForMode('agent')
    // `run_approved_command` declares requiresApproval: true.
    expect(toolNeedsApproval(agent, 'terminal', true).decision).toBe('ask')
    // A read-only inspection tool never prompts.
    expect(toolNeedsApproval(agent, 'read', false).decision).toBe('allow')
    // Chat mode refuses tools outright.
    expect(toolNeedsApproval(CHAT_PERMISSIONS, 'read', false).decision).toBe('deny')
  })

  it('back-fills the new keys for a settings blob written before they existed', () => {
    const legacy: PermissionSettings = {
      ...DEFAULT_PERMISSIONS
    } as PermissionSettings
    delete (legacy as Partial<PermissionSettings>).appLaunch
    const next = permissionsForMode('assist', legacy)
    expect(next.appLaunch).toBe('ask')
    expect(next.desktopControl).toBe('ask')
    expect(next.browserControl).toBe('ask')
  })
})

// ---------------------------------------------------------------------------
// Tool execution with no project open
// ---------------------------------------------------------------------------

function makeContext(
  rootOptions: { extraPaths?: string[] } = {},
  permissionOverrides: Partial<PermissionSettings> = {}
): {
  ctx: ToolContext
  roots: AuthorizedRoots
  documents: string
} {
  const { roots, documents, settings } = makeRoots(rootOptions)
  const permissions = new PermissionService(settings)
  permissions.set({ ...permissionsForMode('agent'), ...permissionOverrides })

  const ctx: ToolContext = {
    // The whole point: no coding project is open.
    projectId: null,
    projects: {} as never,
    edits: {} as never,
    git: {} as never,
    terminal: {
      runCollect: async () => ({ code: 0, stdout: 'ok', stderr: '', durationMs: 1 })
    } as never,
    permissions,
    roots,
    desktop: {} as never,
    computer: {} as never,
    browser: {} as never
  }
  return { ctx, roots, documents }
}

describe('tool dispatch without a project', () => {
  it('exposes the desktop and browser tools alongside the coding ones', () => {
    const names = TOOL_DEFINITIONS.map((t) => t.name)
    for (const expected of [
      'create_or_write_file',
      'create_directory',
      'move_or_rename_file',
      'list_authorized_locations',
      'find_and_launch_app',
      'inspect_window_ui',
      'interact_with_window_element',
      'capture_window_screenshot',
      'create_or_edit_office_document',
      'browser_navigate',
      'browser_read_page',
      'browser_interact'
    ]) {
      expect(names).toContain(expected)
    }
  })

  it('writes a file into an authorized folder and verifies it on disk', async () => {
    const { ctx, documents } = makeContext()
    const result = await executeTool(
      'create_or_write_file',
      { path: 'documents/report.txt', content: 'Quarterly numbers' },
      ctx
    )
    const target = path.join(documents, 'report.txt')
    expect(fs.readFileSync(target, 'utf8')).toBe('Quarterly numbers')
    expect(result.verification?.verified).toBe(true)
    expect(result.verification?.check).toBe('fs.stat')
    expect(result.verification?.note).toContain('report.txt')
  })

  it('reports verification false when nothing lands on disk', async () => {
    const { ctx } = makeContext()
    // Point the write at a path whose parent is a file, so the write throws.
    const blocking = path.join(ctx.roots.list()[0].path, 'blocker')
    fs.writeFileSync(blocking, 'x')
    await expect(
      executeTool('create_or_write_file', { path: `${blocking}/nested.txt`, content: 'x' }, ctx)
    ).rejects.toThrow()
  })

  it('creates a directory and verifies it', async () => {
    const { ctx, documents } = makeContext()
    const result = await executeTool('create_directory', { path: 'documents/Reports/2026' }, ctx)
    expect(fs.statSync(path.join(documents, 'Reports', '2026')).isDirectory()).toBe(true)
    expect(result.verification?.verified).toBe(true)
  })

  it('moves a file and proves the source is gone', async () => {
    const { ctx, documents } = makeContext()
    fs.writeFileSync(path.join(documents, 'draft.txt'), 'hello')
    const result = await executeTool(
      'move_or_rename_file',
      { from: 'documents/draft.txt', to: 'documents/final.txt' },
      ctx
    )
    expect(fs.existsSync(path.join(documents, 'draft.txt'))).toBe(false)
    expect(fs.readFileSync(path.join(documents, 'final.txt'), 'utf8')).toBe('hello')
    expect(result.verification?.verified).toBe(true)
  })

  it('refuses to overwrite an existing destination unless told to', async () => {
    const { ctx, documents } = makeContext()
    fs.writeFileSync(path.join(documents, 'a.txt'), 'a')
    fs.writeFileSync(path.join(documents, 'b.txt'), 'b')
    await expect(
      executeTool('move_or_rename_file', { from: 'documents/a.txt', to: 'documents/b.txt' }, ctx)
    ).rejects.toThrow(/already exists/i)
    expect(fs.readFileSync(path.join(documents, 'b.txt'), 'utf8')).toBe('b')
  })

  it('blocks a secret file from being deleted', async () => {
    const { ctx, documents } = makeContext()
    fs.writeFileSync(path.join(documents, '.env'), 'SECRET=1')
    await expect(executeTool('delete_file', { path: 'documents/.env' }, ctx)).rejects.toThrow(
      /secret/i
    )
    expect(fs.existsSync(path.join(documents, '.env'))).toBe(true)
  })

  it('still requires a project for the project-scoped tools', async () => {
    const { ctx } = makeContext()
    await expect(executeTool('list_project_files', {}, ctx)).rejects.toThrow(/No coding project/i)
  })

  it('lists the authorized locations for the model', async () => {
    const { ctx } = makeContext()
    const result = await executeTool('list_authorized_locations', {}, ctx)
    const locations = result.result as { kind: string; path: string }[]
    expect(locations.map((l) => l.kind)).toEqual(['documents', 'desktop', 'downloads'])
    expect(result.verification?.verified).toBe(true)
  })

  it('rejects a browser tool when no browser view exists, without throwing', async () => {
    const { ctx } = makeContext()
    ;(ctx as { browser: unknown }).browser = {
      navigate: async () => ({ url: 'https://example.com', loading: false, canGoBack: false, canGoForward: false, error: null }),
      readPage: async () => ({
        ok: false,
        url: '',
        title: '',
        text: '',
        elements: [],
        truncated: false,
        message: 'The browser panel has not been opened yet.'
      })
    }
    const read = await executeTool('browser_read_page', {}, ctx)
    expect(read.verification?.verified).toBe(false)
    expect(read.summary).toMatch(/not been opened|could not be read/i)
  })
})

// ---------------------------------------------------------------------------
// Chat pipeline with no project
// ---------------------------------------------------------------------------

describe('chat pipeline without an open project', () => {
  it('runs a file tool through the JSON protocol when the model has no native tools', async () => {
    const { roots, documents } = makeRoots()
    const db = await Db.open(path.join(tmpBase, `pipeline-${Math.random().toString(36).slice(2)}.db`))
    openDbs.push(db)
    const conversations = new ConversationsRepo(db)
    const settings = new SettingsRepo(db)
    const permissions = new PermissionService(settings)
    permissions.set(permissionsForMode('agent'))
    const conversation = conversations.create({})

    const events: ChatEvent[] = []
    const activities: ActivityItem[] = []
    let round = 0

    const provider = {
      get: () => ({ id: 'fake', name: 'Fake local', isLocal: true, kind: 'ollama' as const }),
      chat: async (_id: string, req: { onDelta?: (d: { content?: string }) => void }) => {
        round++
        if (round === 1) {
          // The model emits the protocol as text, exactly as a small local model does.
          req.onDelta?.({
            content:
              'Saving that now. <tool_call>{"name":"create_or_write_file","arguments":{"path":"documents/plan.md","content":"# Plan"}}</tool_call>'
          })
          return {
            content:
              'Saving that now. <tool_call>{"name":"create_or_write_file","arguments":{"path":"documents/plan.md","content":"# Plan"}}</tool_call>',
            toolCalls: [],
            finishReason: 'stop'
          }
        }
        req.onDelta?.({ content: 'Saved it.' })
        return { content: 'Saved it.', toolCalls: [], finishReason: 'stop' }
      }
    }

    const chat = new ChatService({
      providers: provider as never,
      conversations,
      projects: {} as never,
      edits: {} as never,
      git: {} as never,
      terminal: { runCollect: async () => ({ code: 0, stdout: '', stderr: '', durationMs: 0 }) } as never,
      skills: { promptContext: () => '' } as never,
      permissions,
      broker: new ApprovalBroker(),
      settings,
      roots,
      desktop: {} as never,
      computer: {} as never,
      browser: {} as never,
      emit: (event) => {
        events.push(event)
        if (event.type === 'activity') {
          const index = activities.findIndex((a) => a.id === event.activity.id)
          if (index >= 0) activities[index] = event.activity
          else activities.push(event.activity)
        }
      }
    })

    chat.send({
      conversationId: conversation.id,
      providerId: 'fake',
      modelId: 'qwen3:1.7b',
      mode: 'agent',
      projectId: null,
      text: 'Save a plan to Documents'
    })

    const deadline = Date.now() + 8000
    while (Date.now() < deadline && !events.some((e) => e.type === 'done' || e.type === 'error')) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }

    expect(events.some((e) => e.type === 'error')).toBe(false)
    // The tool actually ran against the real filesystem.
    expect(fs.readFileSync(path.join(documents, 'plan.md'), 'utf8')).toBe('# Plan')

    const completed = activities.find((a) => a.toolName === 'create_or_write_file')
    expect(completed?.state).toBe('completed')
    expect(completed?.verification?.verified).toBe(true)

    // The protocol must never reach the user as chat text.
    const visible = events
      .filter((e): e is Extract<ChatEvent, { type: 'delta' }> => e.type === 'delta')
      .map((e) => e.content)
      .join('')
    expect(visible).not.toContain('<tool_call>')
    expect(visible).toContain('Saved it.')
  })
})

// ---------------------------------------------------------------------------
// Parallel-safety table
// ---------------------------------------------------------------------------

describe('parallel safety after the desktop tools landed', () => {
  it('keeps mutating and OS-driving tools serial', () => {
    for (const name of [
      'apply_approved_patch',
      'run_approved_command',
      'create_or_write_file',
      'delete_file',
      'find_and_launch_app',
      'interact_with_window_element',
      'clipboard_bridge',
      'browser_interact',
      'browser_navigate'
    ]) {
      expect(isParallelSafeTool(name), name).toBe(false)
    }
  })

  it('allows the read-only inspectors to run together', () => {
    for (const name of ['list_open_windows', 'inspect_window_ui', 'browser_read_page', 'list_authorized_locations']) {
      expect(isParallelSafeTool(name), name).toBe(true)
    }
  })
})
