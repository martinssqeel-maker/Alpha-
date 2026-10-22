import fs from 'node:fs'
import path from 'node:path'
import type { ToolDefinition, ToolVerification } from '@shared/types'
import type { EditService } from './editService'
import type { GitService } from './git'
import { PathError } from './pathGuard'
import type { PermissionService } from './permissionService'
import type { ProjectService } from './projectService'
import type { TerminalService } from './terminal'
import type { AuthorizedRoots } from './authorizedRoots'
import type { DesktopService } from './desktopService'
import type { ComputerUseService } from './computerUseService'
import type { BrowserPreviewService } from './browserPreview'

export interface ToolContext {
  /**
   * The open coding project, when there is one.
   *
   * `null` is a supported state, not a failure: desktop, browser and authorized
   * file tools are exactly what a user wants when no repository is open. Only
   * the tools that need a project (git, project search) say so themselves.
   */
  projectId: string | null
  projects: ProjectService
  edits: EditService
  git: GitService
  terminal: TerminalService
  permissions: PermissionService
  roots: AuthorizedRoots
  desktop: DesktopService
  computer: ComputerUseService
  browser: BrowserPreviewService
}

export interface ToolExecution {
  result: unknown
  summary: string
  /**
   * Proof that the action actually happened. The model's prose is not evidence:
   * every consequential tool re-probes afterwards and reports what it observed.
   */
  verification?: ToolVerification
}

/** Tools that only observe. Parallel-safe and never prompt. */
export const READ_TOOLS = new Set([
  'list_project_files',
  'search_project',
  'read_project_file',
  'propose_file_patch',
  'get_git_status',
  'get_git_diff',
  'list_authorized_locations',
  'list_open_windows',
  'inspect_window_ui',
  'capture_window_screenshot',
  'browser_read_page',
  'browser_screenshot'
])

/**
 * Tools that belong to the general desktop agent rather than to coding.
 *
 * Settings → Agent can switch these off without touching the project workflow,
 * so someone who wants Alpha as a coding assistant only does not have to grant
 * window-control capability at all.
 */
export const AGENT_ONLY_TOOLS = new Set([
  'list_authorized_locations',
  'create_or_write_file',
  'create_directory',
  'move_or_rename_file',
  'delete_file',
  'find_and_launch_app',
  'list_open_windows',
  'focus_window',
  'close_window',
  'inspect_window_ui',
  'interact_with_window_element',
  'clipboard_bridge',
  'capture_window_screenshot',
  'create_or_edit_office_document',
  'browser_navigate',
  'browser_read_page',
  'browser_interact',
  'browser_screenshot'
])

/** Tools that can only run when a coding project is open. */
export const PROJECT_TOOLS = new Set([
  'list_project_files',
  'search_project',
  'read_project_file',
  'propose_file_patch',
  'apply_approved_patch',
  'get_git_status',
  'get_git_diff'
])

