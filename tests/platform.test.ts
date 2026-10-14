import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  EncryptedSessionStorage,
  friendlyAuthError,
  parseDeepLink,
  PlatformService
} from '../src/main/services/platform'
import { ObfuscationCipher, SecretStore } from '../src/main/services/secrets'
import type { AppSettings } from '../src/shared/types'

describe('platform/deep-link parse', () => {
  it('parses fragment tokens from a custom-scheme URL', () => {
    const p = parseDeepLink(
      'alpha://auth/callback#access_token=abc&refresh_token=def&expires_in=3600&type=magiclink'
    )
    expect(p.access_token).toBe('abc')
    expect(p.refresh_token).toBe('def')
    expect(p.type).toBe('magiclink')
    expect(p.error).toBeUndefined()
  })

  it('parses query tokens', () => {
    const p = parseDeepLink('alpha://auth/callback?code=xyz&type=signup')
    expect(p.code).toBe('xyz')
    expect(p.type).toBe('signup')
  })

  it('parses fragment tokens without a parseable host', () => {
    const p = parseDeepLink('alpha://auth/callback#access_token=tok&refresh_token=ref')
    expect(p.access_token).toBe('tok')
    expect(p.refresh_token).toBe('ref')
  })

  it('exposes error parameters', () => {
    const p = parseDeepLink('alpha://auth/callback#error=access_denied&error_description=Denied')
    expect(p.error).toBe('access_denied')
    expect(p.error_description).toBe('Denied')
  })

  it('is tolerant of garbage input', () => {
    expect(parseDeepLink('not a url')).toEqual({})
  })
})

describe('platform/session storage', () => {
  it('persists and round-trips session entries via the encrypted store', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alpha-sess-'))
    const file = path.join(dir, 'secrets.enc')
    const secrets = new SecretStore(file, new ObfuscationCipher())
    const storage = new EncryptedSessionStorage(secrets, 'platform:session-store:test')

    await storage.setItem('supabase-auth-token', JSON.stringify({ access_token: 'at', refresh_token: 'rt' }))
    await storage.setItem('supabase-auth-token-code-verifier', 'verifier')

    const reloaded = new EncryptedSessionStorage(secrets, 'platform:session-store:test')
    expect(await reloaded.getItem('supabase-auth-token')).toContain('"access_token":"at"')
    expect(await reloaded.getItem('supabase-auth-token-code-verifier')).toBe('verifier')

    await reloaded.removeItem('supabase-auth-token-code-verifier')
    const again = new EncryptedSessionStorage(secrets, 'platform:session-store:test')
    expect(await again.getItem('supabase-auth-token-code-verifier')).toBeNull()
    expect(await again.getItem('supabase-auth-token')).toContain('"refresh_token":"rt"')

    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('writes ciphertext to disk, not plaintext', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alpha-sess-'))
    const file = path.join(dir, 'secrets.enc')
    const secrets = new SecretStore(file, new ObfuscationCipher())
    const storage = new EncryptedSessionStorage(secrets, 'platform:session-store:test')

    await storage.setItem('supabase-auth-token', 'super-secret')
    const raw = fs.readFileSync(file, 'utf8')
    expect(raw).not.toContain('super-secret')
    expect(secrets.get('platform:session-store:test')).toContain('super-secret')

    fs.rmSync(dir, { recursive: true, force: true })
  })
})

describe('platform/status reflects live settings', () => {
  /**
   * The platform can be enabled or re-pointed from Settings while the app is
   * running. Status must reflect that immediately instead of reporting the
   * snapshot taken at startup (which made Account show "Alpha Cloud is
   * disabled" right after the user enabled it).
   */
  function makeService(platform: AppSettings['platform']) {
    const state = { platform: { ...platform } }
    const service = new PlatformService({
      settings: { get: () => ({ platform: state.platform }) } as never,
      secrets: { get: () => null, set: () => undefined, delete: () => undefined } as never,
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined } as never,
      onStatus: () => undefined,
      onActiveChange: () => undefined
    })
    return { service, state }
  }

  it('derives enabled/configured from current settings without a refresh', () => {
    const { service, state } = makeService({ enabled: false, apiBaseUrl: '', authRedirectScheme: 'alpha' })
    expect(service.status().enabled).toBe(false)
    expect(service.status().configured).toBe(false)

    state.platform = {
      enabled: true,
      apiBaseUrl: 'https://api.example.test',
      authRedirectScheme: 'alpha'
    }
    expect(service.status().enabled).toBe(true)
    expect(service.status().configured).toBe(true)
    expect(service.isActive()).toBe(false)
  })

  it('is not configured until both the toggle and the API base URL are set', () => {
    const { service, state } = makeService({ enabled: true, apiBaseUrl: '', authRedirectScheme: 'alpha' })
    expect(service.status().configured).toBe(false)

    state.platform = {
      enabled: true,
      apiBaseUrl: 'https://api.example.test/',
      authRedirectScheme: 'alpha'
    }
    expect(service.apiBaseUrl()).toBe('https://api.example.test')
    expect(service.status().configured).toBe(true)
  })

  it('keeps enabled in the cached snapshot after a refresh while signed out', async () => {
    const { service, state } = makeService({ enabled: false, apiBaseUrl: '', authRedirectScheme: 'alpha' })
    state.platform = {
      enabled: true,
      apiBaseUrl: 'https://api.example.test',
      authRedirectScheme: 'alpha'
    }

    const status = await service.refresh()
    expect(status.enabled).toBe(true)
    expect(status.configured).toBe(true)
    expect(status.authenticated).toBe(false)
    expect(service.status().enabled).toBe(true)
  })

  it('builds a provider sign-in URL that returns to the app deep link', () => {
    const { service } = makeService({
      enabled: true,
      apiBaseUrl: 'https://api.example.test/',
      authRedirectScheme: 'alpha'
    })
    const github = new URL(service.providerSignInUrl('github') as string)
    expect(`${github.origin}${github.pathname}`).toBe('https://api.example.test/auth/github/start')
    expect(github.searchParams.get('redirect')).toBe('alpha://auth/callback')

    const google = new URL(service.providerSignInUrl('google') as string)
    expect(`${google.origin}${google.pathname}`).toBe('https://api.example.test/auth/google/start')
  })

  it('honours a custom auth scheme in the return target', () => {
    const { service } = makeService({
      enabled: true,
      apiBaseUrl: 'https://api.example.test',
      authRedirectScheme: 'alpha-dev'
    })
    const url = new URL(service.providerSignInUrl('google') as string)
    expect(url.searchParams.get('redirect')).toBe('alpha-dev://auth/callback')
  })

  it('offers no provider sign-in URL until the platform is configured', () => {
    const { service } = makeService({ enabled: false, apiBaseUrl: '', authRedirectScheme: 'alpha' })
    expect(service.providerSignInUrl('google')).toBe(null)
    expect(service.providerSignInUrl('github')).toBe(null)
  })
})

describe('platform/auth error mapping', () => {
  it('maps common auth failures to human messages', () => {
    expect(friendlyAuthError('Email not confirmed')).toContain('not confirmed')
    expect(friendlyAuthError('invalid login credentials')).toContain('invalid or has expired')
    expect(friendlyAuthError('rate limit exceeded')).toContain('Too many attempts')
  })

  it('passes through unknown messages verbatim', () => {
    expect(friendlyAuthError('weird upstream issue')).toBe('weird upstream issue')
  })
})