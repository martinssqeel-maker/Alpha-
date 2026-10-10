import { execFile } from 'node:child_process'
import type { DiffFile, GitStatus } from '@shared/types'
import { getLogger } from './logger'
import type { ProjectService } from './projectService'

interface GitResult {
  ok: boolean
  code: number | null
  stdout: string
  stderr: string
  missing?: boolean
}

function gitRun(cwd: string, args: string[], timeout = 30000): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile(
      'git',
      args,
      { cwd, timeout, windowsHide: true, maxBuffer: 10 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } },
      (error, stdout, stderr) => {
        if (error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
          resolve({ ok: false, code: null, stdout: '', stderr: 'git is not installed or not on PATH', missing: true })
          return
        }
        const code = error && 'code' in error ? ((error as { code?: number }).code ?? 1) : 0
        resolve({ ok: !error, code, stdout: stdout ?? '', stderr: stderr ?? '' })
      }
    )
  })
}

export class GitService {
  private availability: { available: boolean; version?: string } | null = null

  constructor(private projects: ProjectService) {}

  async checkAvailable(): Promise<{ available: boolean; version?: string }> {
    if (this.availability) return this.availability
    const res = await gitRun(process.cwd(), ['--version'])
    this.availability = res.missing
      ? { available: false }
      : { available: true, version: res.stdout.trim() }
    return this.availability
  }

  private root(projectId: string): string {
    return this.projects.resolveRoot(projectId)
  }

  async status(projectId: string): Promise<GitStatus> {
    const cwd = this.root(projectId)
    const empty: GitStatus = { isRepo: false, files: [], remotes: [], clean: true }
    const inside = await gitRun(cwd, ['rev-parse', '--is-inside-work-tree'])
    if (!inside.ok || inside.stdout.trim() !== 'true') {
      return empty
    }
    const branchRes = await gitRun(cwd, ['status', '--porcelain=v1', '-b', '--untracked-files=all'])
    if (!branchRes.ok) {
      return { ...empty, isRepo: true, error: branchRes.stderr || 'git status failed' }
    }
    let branch: string | undefined
    let upstream: string | undefined
    let ahead = 0
    let behind = 0
    const files: DiffFile[] = []
    const lines = branchRes.stdout.split(/\r?\n/).filter((l) => l.length > 0)
    for (const line of lines) {
      if (line.startsWith('## ')) {
        const header = line.slice(3)
        const [branchPart, trackPart] = header.split('...')
        branch = branchPart.trim().split(' ')[0]
        if (trackPart) {
          upstream = trackPart.split(' ')[0]
          const a = /ahead (\d+)/.exec(trackPart)
          const b = /behind (\d+)/.exec(trackPart)
          ahead = a ? Number(a[1]) : 0
          behind = b ? Number(b[1]) : 0
        }
        continue
      }
      const code = line.slice(0, 2)
      const filePath = line.slice(3)
      files.push({ path: filePath, status: classify(code), additions: 0, deletions: 0 })
    }
    const remotesRes = await gitRun(cwd, ['remote', '-v'])
    const remotes = parseRemotes(remotesRes.stdout)
    return {
      isRepo: true,
      branch,
      upstream,
      ahead,
      behind,
      files,
      remotes,
      clean: files.length === 0
    }
  }

  async diff(projectId: string, filePath?: string, staged = false): Promise<string> {
    const cwd = this.root(projectId)
    const args = ['diff', '--no-color']
    if (staged) args.push('--staged')
    if (filePath) args.push('--', filePath)
    const res = await gitRun(cwd, args, 60000)
    return res.stdout
  }