const pathParam = { type: 'string', description: 'File or folder path. Absolute, or relative to an authorized location (e.g. "documents/report.docx").' }

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  // ---------------------------------------------------------------------
  // Files (project)
  // ---------------------------------------------------------------------
  {
    name: 'list_project_files',
    description:
      'List files and folders in the current project. Optionally pass a relative subpath and a depth. Use this before reading files.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative folder path inside the project (optional).' },
        depth: { type: 'integer', minimum: 1, maximum: 4, description: 'How deep to list (default 2).' }
      }
    },
    category: 'read',
    requiresApproval: false,
    permissionKey: 'read'
  },
  {
    name: 'search_project',
    description:
      'Search the project either by file name or file content. Returns matches with line numbers. Prefer this over reading many files.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Text to search for.' },
        mode: { type: 'string', enum: ['name', 'content'], description: 'Search file names or file contents.' }
      },
      required: ['query']
    },
    category: 'read',
    requiresApproval: false,
    permissionKey: 'read'
  },
  {
    name: 'read_project_file',
    description: 'Read the full text of one project file by its project-relative path.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Project-relative file path.' } },
      required: ['path']
    },
    category: 'read',
    requiresApproval: false,
    permissionKey: 'read'
  },
  {
    name: 'propose_file_patch',
    description:
      'Propose a change to a project file. For new files or whole-file rewrites use kind="write" with the full new content in "after". For targeted edits use kind="patch" with a unified diff in "patch". This does NOT save anything; it returns a diff for review and a proposalId.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Project-relative file path.' },
        kind: { type: 'string', enum: ['write', 'patch'], description: 'Change type.' },
        after: { type: 'string', description: 'Full new file content (for kind="write").' },
        patch: { type: 'string', description: 'Unified diff text (for kind="patch").' }
      },
      required: ['path', 'kind']
    },
    category: 'write',
    requiresApproval: false,
    permissionKey: 'read'
  },
  {
    name: 'apply_approved_patch',
    description:
      'Apply a previously proposed change by its proposalId. Requires user approval. Creates a checkpoint before writing.',
    parameters: {
      type: 'object',
      properties: { proposalId: { type: 'string', description: 'proposalId returned by propose_file_patch.' } },
      required: ['proposalId']
    },
    category: 'write',
    requiresApproval: true,
    permissionKey: 'fileWrites'
  },

  // ---------------------------------------------------------------------
  // Files (authorized Windows locations)
  // ---------------------------------------------------------------------
  {
    name: 'list_authorized_locations',
    description:
      'List the folders you may read and write outside the coding project (Documents, Desktop, Downloads and any the user added), plus the current project. Call this first when you need to save or open a file by name.',
    parameters: { type: 'object', properties: {} },
    category: 'read',
    requiresApproval: false,
    permissionKey: 'read'
  },
  {
    name: 'create_or_write_file',
    description:
      'Create or overwrite a text file in an authorized location. Use this for documents, notes and data files outside a coding project. Returns the absolute path and a byte count. Content is written atomically.',
    parameters: {
      type: 'object',
      properties: {
        path: pathParam,
        content: { type: 'string', description: 'Full UTF-8 file content.' },
        append: { type: 'boolean', description: 'Append instead of overwriting (default false).' }
      },
      required: ['path', 'content']
    },
    category: 'write',
    requiresApproval: false,
    permissionKey: 'fileWrites'
  },
  {
    name: 'create_directory',
    description: 'Create a folder (and any missing parents) inside an authorized location.',
    parameters: {
      type: 'object',
      properties: { path: pathParam },
      required: ['path']
    },
    category: 'write',
    requiresApproval: false,
    permissionKey: 'fileWrites'
  },
  {
    name: 'move_or_rename_file',
    description: 'Move or rename a file between authorized locations. Fails rather than overwriting an existing target.',
    parameters: {
      type: 'object',
      properties: {
        from: pathParam,
        to: { type: 'string', description: 'Destination path.' },
        overwrite: { type: 'boolean', description: 'Replace the destination if it exists (default false).' }
      },
      required: ['from', 'to']
    },
    category: 'write',
    requiresApproval: false,
    permissionKey: 'fileWrites'
  },
  {
    name: 'delete_file',
    description: 'Delete a single file inside an authorized location. Requires approval.',
    parameters: {
      type: 'object',
      properties: { path: pathParam },
      required: ['path']
    },
    category: 'write',
    requiresApproval: true,
    permissionKey: 'fileDeletes'
  },

  // ---------------------------------------------------------------------
  // Git
  // ---------------------------------------------------------------------
  {
    name: 'get_git_status',
    description: 'Get the Git working tree status: branch, remotes, and changed files.',
    parameters: { type: 'object', properties: {} },
    category: 'git',
    requiresApproval: false,
    permissionKey: 'read'
  },
  {
    name: 'get_git_diff',
    description: 'Get the current Git diff (unstaged by default, or staged).',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Optional single file to diff.' },
        staged: { type: 'boolean', description: 'Show staged changes instead.' }
      }
    },
    category: 'git',
    requiresApproval: false,
    permissionKey: 'read'
  },

  // ---------------------------------------------------------------------
  // Terminal
  // ---------------------------------------------------------------------
  {
    name: 'run_approved_command',
    description:
      'Run a development command (tests, build, lint, formatter) in the project directory or an authorized folder and return its output. Requires user approval.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Exact command to run.' },
        purpose: { type: 'string', description: 'Short reason for running it.' }
      },
      required: ['command']
    },
    category: 'execute',
    requiresApproval: true,
    permissionKey: 'terminal'
  },

  // ---------------------------------------------------------------------
  // Windows desktop
  // ---------------------------------------------------------------------
  {
    name: 'list_open_windows',
    description:
      'List every visible application window on the desktop with its process id, title and bounds. Use this to find the window you need to act on, or to confirm an app is open.',
    parameters: { type: 'object', properties: {} },
    category: 'read',
    requiresApproval: false,
    permissionKey: 'read'
  },
  {
    name: 'find_and_launch_app',
    description:
      'Find an installed Windows application by name (for example "Word", "Notepad", "Excel", "Calculator", "Visual Studio Code", "Godot") and open or focus it. Searches running processes, Start apps, Start-menu and desktop shortcuts, App Paths registry keys, then PATH. Returns the process id and window title.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Application name, as a person would say it.' }
      },
      required: ['query']
    },
    category: 'desktop',
    requiresApproval: false,
    permissionKey: 'appLaunch'
  },
  {
    name: 'focus_window',
    description: 'Bring an open window to the foreground. Pass its title (or part of it) or its process id.',
    parameters: {
      type: 'object',
      properties: {
        window: { type: 'string', description: 'Window title or part of it.' },
        processId: { type: 'integer', description: 'Process id, if you know it.' }
      }
    },
    category: 'desktop',
    requiresApproval: false,
    permissionKey: 'desktopControl'
  },
  {
    name: 'close_window',
    description:
      'Close an application window, asking the app to exit first and only forcing it after a grace period. Requires approval.',
    parameters: {
      type: 'object',
      properties: {
        window: { type: 'string', description: 'Window title or part of it.' },
        processId: { type: 'integer', description: 'Process id, if you know it.' }
      }
    },
    category: 'desktop',
    requiresApproval: true,
    permissionKey: 'desktopControl'
  },
  {
    name: 'inspect_window_ui',
    description:
      'Read the interactive controls of an open window. Returns a numbered map like "[1] Button \\"Save\\" (patterns: Invoke)". Use that number with interact_with_window_element. Always inspect before interacting, and again after the window changes.',
    parameters: {
      type: 'object',
      properties: {
        window: { type: 'string', description: 'Window title or part of it.' },
        processId: { type: 'integer', description: 'Process id, if you know it.' }
      }
    },
    category: 'read',
    requiresApproval: false,
    permissionKey: 'read'
  },
  {
    name: 'interact_with_window_element',
    description:
      'Act on a numbered element from inspect_window_ui. Actions: invoke (press a button), setValue/type (fill an input), toggle, select, expand, collapse, focus, click. Uses cursor-free Windows UI Automation first, so it does not move the user\'s mouse.',
    parameters: {
      type: 'object',
      properties: {
        window: { type: 'string', description: 'Window title or part of it.' },
        processId: { type: 'integer', description: 'Process id, if you know it.' },
        elementId: { type: 'integer', description: 'The [n] number from inspect_window_ui.' },
        action: {
          type: 'string',
          enum: ['invoke', 'click', 'setValue', 'type', 'focus', 'toggle', 'select', 'expand', 'collapse', 'read'],
          description: 'What to do with the element.'
        },
        value: { type: 'string', description: 'Text for setValue/type.' }
      },
      required: ['elementId', 'action']
    },
    category: 'desktop',
    requiresApproval: false,
    permissionKey: 'desktopControl'
  },
  {
    name: 'clipboard_bridge',
    description:
      'Move text through the Windows clipboard. "paste_text" focuses the target window, pastes the text, then restores what the user had copied. "read" returns the clipboard (secrets redacted). "write" only sets it.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['paste_text', 'read', 'write'], description: 'Clipboard operation.' },
        text: { type: 'string', description: 'Text to place on the clipboard.' },
        targetWindow: { type: 'string', description: 'Window to paste into (required for paste_text).' },
        keys: { type: 'string', description: 'SendKeys sequence, default "^v" (Ctrl+V).' }
      },
      required: ['action']
    },
    category: 'desktop',
    requiresApproval: false,
    permissionKey: 'desktopControl'
  },
  {
    name: 'capture_window_screenshot',
    description:
      'Capture a window (or the whole screen) as a PNG you can inspect. Set annotate=true to draw the numbered element boxes from inspect_window_ui onto the image, so the numbers you read match the numbers you see.',
    parameters: {
      type: 'object',
      properties: {
        window: { type: 'string', description: 'Window title or part of it.' },
        processId: { type: 'integer', description: 'Process id, if you know it.' },
        annotate: { type: 'boolean', description: 'Overlay the numbered element map (default false).' },
        screen: { type: 'boolean', description: 'Capture the whole screen instead of one window.' }
      }
    },
    category: 'read',
    requiresApproval: false,
    permissionKey: 'read'
  },
  {
    name: 'create_or_edit_office_document',
    description:
      'Create a Word (.docx) or Excel (.xlsx) file with real formatting, by driving the installed Office app so the user watches it happen. Pass structured blocks for Word (title, heading, paragraph, bullet, table) or sheets of rows for Excel. Falls back to a rich-text file if Office is not installed, and reports which engine ran.',
    parameters: {
      type: 'object',
      properties: {
        app: { type: 'string', enum: ['word', 'excel'], description: 'Which Office application.' },
        path: { type: 'string', description: 'Destination path, e.g. "documents/Quarterly Report.docx".' },
        title: { type: 'string', description: 'Document title (Word only).' },
        blocks: {
          type: 'array',
          description: 'Ordered Word content blocks.',
          items: {
            type: 'object',
            properties: {
              type: { type: 'string', enum: ['title', 'heading', 'paragraph', 'bullet', 'table', 'pagebreak'] },
              text: { type: 'string' },
              level: { type: 'integer', minimum: 1, maximum: 4 },
              rows: { type: 'array', items: { type: 'array', items: { type: 'string' } } }
            },
            required: ['type']
          }
        },
        sheets: {
          type: 'array',
          description: 'Excel sheets (first row is treated as a header).',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              rows: { type: 'array', items: { type: 'array', items: { type: 'string' } } }
            }
          }
        }
      },
      required: ['app', 'path']
    },
    category: 'desktop',
    requiresApproval: false,
    permissionKey: 'desktopControl'
  },

  // ---------------------------------------------------------------------
  // Browser
  // ---------------------------------------------------------------------
  {
    name: 'browser_navigate',
    description:
      'Open a URL in the built-in Browser panel (visible to the user) and wait for it to load. Use browser_read_page afterwards to see what is there.',
    parameters: {
      type: 'object',
      properties: { url: { type: 'string', description: 'http(s) URL to open.' } },
      required: ['url']
    },
    category: 'browser',
    requiresApproval: false,
    permissionKey: 'browserControl'
  },
  {
    name: 'browser_read_page',
    description:
      'Read the current Browser panel page: title, URL, visible text, and a numbered list of interactive elements ([1] input "Search"). Use those numbers with browser_interact.',
    parameters: { type: 'object', properties: {} },
    category: 'read',
    requiresApproval: false,
    permissionKey: 'read'
  },
  {
    name: 'browser_interact',
    description:
      'Click, type into, or press a key on a numbered Browser panel element (or a CSS selector). Returns the updated page state so you can see the effect.',
    parameters: {
      type: 'object',
      properties: {
        elementId: { type: 'integer', description: 'The [n] number from browser_read_page.' },
        selector: { type: 'string', description: 'CSS selector, used when elementId is not given.' },
        action: { type: 'string', enum: ['click', 'type', 'press'], description: 'Interaction to perform.' },
        value: { type: 'string', description: 'Text to type, or the key to press (e.g. "Enter").' }
      },
      required: ['action']
    },
    category: 'browser',
    requiresApproval: false,
    permissionKey: 'browserControl'
  },
  {
    name: 'browser_screenshot',
    description: 'Capture the Browser panel viewport as a PNG.',
    parameters: { type: 'object', properties: {} },
    category: 'read',
    requiresApproval: false,
    permissionKey: 'read'
  }
]

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

