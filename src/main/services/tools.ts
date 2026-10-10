import type { ToolDefinition } from '@shared/types'
import type { EditService } from './editService'
import type { GitService } from './git'
import { PathError } from './pathGuard'
import type { PermissionService } from './permissionService'
import type { ProjectService } from './projectService'
import type { TerminalService } from './terminal'

export interface ToolContext {
  projectId: string | null
  projects: ProjectService
  edits: EditService
  git: GitService
  terminal: TerminalService
  permissions: PermissionService
}

export interface ToolExecution {
  result: unknown
  summary: string
}

export const READ_TOOLS = new Set([
  'list_project_files',
  'search_project',
  'read_project_file',
  'propose_file_patch',
  'get_git_status',
  'get_git_diff'
])

export const TOOL_DEFINITIONS: ToolDefinition[] = [
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
      'Propose a change to a file. For new files or whole-file rewrites use kind="write" with the full new content in "after". For targeted edits use kind="patch" with a unified diff in "patch". This does NOT save anything; it returns a diff for review and a proposalId.',
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
  {
    name: 'run_approved_command',
    description:
      'Run a development command (tests, build, lint, formatter) in the project directory and return its output. Requires user approval.',
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
  }
]

function requireProject(ctx: ToolContext): string {
  if (!ctx.projectId) throw new PathError('No project is open. Ask the user to open a project folder.', 'no_project')
  return ctx.projectId
}

function asString(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback
}

export async function executeTool(
  name: string,
  args: unknown,
  ctx: ToolContext
): Promise<ToolExecution> {
  const a = (args ?? {}) as Record<string, unknown>
  switch (name) {
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
        summary: `Proposed ${kind} for ${proposal.path}${proposal.stale ? ' (file changed on disk!)' : ''}.`
      }
    }
    case 'apply_approved_patch': {
      requireProject(ctx)
      const res = ctx.edits.apply(asString(a.proposalId))
      if (!res.ok) throw new PathError(res.message || 'Could not apply patch', 'apply_failed')
      return { result: res, summary: `Applied change to ${res.path}.` }
    }
    case 'get_git_status': {
      const projectId = requireProject(ctx)
      const status = await ctx.git.status(projectId)
      return { result: status, summary: status.isRepo ? `Branch ${status.branch}, ${status.files.length} changed file(s).` : 'Not a Git repository.' }
    }
    case 'get_git_diff': {
      const projectId = requireProject(ctx)
      const patch = await ctx.git.diff(projectId, a.path ? asString(a.path) : undefined, Boolean(a.staged))
      return { result: { patch: patch.slice(0, 15000) }, summary: `Generated diff (${patch.length} chars).` }
    }
    case 'run_approved_command': {
      const projectId = requireProject(ctx)
      const command = asString(a.command)
      if (!command) throw new PathError('command is required', 'invalid')
      const cwd = ctx.projects.resolveRoot(projectId)
      const out = await ctx.terminal.runCollect(command, cwd, 120000)
      return {
        result: {
          exitCode: out.code,
          durationMs: out.durationMs,
          stdout: out.stdout.slice(-8000),
          stderr: out.stderr.slice(-8000)
        },
        summary: `\`${command}\` exited with code ${out.code} in ${out.durationMs}ms.`
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