  async log(projectId: string, limit = 20): Promise<{ hash: string; subject: string; author: string; date: string }[]> {
    const cwd = this.root(projectId)
    const res = await gitRun(cwd, [
      'log',
      `-n${Math.min(Math.max(limit, 1), 100)}`,
      '--pretty=format:%H%x1f%s%x1f%an%x1f%aI'
    ])
    if (!res.ok) return []
    return res.stdout
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [hash, subject, author, date] = line.split('\x1f')
        return { hash, subject, author, date }
      })
  }

  async branches(projectId: string): Promise<{ local: string[]; remote: string[]; current?: string }> {
    const cwd = this.root(projectId)
    const res = await gitRun(cwd, ['branch', '-a', '--no-color'])
    const local: string[] = []
    const remote: string[] = []
    let current: string | undefined
    if (!res.ok) return { local, remote }
    for (const raw of res.stdout.split('\n')) {
      const line = raw.trimEnd()
      if (!line) continue
      const isCurrent = line.startsWith('*')
      const name = line.replace(/^\*?\s*/, '').trim()
      if (name.startsWith('remotes/')) remote.push(name.replace('remotes/', ''))
      else {
        local.push(name)
        if (isCurrent) current = name
      }
    }
    return { local, remote, current }
  }

  async remotes(projectId: string): Promise<{ name: string; url: string }[]> {
    const res = await gitRun(this.root(projectId), ['remote', '-v'])
    return parseRemotes(res.stdout)
  }

  async stage(projectId: string, files: string[]): Promise<{ ok: boolean; message?: string }> {
    if (!files.length) return { ok: false, message: 'No files specified' }
    const res = await gitRun(this.root(projectId), ['add', '--', ...files])
    return res.ok ? { ok: true } : { ok: false, message: res.stderr }
  }

  async unstage(projectId: string, files: string[]): Promise<{ ok: boolean; message?: string }> {
    if (!files.length) return { ok: false, message: 'No files specified' }
    const res = await gitRun(this.root(projectId), ['reset', 'HEAD', '--', ...files])
    return res.ok ? { ok: true } : { ok: false, message: res.stderr }
  }

  async init(projectId: string): Promise<{ ok: boolean; message?: string }> {
    const res = await gitRun(this.root(projectId), ['init'])
    return res.ok ? { ok: true } : { ok: false, message: res.stderr }
  }

  async createBranch(projectId: string, name: string, checkout = true): Promise<{ ok: boolean; message?: string }> {
    if (!/^[\w./-]+$/.test(name)) return { ok: false, message: 'Invalid branch name' }
    const args = ['branch', name]
    const res = await gitRun(this.root(projectId), args)
    if (!res.ok) return { ok: false, message: res.stderr }
    if (checkout) return this.checkout(projectId, name)
    return { ok: true }
  }

  async checkout(projectId: string, name: string): Promise<{ ok: boolean; message?: string }> {
    const res = await gitRun(this.root(projectId), ['checkout', name])
    return res.ok ? { ok: true } : { ok: false, message: res.stderr }
  }

  async setRemote(projectId: string, name: string, url: string): Promise<{ ok: boolean; message?: string }> {
    const cwd = this.root(projectId)
    const existing = await this.remotes(projectId)
    const has = existing.some((r) => r.name === name)
    const res = has
      ? await gitRun(cwd, ['remote', 'set-url', name, url])
      : await gitRun(cwd, ['remote', 'add', name, url])
    if (res.ok) return { ok: true }
    if (has) {
      const add = await gitRun(cwd, ['remote', 'add', name, url])
      return add.ok ? { ok: true } : { ok: false, message: add.stderr }
    }
    return { ok: false, message: res.stderr }
  }

  async commit(
    projectId: string,
    message: string,
    files?: string[]
  ): Promise<{ ok: boolean; commit?: string; message?: string }> {
    const cwd = this.root(projectId)
    if (files && files.length) {
      const add = await gitRun(cwd, ['add', '--', ...files])
      if (!add.ok) return { ok: false, message: add.stderr }
    }
    const res = await gitRun(cwd, ['commit', '-m', message])
    if (!res.ok) return { ok: false, message: res.stderr || res.stdout }
    const hash = await gitRun(cwd, ['rev-parse', 'HEAD'])
    return { ok: true, commit: hash.stdout.trim() }
  }

  async push(projectId: string): Promise<{ ok: boolean; message?: string }> {
    const cwd = this.root(projectId)
    const remotes = await this.remotes(projectId)
    if (!remotes.length) {
      return { ok: false, message: 'No git remote configured. Add a remote or connect GitHub first.' }
    }
    // Never force push.
    const res = await gitRun(cwd, ['push'], 120000)
    if (res.ok) return { ok: true, message: res.stderr.trim() || 'Pushed.' }
    return { ok: false, message: res.stderr || 'Push failed' }
  }

  async pull(projectId: string): Promise<{ ok: boolean; message?: string; conflict?: boolean }> {
    const cwd = this.root(projectId)
    const res = await gitRun(cwd, ['pull', '--no-rebase'], 120000)
    if (res.ok) return { ok: true, message: res.stdout }
    const conflict = /conflict/i.test(res.stderr + res.stdout)
    return { ok: false, message: res.stderr || res.stdout, conflict }
  }

  async fetch(projectId: string): Promise<{ ok: boolean; message?: string }> {
    const res = await gitRun(this.root(projectId), ['fetch', '--all'], 120000)
    return res.ok ? { ok: true } : { ok: false, message: res.stderr }
  }

  async currentBranch(projectId: string): Promise<string | undefined> {
    const res = await gitRun(this.root(projectId), ['rev-parse', '--abbrev-ref', 'HEAD'])
    return res.ok ? res.stdout.trim() : undefined
  }
}

function classify(code: string): DiffFile['status'] {
  if (code === '??') return 'untracked'
  if (code.includes('A')) return 'added'
  if (code.includes('D')) return 'deleted'
  if (code.includes('R')) return 'renamed'
  return 'modified'
}

function parseRemotes(stdout: string): { name: string; url: string }[] {
  const map = new Map<string, string>()
  for (const line of stdout.split('\n')) {
    const match = /^(\S+)\s+(\S+)/.exec(line.trim())
    if (match) map.set(match[1], match[2])
  }
  return [...map.entries()].map(([name, url]) => ({ name, url }))
}

export function redactGitError(msg: string): string {
  return msg.replace(/https:\/\/[^@]*@/g, 'https://***@')
}
