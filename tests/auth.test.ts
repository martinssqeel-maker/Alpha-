import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  MIN_PASSWORD_LENGTH,
  hashPassword,
  passwordNeedsRehash,
  passwordProblem,
  verifyPassword
} from '../platform/api/password'
import {
  GITHUB_SIGNIN_SCOPE,
  appCallbackUrl,
  githubAuthUrl,
  githubConfigured,
  providersSummary,
  resolveTarget,
  signState,
  toGithubIdentity,
  verifyState
} from '../platform/api/oauth'
import { assetHostAllowed, gatingProblem, normalizeRelease } from '../platform/api/releases'

beforeAll(() => {
  process.env.AUTH_JWT_SECRET = 'unit-test-secret-value-that-is-long-enough-32'
  process.env.WEB_ACCOUNT_URL = 'https://alpha-website-lime.vercel.app'
  process.env.ALLOWED_ORIGINS = 'https://alpha-website-lime.vercel.app,http://localhost:3000'
  delete process.env.AUTH_APP_SCHEME
})

afterAll(() => {
  delete process.env.AUTH_JWT_SECRET
  delete process.env.WEB_ACCOUNT_URL
  delete process.env.ALLOWED_ORIGINS
})

describe('admin password credentials', () => {
  it('round-trips a strong password', () => {
    const digest = hashPassword('correct horse battery staple')
    expect(digest.startsWith('scrypt$')).toBe(true)
    expect(digest).not.toContain('correct horse')
    expect(verifyPassword('correct horse battery staple', digest)).toBe(true)
  })

  it('rejects the wrong password', () => {
    const digest = hashPassword('correct horse battery staple')
    expect(verifyPassword('correct horse battery stapl', digest)).toBe(false)
    expect(verifyPassword('', digest)).toBe(false)
    expect(verifyPassword('CORRECT HORSE BATTERY STAPLE', digest)).toBe(false)
  })

  it('salts each credential, so equal passwords get different digests', () => {
    const a = hashPassword('a-very-long-password-1')
    const b = hashPassword('a-very-long-password-1')
    expect(a).not.toBe(b)
    expect(verifyPassword('a-very-long-password-1', a)).toBe(true)
    expect(verifyPassword('a-very-long-password-1', b)).toBe(true)
  })

  it('never throws on a corrupted or hostile digest', () => {
    expect(verifyPassword('x', '')).toBe(false)
    expect(verifyPassword('x', 'not-a-digest')).toBe(false)
    expect(verifyPassword('x', 'scrypt$0$0$0$@@@$@@@')).toBe(false)
    expect(verifyPassword('x', 'scrypt$16384$8$1$$')).toBe(false)
    expect(verifyPassword('x', 'bcrypt$16384$8$1$c2FsdA$aGFzaA')).toBe(false)
  })

  it('detects a tampered digest tail', () => {
    const digest = hashPassword('a-very-long-password-1')
    const tampered = digest.slice(0, -2) + (digest.endsWith('AA') ? 'BB' : 'AA')
    expect(verifyPassword('a-very-long-password-1', tampered)).toBe(false)
  })

  it('enforces a minimum length and rejects obvious weak phrases', () => {
    expect(passwordProblem('short')).toContain(String(MIN_PASSWORD_LENGTH))
    expect(passwordProblem('password123456')).not.toBeNull()
    // A weak phrase is refused wherever it appears, not only as the whole value,
    // so a passphrase that merely embeds "password" does not slip through.
    expect(passwordProblem('long-enough-but-contains-password')).not.toBeNull()
    expect(passwordProblem('  padded-passphrase-1  ')).toContain('spaces')
    expect(passwordProblem('Tile-Canyon-47-Riverbend')).toBeNull()
  })

  it('flags digests that need a cost upgrade', () => {
    expect(passwordNeedsRehash(hashPassword('a-very-long-password-1'))).toBe(false)
    expect(passwordNeedsRehash('scrypt$1024$8$1$c2FsdA$aGFzaA')).toBe(true)
    expect(passwordNeedsRehash('garbage')).toBe(true)
  })
})

