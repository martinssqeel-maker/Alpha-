import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { GitHubOAuthService, loadClientId } from '../src/main/services/githubOAuth'
import { GithubService } from '../src/main/services/github'
import { ObfuscationCipher, SecretStore } from '../src/main/services/secrets'

function makeStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alpha-gh-'))
  const secrets = new SecretStore(path.join(dir, 'secrets.enc'), new ObfuscationCipher())
  return { secrets, dir }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

/** Deterministic fetch stub: one scripted response per call, in order. */
function stubFetch(steps: Array<() => Response | Promise<Response>>): typeof fetch {
  let index = 0
  return (async () => {
    const step = steps[index++]
    if (!step) throw new Error('fetch stub exhausted')
    return step()
  }) as unknown as typeof fetch
}

const DEVICE_CODE_STEP = () =>
  jsonResponse({
    device_code: 'device-code-1',
    user_code: 'ABCD-1234',
    verification_uri: 'https://github.com/login/device',
    interval: 5,
    expires_in: 900
  })

const FULL_SESSION_STEP = () =>
  jsonResponse({
    access_token: 'gho_access',
    token_type: 'bearer',
    scope: 'repo',
    expires_in: 28800,
    refresh_token: 'ghr_refresh',
    refresh_token_expires_in: 15897600
  })

const USER_STEP = () => jsonResponse({ login: 'octocat' })

describe('github oauth — client id configuration', () => {
  it('prefers GITHUB_OAUTH_CLIENT_ID', () => {
    expect(loadClientId({ GITHUB_OAUTH_CLIENT_ID: 'Iv1.env' }, [], '/nope', '')).toBe('Iv1.env')
  })

  it('reads clientId from an explicit config file when the env var is absent', () => {
    const { dir } = makeStore()
    const cfg = path.join(dir, 'github-oauth.json')
    fs.writeFileSync(cfg, JSON.stringify({ clientId: 'Iv1.file' }))
    expect(loadClientId({}, [cfg], '/nope', '')).toBe('Iv1.file')
  })

  it('returns null when no client id exists anywhere', () => {
    expect(loadClientId({}, ['/definitely/missing.json'], '/nope', '')).toBeNull()
  })

  it('ignores a malformed config file', () => {
    const { dir } = makeStore()
    const cfg = path.join(dir, 'github-oauth.json')
    fs.writeFileSync(cfg, '{ not json')
    expect(loadClientId({}, [cfg], '/nope', '')).toBeNull()
  })
})

describe('github oauth — device flow start', () => {
  it('refuses to start when no client id is configured', async () => {
    const { secrets } = makeStore()
    const service = new GitHubOAuthService({
      secrets,
      getClientId: () => null,
      fetchImpl: stubFetch([])
    })
    const res = await service.startDeviceFlow()
    expect(res.ok).toBe(false)
    expect(res.message).toContain('not configured')
    expect(service.isConfigured()).toBe(false)
  })

  it('returns a user code, verification URL and interval', async () => {
    const { secrets } = makeStore()
    const service = new GitHubOAuthService({
      secrets,
      getClientId: () => 'Iv1.test',
      fetchImpl: stubFetch([DEVICE_CODE_STEP])
    })
    const res = await service.startDeviceFlow()
    expect(res).toMatchObject({
      ok: true,
      userCode: 'ABCD-1234',
      verificationUri: 'https://github.com/login/device',
      interval: 5,
      expiresIn: 900
    })
    expect(service.hasPending()).toBe(true)
  })

  it('reports a friendly error when GitHub rejects the device code request', async () => {
    const { secrets } = makeStore()
    const service = new GitHubOAuthService({
      secrets,
      getClientId: () => 'Iv1.test',
      fetchImpl: stubFetch([() => jsonResponse({ error: 'unauthorized_client' }, 400)])
    })
    const res = await service.startDeviceFlow()
    expect(res.ok).toBe(false)
    expect(res.message).toContain('unauthorized_client')
  })
})