function requireProject(ctx: ToolContext): string {
  if (!ctx.projectId) {
    throw new PathError(
      'No coding project is open. Open a folder first, or use the file tools for authorized locations.',
      'no_project'
    )
  }
  return ctx.projectId
}

function asString(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback
}

function asNumber(v: unknown): number | undefined {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN
  return Number.isFinite(n) ? n : undefined
}

/** Resolve the window argument shared by the desktop tools. */
function windowTarget(a: Record<string, unknown>): string | number {
  const pid = asNumber(a.processId)
  if (pid !== undefined) return Math.trunc(pid)
  const title = asString(a.window)
  if (!title) {
    throw new PathError('Pass a window title or processId.', 'invalid')
  }
  return title
}

export async function executeTool(
  name: string,
  args: unknown,
  ctx: ToolContext
): Promise<ToolExecution> {
  const a = (args ?? {}) as Record<string, unknown>
  switch (name) {
    // ----------------------------------------------------------------- files
    case 'list_project_files': {
      const projectId = requireProject(ctx)
      const nodes = ctx.projects.listTree(projectId, asString(a.path, ''), Number(a.depth) || 2)
      return { result: nodes, summary: `Listed ${countNodes(nodes)} entries.` }
    }
    case 'search_project': {
      const projectId = requireProject(ctx)
      const query = asString(a.query)
      if (!query) throw new PathError('query is required', 'invalid')
      const mode = asString(a.mode, 'content')
      if (mode === 'name') {
        const results = ctx.projects.searchNames(projectId, query, 100)
        return { result: results, summary: `Found ${results.length} matching file name(s).` }
      }
      const results = ctx.projects.searchContent(projectId, query, 100)
      return { result: results, summary: `Found ${results.length} content match(es).` }
    }
    case 'read_project_file': {
      const projectId = requireProject(ctx)
      const allowSensitive = ctx.permissions.resolve('sensitiveFiles') === 'allow'
      const res = ctx.projects.readFile(projectId, asString(a.path), { allowSensitive })
      return {
        result: { path: res.path, content: res.content, truncated: res.truncated, binary: res.binary },
        summary: `Read ${res.path} (${res.size} bytes).`
      }
    }
    case 'propose_file_patch': {
      const projectId = requireProject(ctx)
      const kind = asString(a.kind, 'write') === 'patch' ? 'patch' : 'write'
      const proposal = ctx.edits.propose({
        projectId,
        path: asString(a.path),
        kind,
        after: typeof a.after === 'string' ? a.after : undefined,
        patch: typeof a.patch === 'string' ? a.patch : undefined
      })
      return {
        result: {
          proposalId: proposal.proposalId,
          path: proposal.path,
          stale: proposal.stale,
          diff: proposal.diff.slice(0, 8000)
        },
        summary: `Proposed ${kind} for ${proposal.path}${proposal.stale ? ' (file changed on disk!)' : ''}.`,
        // A proposal writes nothing by definition, so the honest verification is
        // "a diff was computed against the file as it is right now".
        verification: {
          verified: !proposal.stale,
          note: proposal.stale
            ? `${proposal.path} changed on disk since it was read; the proposal is based on stale content.`
            : `Diff computed for ${proposal.path}; nothing has been written yet.`,
          check: 'edit-proposal'
        }
      }
    }
    case 'apply_approved_patch': {
      requireProject(ctx)
      const res = ctx.edits.apply(asString(a.proposalId))
      if (!res.ok) throw new PathError(res.message || 'Could not apply patch', 'apply_failed')
      return {
        result: res,
        summary: `Applied change to ${res.path}.`,
        verification: res.checkpointId
          ? {
              verified: true,
              note: `Wrote ${res.path} (checkpoint ${res.checkpointId} taken first).`,
              check: 'edit-apply'
            }
          : { verified: true, note: `Wrote ${res.path}.`, check: 'edit-apply' }
      }
    }

    // --------------------------------------------------- authorized files
    case 'list_authorized_locations': {
      const locations = ctx.roots.list()
      return {
        result: locations,
        summary: `${locations.length} authorized location(s): ${locations.map((l) => l.label).join(', ')}.`,
        verification: {
          verified: locations.length > 0,
          note: locations.length
            ? 'These are the only folders the agent may read or write.'
            : 'No authorized locations are enabled; file tools will refuse to run.',
          check: 'policy'
        }
      }
    }
    case 'create_or_write_file': {
      const target = ctx.roots.resolve(asString(a.path))
      const content = asString(a.content)
      ctx.roots.ensureParent(target.abs)
      if (a.append === true) {
        fs.appendFileSync(target.abs, content, 'utf8')
      } else {
        // Atomic: a crash mid-write must not leave a half file behind.
        const tmp = `${target.abs}.alpha-tmp-${process.pid}-${Date.now()}`
        fs.writeFileSync(tmp, content, 'utf8')
        fs.renameSync(tmp, target.abs)
      }
      const verification = verifyFile(target.abs)
      return {
        result: { path: target.abs, relative: target.relative, bytes: fs.statSync(target.abs).size },
        summary: `${a.append === true ? 'Appended to' : 'Wrote'} ${target.abs} (${Buffer.byteLength(content, 'utf8')} bytes).`,
        verification
      }
    }
    case 'create_directory': {
      const target = ctx.roots.resolve(asString(a.path))
      ctx.roots.assertAllowed(target.abs)
      fs.mkdirSync(target.abs, { recursive: true })
      const ok = statSafe(target.abs)?.isDirectory() ?? false
      return {
        result: { path: target.abs },
        summary: `Created folder ${target.abs}.`,
        verification: {
          verified: ok,
          note: ok ? `Directory exists at ${target.abs}.` : `No directory exists at ${target.abs}.`,
          check: 'fs.stat'
        }
      }
    }
    case 'move_or_rename_file': {
      const from = ctx.roots.resolve(asString(a.from))
      const to = ctx.roots.resolve(asString(a.to))
      if (fs.existsSync(to.abs) && a.overwrite !== true) {
        throw new PathError(`A file already exists at ${to.abs}. Pass overwrite: true to replace it.`, 'exists')
      }
      ctx.roots.ensureParent(to.abs)
      fs.renameSync(from.abs, to.abs)
      const before = statSafe(from.abs)
      const after = statSafe(to.abs)
      const ok = !before && Boolean(after?.isFile())
      return {
        result: { from: from.abs, to: to.abs, bytes: after?.size },
        summary: `Moved ${from.abs} → ${to.abs}.`,
        verification: {
          verified: ok,
          note: ok
            ? `Source is gone and ${after?.size} bytes exist at the destination.`
            : 'The move reported success but the filesystem does not agree.',
          check: 'fs.stat'
        }
      }
    }
    case 'delete_file': {
      const target = ctx.roots.resolve(asString(a.path))
      ctx.roots.assertAllowed(target.abs)
      if (isSensitivePathForDelete(target.abs) && ctx.permissions.resolve('sensitiveFiles') !== 'allow') {
        throw new PathError('That file looks like a secret and is protected.', 'sensitive')
      }
      fs.unlinkSync(target.abs)
      const gone = !fs.existsSync(target.abs)
      return {
        result: { path: target.abs },
        summary: `Deleted ${target.abs}.`,
        verification: {
          verified: gone,
          note: gone ? `${target.abs} no longer exists.` : `${target.abs} still exists.`,
          check: 'fs.stat'
        }
      }
    }

    // ----------------------------------------------------------------- git
    case 'get_git_status': {
      const projectId = requireProject(ctx)
      const status = await ctx.git.status(projectId)
      return {
        result: status,
        summary: status.isRepo ? `Branch ${status.branch}, ${status.files.length} changed file(s).` : 'Not a Git repository.'
      }
    }
    case 'get_git_diff': {
      const projectId = requireProject(ctx)
      const patch = await ctx.git.diff(projectId, a.path ? asString(a.path) : undefined, Boolean(a.staged))
      return { result: { patch: patch.slice(0, 15000) }, summary: `Generated diff (${patch.length} chars).` }
    }

    // ------------------------------------------------------------ terminal
    case 'run_approved_command': {
      const command = asString(a.command)
      if (!command) throw new PathError('command is required', 'invalid')
      // Work in the project when there is one; otherwise in the first authorized
      // folder, so the desktop agent can still run a local tool.
      const cwd = ctx.projectId
        ? ctx.projects.resolveRoot(ctx.projectId)
        : ctx.roots.defaultLocation().path
      const out = await ctx.terminal.runCollect(command, cwd, 120000)
      return {
        result: {
          exitCode: out.code,
          durationMs: out.durationMs,
          stdout: out.stdout.slice(-8000),
          stderr: out.stderr.slice(-8000)
        },
        summary: `\`${command}\` exited with code ${out.code} in ${out.durationMs}ms.`,
        verification: {
          verified: out.code === 0,
          note:
            out.code === 0
              ? `The command exited 0 in ${out.durationMs}ms.`
              : `The command exited ${out.code}; its output is in the result, and nothing should be reported as successful.`,
          check: 'process-exit'
        }
      }
    }

    // ------------------------------------------------------------- desktop
    case 'list_open_windows': {
      const windows = await ctx.desktop.listOpenWindows()
      return {
        result: windows,
        summary: `${windows.length} open window(s).`,
        verification: { verified: true, note: `Enumerated ${windows.length} windows.`, check: 'process' }
      }
    }
    case 'find_and_launch_app': {
      const result = await ctx.desktop.findAndLaunchApp(asString(a.query))
      return {
        result,
        summary: result.ok
          ? `${result.alreadyRunning ? 'Focused' : 'Opened'} ${result.appName ?? asString(a.query)} (process ${result.processId}${result.windowTitle ? `, window "${result.windowTitle}"` : ''}).`
          : `Could not open ${asString(a.query)}: ${result.message ?? 'not found'}.`,
        verification: result.verification
      }
    }
    case 'focus_window': {
      const result = await ctx.desktop.focusWindow(windowTarget(a))
      return {
        result,
        summary: result.ok ? `Focused "${result.title}".` : `Could not focus: ${result.message ?? 'unknown'}.`,
        verification: result.verification
      }
    }
    case 'close_window': {
      const result = await ctx.desktop.closeWindow(windowTarget(a))
      return {
        result,
        summary: result.ok ? 'The window closed.' : `Could not close: ${result.message ?? 'still running'}.`,
        verification: result.verification
      }
    }
    case 'inspect_window_ui': {
      const inspection = await ctx.computer.inspectWindow(windowTarget(a))
      return {
        result: {
          windowTitle: inspection.windowTitle,
          processId: inspection.processId,
          totalElements: inspection.totalElements,
          truncated: inspection.truncated,
          elements: inspection.elements
        },
        summary: inspection.ok
          ? `Found ${inspection.elements.length} interactive element(s) in "${inspection.windowTitle}".`
          : inspection.message ?? 'Could not inspect the window.',
        verification: {
          verified: inspection.ok && inspection.elements.length > 0,
          note: inspection.ok
            ? `${inspection.elements.length} element(s) read from the UI Automation tree.`
            : inspection.message ?? 'No elements were read.',
          check: 'uia'
        }
      }
    }
    case 'interact_with_window_element': {
      const action = asString(a.action, 'invoke') as Parameters<ComputerUseService['interact']>[2]
      const result = await ctx.computer.interact(windowTarget(a), Number(a.elementId), action, asString(a.value))
      return {
        result,
        summary: result.ok
          ? `${action} on element ${a.elementId}${result.usedPattern ? ` via ${result.usedPattern}` : ''}.`
          : result.message ?? 'The interaction did not run.',
        verification: result.verification
      }
    }
    case 'clipboard_bridge': {
      const action = asString(a.action, 'read') as 'read' | 'write' | 'paste_text'
      const result = await ctx.computer.clipboardBridge({
        action,
        text: typeof a.text === 'string' ? a.text : undefined,
        targetWindow: a.targetWindow !== undefined ? asString(a.targetWindow) : undefined,
        keys: typeof a.keys === 'string' ? a.keys : undefined
      })
      return {
        result,
        summary: result.ok ? `Clipboard ${action} completed.` : result.message ?? 'Clipboard operation failed.',
        verification: result.verification
      }
    }
    case 'capture_window_screenshot': {
      const result = await ctx.computer.captureScreenshot({
        target: a.window !== undefined || a.processId !== undefined ? windowTarget(a) : undefined,
        annotate: a.annotate === true,
        screen: a.screen === true
      })
      return {
        result,
        summary: result.ok ? `Captured ${result.width}×${result.height} to ${result.path}${result.annotated ? ' (annotated)' : ''}.` : result.message ?? 'Capture failed.',
        verification: {
          verified: Boolean(result.ok && result.path),
          note: result.ok ? `PNG written to ${result.path}.` : result.message ?? 'No image was produced.',
          check: 'fs.stat'
        }
      }
    }
    case 'create_or_edit_office_document': {
      const blocks = Array.isArray(a.blocks)
        ? (a.blocks as Array<Record<string, unknown>>).map((b) => ({
            type: asString(b.type, 'paragraph') as 'title' | 'heading' | 'paragraph' | 'bullet' | 'table' | 'pagebreak',
            text: typeof b.text === 'string' ? b.text : undefined,
            level: asNumber(b.level),
            rows: Array.isArray(b.rows)
              ? (b.rows as unknown[]).map((r) => (Array.isArray(r) ? r.map((c) => String(c)) : [String(r)]))
              : undefined
          }))
        : []
      const sheets = Array.isArray(a.sheets)
        ? (a.sheets as Array<Record<string, unknown>>).map((s) => ({
            name: asString(s.name, 'Sheet1'),
            rows: Array.isArray(s.rows)
              ? (s.rows as unknown[]).map((r) => (Array.isArray(r) ? r.map((c) => String(c)) : [String(r)]))
              : []
          }))
        : []
      const result = await ctx.desktop.createDocument({
        app: asString(a.app, 'word') === 'excel' ? 'excel' : 'word',
        path: asString(a.path),
        title: typeof a.title === 'string' ? a.title : undefined,
        blocks,
        sheets
      })
      return {
        result,
        summary: result.ok
          ? `Created ${result.path} with ${result.engine}${result.message ? ` — ${result.message}` : ''}.`
          : `Could not create the document: ${result.message ?? 'unknown error'}.`,
        verification: result.verification
      }
    }

    // ------------------------------------------------------------- browser
    case 'browser_navigate': {
      const state = await ctx.browser.navigate(asString(a.url))
      return {
        result: state,
        summary: state.error ? `Navigation failed: ${state.error}` : `Loading ${state.url}.`,
        verification: {
          verified: !state.error && Boolean(state.url),
          note: state.error ?? `The Browser panel is showing ${state.url}.`,
          check: 'dom'
        }
      }
    }
    case 'browser_read_page': {
      const snapshot = await ctx.browser.readPage()
      return {
        result: snapshot,
        summary: snapshot.ok
          ? `Read "${snapshot.title}" with ${snapshot.elements.length} interactive element(s).`
          : snapshot.message ?? 'The page could not be read.',
        verification: {
          verified: snapshot.ok,
          note: snapshot.ok ? `Page text and ${snapshot.elements.length} elements read from the DOM.` : snapshot.message ?? 'No page.',
          check: 'dom'
        }
      }
    }
    case 'browser_interact': {
      const target = a.elementId !== undefined ? Number(a.elementId) : asString(a.selector)
      const action = asString(a.action, 'click') as 'click' | 'type' | 'press'
      const result = await ctx.browser.interact(target, action, asString(a.value))
      const after = await ctx.browser.readPage()
      return {
        result: { ...result, page: { url: after.url, title: after.title, elements: after.elements.length } },
        summary: result.ok ? `${action} on ${result.element ?? target} in the Browser panel.` : result.message ?? 'The interaction failed.',
        verification: {
          verified: result.ok,
          note: result.ok ? `The DOM accepted the ${action}; the page is now at ${after.url}.` : result.message ?? 'Not applied.',
          check: 'dom'
        }
      }
    }
    case 'browser_screenshot': {
      const shot = await ctx.browser.screenshot()
      return {
        result: shot,
        summary: shot.ok ? `Captured the Browser panel (${shot.width}×${shot.height}).` : shot.message ?? 'Capture failed.',
        verification: {
          verified: Boolean(shot.ok && shot.path),
          note: shot.ok ? `PNG written to ${shot.path}.` : shot.message ?? 'No image.',
          check: 'fs.stat'
        }
      }
    }

    default:
      throw new PathError(`Unknown tool: ${name}`, 'unknown_tool')
  }
}

