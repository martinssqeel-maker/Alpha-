import { randomUUID } from 'node:crypto'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { getLogger } from './logger'
import { safeResolve } from './pathGuard'
import type { ProjectService } from './projectService'
import type { PermissionService } from './permissionService'
import type { TerminalEvent } from '@shared/types'

const MAX_STREAM_BYTES = 512 * 1024

const DESTRUCTIVE_PATTERNS: RegExp[] = [
  /\brm\s+-rf?\b/i,
  /\brmdir\s+\/s/i,
  /\bdel\s+\/[fsq]/i,
  /\bformat\b/i,
  /\bmkfs\b/i,
  /\bdiskpart\b/i,
  /\bshutdown\b/i,
  /\breboot\b/i,
  /\b:\(\)\s*\{/,
  /\bdd\s+if=/i,
  /\bchmod\s+-R\s+777\s+\//i,
  />\s*\/dev\/sd/i
]

const INSTALL_PATTERNS: RegExp[] = [
  /\bnpm\s+(install|i|ci|add)\b/i,
  /\bpnpm\s+(install|i|add)\b/i,
  /\byarn\s+(add|install)\b/i,
  /\bbun\s+(install|add)\b/i,
  /\bpip\s+install\b/i,
  /\bpip3\s+install\b/i,
  /\bpython\s+-m\s+pip\s+install\b/i,
  /\bpoetry\s+add\b/i,
  /\bcargo\s+install\b/i,
  /\bgo\s+(get|install)\b/i,
  /\bcomposer\s+require\b/i,
  /\bapt(-get)?\s+install\b/i,
  /\bchoco\s+install\b/i,
  /\bwinget\s+install\b/i,
  /\bbrew\s+install\b/i,
  /\bdotnet\s+add\s+package\b/i
]

const NETWORK_PATTERNS: RegExp[] = [
  /\bcurl\b/i,
  /\bwget\b/i,
  /\bgit\s+clone\b/i,
  /\bgit\s+push\b/i,
  /\bgit\s+fetch\b/i,
  /\bgit\s+pull\b/i,
  /\bnc\b/i,
  /\bssh\b/i
]

export interface CommandAssessment {
  destructive: boolean
  packageInstall: boolean
  network: boolean
  reason: string
}

export interface TerminalRunInput {
  projectId: string
  command: string
  cwd?: string
  timeoutMs?: number
  purpose?: string
  approved?: boolean
}

export interface TerminalRunResult {
  runId: string
  approved: boolean
  requiresApproval?: boolean
  approvalId?: string
  command: string
  cwd: string
  reason: string
}

export function assessCommand(command: string): CommandAssessment {
  const destructive = DESTRUCTIVE_PATTERNS.some((re) => re.test(command))
  const packageInstall = INSTALL_PATTERNS.some((re) => re.test(command))
  const network = NETWORK_PATTERNS.some((re) => re.test(command))
  const reasons: string[] = []
  if (destructive) reasons.push('potentially destructive')
  if (packageInstall) reasons.push('installs packages (network)')
  else if (network) reasons.push('uses the network')
  return {
    destructive,
    packageInstall,
    network,
    reason: reasons.length ? 'Command is ' + reasons.join(' and ') + '.' : 'Standard development command.'
  }
}

interface ActiveRun {
  child: ChildProcessWithoutNullStreams | null
  cancelled: boolean
  timer: NodeJS.Timeout | null
}

export class TerminalService {
  private runs = new Map<string, ActiveRun>()

  constructor(
    private projects: ProjectService,
    private permissions: PermissionService
  ) {}

  assess(command: string): CommandAssessment {
    return assessCommand(command)
  }

  run(input: TerminalRunInput, emit: (e: TerminalEvent) => void): TerminalRunResult {
    const project = this.projects.resolveProject(input.projectId)
    const root = project.rootPath
    let cwd = root
    if (input.cwd) {
      cwd = safeResolve(root, input.cwd)
    }
    const command = input.command.trim()
    const assessment = assessCommand(command)

    const key = assessment.packageInstall ? 'packageInstall' : 'terminal'
    const decision = this.permissions.resolve(key)
    const needsApproval =
      decision === 'deny' ||
      assessment.destructive ||
      (decision === 'ask' && (assessment.packageInstall || assessment.network || true))

    if (!input.approved && (decision === 'deny' || decision === 'ask' || assessment.destructive)) {
      if (decision === 'deny') {
        return {
          runId: '',
          approved: false,
          requiresApproval: false,
          command,
          cwd,
          reason: 'Terminal commands are disabled by the current permission mode/settings.'
        }
      }
      return {
        runId: '',
        approved: false,
        requiresApproval: true,
        approvalId: randomUUID(),
        command,
        cwd,
        reason: assessment.reason
      }
    }

    const runId = randomUUID()
    this.start(runId, command, cwd, input.timeoutMs ?? 120000, emit)
    return { runId, approved: true, command, cwd, reason: assessment.reason }
  }

  private start(
    runId: string,
    command: string,
    cwd: string,
    timeoutMs: number,
    emit: (e: TerminalEvent) => void
  ): void {
    getLogger().info('terminal', `run ${runId}: ${command} (cwd=${cwd})`)
    emit({ type: 'start', runId, command, cwd })
    let child: ChildProcessWithoutNullStreams
    try {
      child = spawn(command, {
        cwd,
        shell: true,
        windowsHide: true,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
      })
    } catch (e) {
      emit({ type: 'error', runId, error: (e as Error).message })
      return
    }
    const started = Date.now()
    const state: ActiveRun = { child, cancelled: false, timer: null }
    this.runs.set(runId, state)

    let outBytes = 0
    let errBytes = 0
    child.stdout.on('data', (data: Buffer) => {
      if (outBytes > MAX_STREAM_BYTES) return
      outBytes += data.length
      emit({ type: 'stdout', runId, data: data.toString('utf8') })
      if (outBytes > MAX_STREAM_BYTES) emit({ type: 'stderr', runId, data: '\n[output truncated]\n' })
    })
    child.stderr.on('data', (data: Buffer) => {
      if (errBytes > MAX_STREAM_BYTES) return
      errBytes += data.length
      emit({ type: 'stderr', runId, data: data.toString('utf8') })
    })
    child.on('error', (err) => {
      emit({ type: 'error', runId, error: err.message })
    })
    child.on('close', (code, signal) => {
      if (state.timer) clearTimeout(state.timer)
      this.runs.delete(runId)
      emit({
        type: 'exit',
        runId,
        code,
        signal: signal ?? undefined,
        durationMs: Date.now() - started
      })
    })

    state.timer = setTimeout(() => {
      if (this.runs.has(runId)) {
        state.cancelled = true
        try {
          child.kill('SIGTERM')
        } catch {
          /* ignore */
        }
        emit({ type: 'stderr', runId, data: '\n[command timed out and was terminated]\n' })
      }
    }, timeoutMs)
  }

  cancel(runId: string): boolean {
    const state = this.runs.get(runId)
    if (!state) return false
    state.cancelled = true
    try {
      state.child?.kill()
    } catch {
      /* ignore */
    }
    this.runs.delete(runId)
    return true
  }

  /** Run a command and collect its full output (used by the agent tool layer). */
  runCollect(
    command: string,
    cwd: string,
    timeoutMs = 120000,
    onData?: (stream: 'stdout' | 'stderr', data: string) => void
  ): Promise<{ code: number | null; signal?: string; stdout: string; stderr: string; durationMs: number }> {
    return new Promise((resolve) => {
      const started = Date.now()
      let child: ChildProcessWithoutNullStreams
      try {
        child = spawn(command, {
          cwd,
          shell: true,
          windowsHide: true,
          env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
        })
      } catch (e) {
        resolve({ code: -1, stdout: '', stderr: (e as Error).message, durationMs: 0 })
        return
      }
      let stdout = ''
      let stderr = ''
      let outBytes = 0
      let errBytes = 0
      const timer = setTimeout(() => {
        try {
          child.kill()
        } catch {
          /* ignore */
        }
        stderr += '\n[command timed out and was terminated]\n'
      }, timeoutMs)
      child.stdout.on('data', (d: Buffer) => {
        if (outBytes < MAX_STREAM_BYTES) {
          stdout += d.toString('utf8')
          outBytes += d.length
          onData?.('stdout', d.toString('utf8'))
        }
      })
      child.stderr.on('data', (d: Buffer) => {
        if (errBytes < MAX_STREAM_BYTES) {
          stderr += d.toString('utf8')
          errBytes += d.length
          onData?.('stderr', d.toString('utf8'))
        }
      })
      child.on('error', (err) => {
        clearTimeout(timer)
        resolve({ code: -1, stdout, stderr: stderr + err.message, durationMs: Date.now() - started })
      })
      child.on('close', (code, signal) => {
        clearTimeout(timer)
        resolve({
          code,
          signal: signal ?? undefined,
          stdout,
          stderr,
          durationMs: Date.now() - started
        })
      })
    })
  }
}