describe('github oauth — device flow polling', () => {
  it('reports pending then success and stores the token + refresh metadata', async () => {
    const { secrets } = makeStore()
    const service = new GitHubOAuthService({
      secrets,
      getClientId: () => 'Iv1.test',
      fetchImpl: stubFetch([
        DEVICE_CODE_STEP,
        () => jsonResponse({ error: 'authorization_pending' }),
        FULL_SESSION_STEP,
        USER_STEP
      ])
    })
    expect((await service.startDeviceFlow()).ok).toBe(true)

    const pending = await service.pollOnce()
    expect(pending.status).toBe('pending')

    const success = await service.pollOnce()
    expect(success.status).toBe('success')
    expect(success.login).toBe('octocat')
    expect(secrets.get('github:token')).toBe('gho_access')
    expect(secrets.get('github:oauth:refresh')).toBe('ghr_refresh')
    expect(secrets.get('github:oauth:method')).toBe('device')
    expect(service.isSession()).toBe(true)
    expect(await service.getValidAccessToken()).toBe('gho_access')
  })

  it('increases the interval on slow_down', async () => {
    const { secrets } = makeStore()
    const service = new GitHubOAuthService({
      secrets,
      getClientId: () => 'Iv1.test',
      fetchImpl: stubFetch([DEVICE_CODE_STEP, () => jsonResponse({ error: 'slow_down' })])
    })
    await service.startDeviceFlow()
    const res = await service.pollOnce()
    expect(res.status).toBe('slow_down')
    expect(res.interval).toBe(10)
  })

  it('reports denial without storing a token', async () => {
    const { secrets } = makeStore()
    const service = new GitHubOAuthService({
      secrets,
      getClientId: () => 'Iv1.test',
      fetchImpl: stubFetch([DEVICE_CODE_STEP, () => jsonResponse({ error: 'access_denied' })])
    })
    await service.startDeviceFlow()
    const res = await service.pollOnce()
    expect(res.status).toBe('denied')
    expect(secrets.has('github:token')).toBe(false)
    expect(service.hasPending()).toBe(false)
  })

  it('reports expiry when GitHub returns expired_token', async () => {
    const { secrets } = makeStore()
    const service = new GitHubOAuthService({
      secrets,
      getClientId: () => 'Iv1.test',
      fetchImpl: stubFetch([DEVICE_CODE_STEP, () => jsonResponse({ error: 'expired_token' })])
    })
    await service.startDeviceFlow()
    expect((await service.pollOnce()).status).toBe('expired')
  })

  it('reports expiry when the local code lifetime has elapsed', async () => {
    const { secrets } = makeStore()
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1_000_000)
    const service = new GitHubOAuthService({
      secrets,
      getClientId: () => 'Iv1.test',
      fetchImpl: stubFetch([DEVICE_CODE_STEP])
    })
    await service.startDeviceFlow()
    nowSpy.mockReturnValue(1_000_000 + 901_000)
    const res = await service.pollOnce()
    nowSpy.mockRestore()
    expect(res.status).toBe('expired')
  })

  it('errors instead of hanging when no flow is in progress', async () => {
    const { secrets } = makeStore()
    const service = new GitHubOAuthService({
      secrets,
      getClientId: () => 'Iv1.test',
      fetchImpl: stubFetch([])
    })
    const res = await service.pollOnce()
    expect(res.status).toBe('error')
    expect(res.message).toContain('in progress')
  })

  it('stops polling after cancel', async () => {
    const { secrets } = makeStore()
    const service = new GitHubOAuthService({
      secrets,
      getClientId: () => 'Iv1.test',
      fetchImpl: stubFetch([DEVICE_CODE_STEP])
    })
    await service.startDeviceFlow()
    service.cancel()
    expect(service.hasPending()).toBe(false)
    expect((await service.pollOnce()).status).toBe('error')
  })
})

describe('github oauth — token refresh and revocation', () => {
  it('refreshes an expired access token using the refresh token', async () => {
    const { secrets } = makeStore()
    secrets.set('github:token', 'gho_old')
    secrets.set('github:oauth:method', 'device')
    secrets.set('github:oauth:refresh', 'ghr_old')
    secrets.set('github:oauth:expires', String(Date.now() - 1000))
    const service = new GitHubOAuthService({
      secrets,
      getClientId: () => 'Iv1.test',
      fetchImpl: stubFetch([
        () => jsonResponse({ access_token: 'gho_new', expires_in: 28800, refresh_token: 'ghr_new' })
      ])
    })
    expect(await service.getValidAccessToken()).toBe('gho_new')
    expect(secrets.get('github:oauth:refresh')).toBe('ghr_new')
  })

  it('clears the session when the refresh is rejected (revoked)', async () => {
    const { secrets } = makeStore()
    secrets.set('github:token', 'gho_old')
    secrets.set('github:oauth:method', 'device')
    secrets.set('github:oauth:refresh', 'ghr_revoked')
    secrets.set('github:oauth:expires', String(Date.now() - 1000))
    const service = new GitHubOAuthService({
      secrets,
      getClientId: () => 'Iv1.test',
      fetchImpl: stubFetch([() => jsonResponse({ error: 'bad_refresh_token' }, 200)])
    })
    expect(await service.getValidAccessToken()).toBeNull()
    expect(service.isSession()).toBe(false)
    expect(secrets.has('github:token')).toBe(false)
  })

  it('does not attempt a refresh for a plain stored token (PAT)', async () => {
    const { secrets } = makeStore()
    secrets.set('github:token', 'ghp_pat')
    const service = new GitHubOAuthService({
      secrets,
      getClientId: () => 'Iv1.test',
      fetchImpl: stubFetch([])
    })
    expect(service.isSession()).toBe(false)
    expect(await service.getValidAccessToken()).toBeNull()
  })
})

