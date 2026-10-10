import { execFile } from 'node:child_process'
import { getLogger } from './logger'
import type { SecretStore } from './secrets'

const GITHUB_TOKEN_REF = 'github:token'

interface GhResult {
  ok: boolean
  stdout: string
  stderr: string
  missing?: boolean
}

function ghRun(args: string[], timeout = 30000): Promise<GhResult> {
  return new Promise((resolve) => {
    execFile('gh', args, { timeout, windowsHide: true }, (error, stdout, stderr) => {
      if (error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
        resolve({ ok: false, stdout: '', stderr: 'gh not installed', missing: true })
        return
      }
      resolve({ ok: !error, stdout: stdout ?? '', stderr: stderr ?? '' })
    })
  })
}

function apiHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'Alpha-AI-Workspace'
  }
}

export interface GithubRepo {
  fullName: string
  name: string
  private: boolean
  cloneUrl: string
  defaultBranch: string
  updatedAt: string
}

export class GithubService {
  constructor(private secrets: SecretStore) {}

  hasToken(): boolean {
    return this.secrets.has(GITHUB_TOKEN_REF)
  }

  private token(): string | null {
    return this.secrets.get(GITHUB_TOKEN_REF)
  }

  async ghAvailable(): Promise<boolean> {
    const res = await ghRun(['--version'])
    return !res.missing && res.ok
  }

  async status(): Promise<{ connected: boolean; login?: string; method?: string; scopes?: string[]; message?: string }> {
    const token = this.token()
    if (token) {
      try {
        const res = await fetch('https://api.github.com/user', { headers: apiHeaders(token) })
        if (res.status === 401) {
          return { connected: false, method: 'token', message: 'Stored token is invalid or expired.' }
        }
        if (!res.ok) {
          return { connected: false, method: 'token', message: `GitHub API returned ${res.status}.` }
        }
        const user = (await res.json()) as { login: string }
        const scopes = (res.headers.get('x-oauth-scopes') ?? '')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
        return { connected: true, login: user.login, method: 'token', scopes }
      } catch (e) {
        return { connected: false, method: 'token', message: `Network error: ${(e as Error).message}` }
      }
    }
    if (await this.ghAvailable()) {
      const res = await ghRun(['api', 'user', '--jq', '.login'])
      if (res.ok && res.stdout.trim()) {
        return { connected: true, login: res.stdout.trim(), method: 'gh', scopes: [] }
      }
      return {
        connected: false,
        method: 'gh',
        message: 'GitHub CLI (gh) is installed but not authenticated. Run `gh auth login` in a terminal.'
      }
    }
    return {
      connected: false,
      message:
        'Not connected. Add a fine-grained personal access token in Settings, or install the GitHub CLI (gh) and run `gh auth login`.'
    }
  }

  async connect(input: {
    token?: string
    method?: 'token' | 'device'
  }): Promise<{ ok: boolean; login?: string; message?: string }> {
    if (input.method === 'device') {
      return {
        ok: false,
        message:
          'Device flow requires an OAuth client ID configured for this app, which is not bundled. Use a personal access token or the GitHub CLI instead.'
      }
    }
    if (!input.token) return { ok: false, message: 'No token provided.' }
    try {
      const res = await fetch('https://api.github.com/user', { headers: apiHeaders(input.token) })
      if (!res.ok) {
        return { ok: false, message: res.status === 401 ? 'Invalid token.' : `GitHub API returned ${res.status}.` }
      }
      const user = (await res.json()) as { login: string }
      this.secrets.set(GITHUB_TOKEN_REF, input.token)
      getLogger().info('github', `connected as ${user.login}`)
      return { ok: true, login: user.login }
    } catch (e) {
      return { ok: false, message: `Network error: ${(e as Error).message}` }
    }
  }

  disconnect(): void {
    this.secrets.delete(GITHUB_TOKEN_REF)
  }

  async repos(query?: string): Promise<GithubRepo[]> {
    const token = this.token()
    if (token) {
      try {
        const url = query
          ? `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&per_page=50`
          : 'https://api.github.com/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member'
        const res = await fetch(url, { headers: apiHeaders(token) })
        if (!res.ok) throw new Error(`GitHub API ${res.status}`)
        const body = (await res.json()) as
          | { items?: RawRepo[]; repositories?: RawRepo[] }
          | RawRepo[]
        const list = Array.isArray(body) ? body : (body.items ?? body.repositories ?? [])
        return list.map(mapRepo)
      } catch (e) {
        getLogger().warn('github', `repo list via token failed: ${(e as Error).message}`)
      }
    }
    if (await this.ghAvailable()) {
      const args = query
        ? ['repo', 'list', '--limit', '100', '--json', 'nameWithOwner,isPrivate,url,defaultBranchRef,updatedAt', '--search', query]
        : ['repo', 'list', '--limit', '100', '--json', 'nameWithOwner,isPrivate,url,defaultBranchRef,updatedAt']
      const res = await ghRun(args)
      if (res.ok) {
        try {
          const arr = JSON.parse(res.stdout) as {
            nameWithOwner: string
            isPrivate: boolean
            url: string
            defaultBranchRef?: { name?: string }
            updatedAt?: string
          }[]
          return arr.map((r) => ({
            fullName: r.nameWithOwner,
            name: r.nameWithOwner.split('/').pop() ?? r.nameWithOwner,
            private: r.isPrivate,
            cloneUrl: r.url.endsWith('.git') ? r.url : r.url + '.git',
            defaultBranch: r.defaultBranchRef?.name ?? 'main',
            updatedAt: r.updatedAt ?? ''
          }))
        } catch {
          /* fallthrough */
        }
      }
    }
    throw new Error('GitHub is not connected. Add a token or authenticate the GitHub CLI.')
  }

  async createRepo(input: {
    name: string
    description?: string
    private?: boolean
  }): Promise<{ ok: boolean; fullName?: string; cloneUrl?: string; message?: string }> {
    const token = this.token()
    if (token) {
      try {
        const res = await fetch('https://api.github.com/user/repos', {
          method: 'POST',
          headers: apiHeaders(token),
          body: JSON.stringify({
            name: input.name,
            description: input.description ?? '',
            private: input.private ?? true,
            auto_init: false
          })
        })
        if (!res.ok) {
          const text = await res.text()
          return { ok: false, message: `GitHub API ${res.status}: ${text.slice(0, 300)}` }
        }
        const repo = (await res.json()) as { full_name: string; clone_url: string }
        return { ok: true, fullName: repo.full_name, cloneUrl: repo.clone_url }
      } catch (e) {
        return { ok: false, message: (e as Error).message }
      }
    }
    if (await this.ghAvailable()) {
      const args = ['repo', 'create', input.name, input.private ? '--private' : '--public']
      if (input.description) args.push('--description', input.description)
      const res = await ghRun(args)
      if (res.ok) return { ok: true, fullName: res.stdout.trim() }
      return { ok: false, message: res.stderr }
    }
    return { ok: false, message: 'GitHub is not connected.' }
  }
}

interface RawRepo {
  full_name: string
  name: string
  private: boolean
  clone_url: string
  default_branch?: string
  updated_at?: string
}

function mapRepo(r: RawRepo): GithubRepo {
  return {
    fullName: r.full_name,
    name: r.name,
    private: r.private,
    cloneUrl: r.clone_url,
    defaultBranch: r.default_branch ?? 'main',
    updatedAt: r.updated_at ?? ''
  }
}