function countNodes(nodes: { children?: unknown[] }[]): number {
  let n = nodes.length
  for (const node of nodes) {
    if (Array.isArray(node.children)) n += countNodes(node.children as { children?: unknown[] }[])
  }
  return n
}

export function toolByName(name: string): ToolDefinition | undefined {
  return TOOL_DEFINITIONS.find((t) => t.name === name)
}

/** Shared `fs.stat` proof used by the file tools. */
export function verifyFile(absPath: string): ToolVerification {
  try {
    const stat = fs.statSync(absPath)
    if (!stat.isFile()) {
      return { verified: false, note: `${absPath} is not a regular file.`, check: 'fs.stat', checkedAt: Date.now() }
    }
    if (stat.size === 0) {
      return { verified: false, note: `${absPath} exists but is empty.`, check: 'fs.stat', checkedAt: Date.now() }
    }
    return {
      verified: true,
      note: `${stat.size} bytes at ${absPath} (modified ${new Date(stat.mtimeMs).toISOString()}).`,
      check: 'fs.stat',
      checkedAt: Date.now()
    }
  } catch {
    return { verified: false, note: `No file exists at ${absPath}.`, check: 'fs.stat', checkedAt: Date.now() }
  }
}

function statSafe(absPath: string): fs.Stats | null {
  try {
    return fs.statSync(absPath)
  } catch {
    return null
  }
}

/** Only leaf secrets are protected broadly here; the registry does the rest. */
function isSensitivePathForDelete(absPath: string): boolean {
  return /(^|[\\/])\.env(\.|$)|\.(pem|key)$|id_rsa|id_ed25519/i.test(path.basename(absPath))
}