describe('github service — device integration', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('reports method=device when an OAuth session is stored', async () => {
    const { secrets } = makeStore()
    secrets.set('github:token', 'gho_access')
    secrets.set('github:oauth:method', 'device')
    vi.stubGlobal('fetch', stubFetch([USER_STEP]))
    const oauth = new GitHubOAuthService({ secrets, getClientId: () => 'Iv1.test', fetchImpl: stubFetch([]) })
    const github = new GithubService(secrets, oauth)
    const status = await github.status()
    expect(status.connected).toBe(true)
    expect(status.login).toBe('octocat')
    expect(status.method).toBe('device')
  })

  it('starts a device flow through connect({method:"device"})', async () => {
    const { secrets } = makeStore()
    const oauth = new GitHubOAuthService({
      secrets,
      getClientId: () => 'Iv1.test',
      fetchImpl: stubFetch([DEVICE_CODE_STEP])
    })
    const github = new GithubService(secrets, oauth)
    const res = await github.connect({ method: 'device' })
    expect(res.ok).toBe(true)
    const start = await github.startDeviceFlow()
    expect(start.verificationUri).toBe('https://github.com/login/device')
  })

  it('still connects with a personal access token and clears the OAuth marker', async () => {
    const { secrets } = makeStore()
    secrets.set('github:oauth:method', 'device')
    vi.stubGlobal('fetch', stubFetch([USER_STEP]))
    const oauth = new GitHubOAuthService({ secrets, getClientId: () => 'Iv1.test', fetchImpl: stubFetch([]) })
    const github = new GithubService(secrets, oauth)
    const res = await github.connect({ token: 'ghp_pat', method: 'token' })
    expect(res.ok).toBe(true)
    expect(res.login).toBe('octocat')
    expect(secrets.get('github:token')).toBe('ghp_pat')
    expect(oauth.isSession()).toBe(false)
  })

  it('lists repositories with a stored token', async () => {
    const { secrets } = makeStore()
    secrets.set('github:token', 'ghp_pat')
    vi.stubGlobal(
      'fetch',
      stubFetch([
        () =>
          jsonResponse([
            {
              full_name: 'octocat/hello-world',
              name: 'hello-world',
              private: false,
              clone_url: 'https://github.com/octocat/hello-world.git',
              default_branch: 'main',
              updated_at: '2026-01-01T00:00:00Z'
            }
          ])
      ])
    )
    const oauth = new GitHubOAuthService({ secrets, getClientId: () => 'Iv1.test', fetchImpl: stubFetch([]) })
    const github = new GithubService(secrets, oauth)
    const repos = await github.repos()
    expect(repos).toHaveLength(1)
    expect(repos[0].fullName).toBe('octocat/hello-world')
  })

  it('creates a repository with a stored token', async () => {
    const { secrets } = makeStore()
    secrets.set('github:token', 'ghp_pat')
    vi.stubGlobal('fetch', stubFetch([() => jsonResponse({ full_name: 'octocat/new-repo', clone_url: 'https://github.com/octocat/new-repo.git' })]))
    const oauth = new GitHubOAuthService({ secrets, getClientId: () => 'Iv1.test', fetchImpl: stubFetch([]) })
    const github = new GithubService(secrets, oauth)
    const res = await github.createRepo({ name: 'new-repo', private: true })
    expect(res.ok).toBe(true)
    expect(res.fullName).toBe('octocat/new-repo')
  })
})
