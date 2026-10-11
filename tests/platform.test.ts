import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  EncryptedSessionStorage,
  friendlyAuthError,
  parseDeepLink
} from '../src/main/services/platform'
import { ObfuscationCipher, SecretStore } from '../src/main/services/secrets'

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