describe('oauth state handling', () => {
  it('round-trips a signed state', async () => {
    const state = { kind: 'web' as const, url: 'https://alpha-website-lime.vercel.app/account.html', nonce: 'n-1' }
    const token = await signState(state)
    const parsed = await verifyState(token)
    expect(parsed).toEqual(state)
  })

  it('rejects a tampered state', async () => {
    const token = await signState({
      kind: 'web',
      url: 'https://alpha-website-lime.vercel.app/account.html',
      nonce: 'n-1'
    })
    const [header, payload, signature] = token.split('.')
    const forged = Buffer.from(
      JSON.stringify({ r: 'https://evil.example/steal', k: 'web', n: 'n-1' })
    ).toString('base64url')
    expect(await verifyState(`${header}.${forged}.${signature}`)).toBe(null)
    expect(await verifyState(payload)).toBe(null)
    expect(await verifyState('')).toBe(null)
  })

  it('rejects a state signed with a different secret', async () => {
    const token = await signState({ kind: 'app', url: appCallbackUrl(), nonce: 'n-2' })
    const swap = process.env.AUTH_JWT_SECRET
    process.env.AUTH_JWT_SECRET = 'a-completely-different-secret-value-32b'
    expect(await verifyState(token)).toBe(null)
    process.env.AUTH_JWT_SECRET = swap
    expect(await verifyState(token)).toEqual({ kind: 'app', url: appCallbackUrl(), nonce: 'n-2' })
  })
})

describe('oauth return target allow-list', () => {
  it('accepts the desktop app callback', () => {
    expect(resolveTarget('alpha://auth/callback')).toEqual({ kind: 'app', url: 'alpha://auth/callback' })
  })

  it('accepts a page on the configured site origin', () => {
    expect(resolveTarget('https://alpha-website-lime.vercel.app/download.html')).toEqual({
      kind: 'web',
      url: 'https://alpha-website-lime.vercel.app/download.html'
    })
  })

  it('refuses other schemes, paths and hosts', () => {
    expect(resolveTarget('alpha://auth/other')).toBe(null)
    expect(resolveTarget('evil://auth/callback')).toBe(null)
    expect(resolveTarget('https://evil.example/account.html')).toBe(null)
    expect(resolveTarget('javascript:alert(1)')).toBe(null)
    expect(resolveTarget('http://alpha-website-lime.vercel.app/account.html')).toBe(null)
    expect(resolveTarget('')).toBe(null)
    expect(resolveTarget(null)).toBe(null)
  })
})

describe('download gating', () => {
  it('requires a signed-in, active account', () => {
    expect(gatingProblem(null)?.status).toBe(401)
    expect(gatingProblem({ status: 'suspended' })?.code).toBe('account_inactive')
    expect(gatingProblem({ status: 'disabled' })?.status).toBe(403)
    expect(gatingProblem({ status: 'active' })).toBe(null)
  })

  it('only hands back installer URLs on the release-asset hosts', () => {
    expect(assetHostAllowed('https://github.com/o/r/releases/download/v1/a.exe')).toBe(true)
    expect(assetHostAllowed('https://objects.githubusercontent.com/x')).toBe(true)
    expect(assetHostAllowed('http://github.com/o/r')).toBe(false)
    expect(assetHostAllowed('https://evil.example/a.exe')).toBe(false)
    expect(assetHostAllowed('not a url')).toBe(false)
  })

  it('normalizes a release row and refuses unusable ones', () => {
    const info = normalizeRelease({
      version: '1.0.4',
      installer_url: 'https://github.com/martinssqeel-maker/Alpha-/releases/download/v1.0.4/Alpha.exe',
      installer_size: '125197395',
      sha512: 'abc',
      minimum_supported_version: '1.0.4',
      notes: '  ',
      created_at: '2026-10-11T00:00:00Z'
    })
    expect(info?.version).toBe('1.0.4')
    expect(info?.size).toBe(125197395)
    expect(info?.notes).toBe(null)
    expect(info?.minimumSupportedVersion).toBe('1.0.4')

    expect(normalizeRelease(null)).toBe(null)
    expect(normalizeRelease({ version: '1.0.4' })).toBe(null)
    expect(
      normalizeRelease({ version: '1.0.4', installer_url: 'https://evil.example/a.exe' })
    ).toBe(null)
  })
})

