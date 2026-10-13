import { describe, expect, it } from 'vitest'
import { normalizePreviewUrl } from '../src/shared/browserUrl'

describe('normalizePreviewUrl', () => {
  it('defaults loopback addresses to HTTP and hosted names to HTTPS', () => {
    expect(normalizePreviewUrl('localhost:3000')).toBe('http://localhost:3000/')
    expect(normalizePreviewUrl('127.0.0.1:4173/preview')).toBe('http://127.0.0.1:4173/preview')
    expect(normalizePreviewUrl('example.com/docs')).toBe('https://example.com/docs')
    expect(normalizePreviewUrl('[::1]:8080')).toBe('http://[::1]:8080/')
  })

  it('rejects empty, non-web, malformed, and credential-bearing addresses', () => {
    expect(() => normalizePreviewUrl('  ')).toThrow(/Enter a website/)
    expect(() => normalizePreviewUrl('file:///C:/Windows/win.ini')).toThrow(/HTTP and HTTPS/)
    expect(() => normalizePreviewUrl('javascript:alert(1)')).toThrow(/HTTP and HTTPS/)
    expect(() => normalizePreviewUrl('https://user:password@example.com')).toThrow(/cannot contain credentials/)
    expect(() => normalizePreviewUrl('https://')).toThrow(/not valid/)
  })
})