describe('github sign-in', () => {
  const saved = {
    id: process.env.GITHUB_CLIENT_ID,
    secret: process.env.GITHUB_CLIENT_SECRET
  }

  function setCredentials(clientId?: string, clientSecret?: string): void {
    if (clientId === undefined) delete process.env.GITHUB_CLIENT_ID
    else process.env.GITHUB_CLIENT_ID = clientId
    if (clientSecret === undefined) delete process.env.GITHUB_CLIENT_SECRET
    else process.env.GITHUB_CLIENT_SECRET = clientSecret
  }

  afterAll(() => {
    if (saved.id === undefined) delete process.env.GITHUB_CLIENT_ID
    else process.env.GITHUB_CLIENT_ID = saved.id
    if (saved.secret === undefined) delete process.env.GITHUB_CLIENT_SECRET
    else process.env.GITHUB_CLIENT_SECRET = saved.secret
  })

  it('stays hidden until BOTH credentials exist', () => {
    setCredentials()
    expect(githubConfigured()).toBe(false)
    setCredentials('client-id-only')
    expect(githubConfigured()).toBe(false)
    setCredentials('client-id', 'client-secret')
    expect(githubConfigured()).toBe(true)
  })

  it('is advertised by the provider summary alongside google', () => {
    setCredentials('client-id', 'client-secret')
    expect(providersSummary().github).toBe(true)
    setCredentials()
    expect(providersSummary().github).toBe(false)
    expect(providersSummary().password).toBe(true)
  })

  it('requests identity only — it can never grant repository access', () => {
    setCredentials('client-id', 'client-secret')
    const url = new URL(
      githubAuthUrl({ state: 'signed-state', redirectUri: 'https://api.example.test/auth/github/callback' })
    )
    expect(`${url.origin}${url.pathname}`).toBe('https://github.com/login/oauth/authorize')
    expect(url.searchParams.get('client_id')).toBe('client-id')
    expect(url.searchParams.get('redirect_uri')).toBe('https://api.example.test/auth/github/callback')
    expect(url.searchParams.get('state')).toBe('signed-state')
    expect(url.searchParams.get('scope')).toBe(GITHUB_SIGNIN_SCOPE)
    expect(GITHUB_SIGNIN_SCOPE).not.toContain('repo')
    expect(GITHUB_SIGNIN_SCOPE).not.toContain('write')
    // Signing in must also serve first-time users, not just returning ones.
    expect(url.searchParams.get('allow_signup')).toBe('true')
  })

  it('needs a verified address and a stable numeric subject', () => {
    const profile = { id: 583231, login: 'octocat', name: '  The Octocat  ' }
    expect(toGithubIdentity(profile, [{ email: 'a@example.com', primary: true, verified: false }])).toBe(null)
    expect(toGithubIdentity(profile, [])).toBe(null)
    expect(toGithubIdentity(profile, null)).toBe(null)
    expect(toGithubIdentity(null, [{ email: 'a@example.com', verified: true }])).toBe(null)
    expect(toGithubIdentity({ login: 'no-id' }, [{ email: 'a@example.com', verified: true }])).toBe(null)
    expect(toGithubIdentity({ id: '' }, [{ email: 'a@example.com', verified: true }])).toBe(null)
  })

  it('prefers the verified primary address and normalizes it', () => {
    const identity = toGithubIdentity({ id: 583231, login: 'octocat', name: 'The Octocat' }, [
      { email: 'other@example.com', primary: false, verified: true },
      { email: 'Primary@Example.com', primary: true, verified: true }
    ])
    expect(identity).toEqual({
      subject: '583231',
      login: 'octocat',
      email: 'primary@example.com',
      emailVerified: true,
      name: 'The Octocat'
    })
  })

  it('ignores an unverified primary and uses the verified one instead', () => {
    const identity = toGithubIdentity({ id: 7, login: 'dev' }, [
      { email: 'claim@example.com', primary: true, verified: false },
      { email: 'real@example.com', primary: false, verified: true }
    ])
    expect(identity?.email).toBe('real@example.com')
  })

  it('reads the login id as the subject, never the renameable handle', () => {
    const identity = toGithubIdentity({ id: 99, login: 'renamed-since' }, [
      { email: 'a@example.com', primary: true, verified: true }
    ])
    expect(identity?.subject).toBe('99')
    expect(identity?.subject).not.toBe('renamed-since')
  })
})
