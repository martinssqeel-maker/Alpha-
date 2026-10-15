import { describe, expect, it } from 'vitest'
import { providerEndpointProblem } from '../src/shared/providerUrl'
import { zProviderSave, zProviderTest } from '../src/shared/schemas'

describe('provider endpoint validation', () => {
  it('accepts the endpoints the product actually ships with', () => {
    const valid: [string, 'ollama' | 'openai-compatible' | 'gateway'][] = [
      ['http://127.0.0.1:11434', 'ollama'],
      ['http://localhost:11434/', 'ollama'],
      ['https://api.openai.com/v1', 'openai-compatible'],
      ['https://openrouter.ai/api/v1', 'openai-compatible'],
      ['http://127.0.0.1:1234/v1', 'openai-compatible'],
      ['http://192.168.1.50:8000/v1', 'openai-compatible'],
      ['https://gateway.example.com', 'gateway']
    ]
    for (const [url, kind] of valid) {
      expect(providerEndpointProblem(url, kind), url).toBeNull()
    }
  })

  it('rejects anything that is not a plain http(s) URL', () => {
    expect(providerEndpointProblem('', 'openai-compatible')).toMatch(/Enter a base URL/i)
    expect(providerEndpointProblem('api.openai.com/v1', 'openai-compatible')).toMatch(/not a valid URL/i)
    expect(providerEndpointProblem('file:///etc/passwd', 'openai-compatible')).toMatch(/http:\/\/ and https:\/\//i)
    expect(providerEndpointProblem('javascript:alert(1)', 'openai-compatible')).toMatch(/http:\/\/ and https:\/\//i)
    expect(providerEndpointProblem('ftp://example.com', 'openai-compatible')).toMatch(/http:\/\/ and https:\/\//i)
  })

  it('refuses credentials embedded in the URL so a key never lands in plain text', () => {
    const problem = providerEndpointProblem('https://user:sk-secret@api.example.com/v1', 'openai-compatible')
    expect(problem).toMatch(/remove the credentials/i)
    expect(problem).toMatch(/API key field/i)
  })

  it('does not allow a query string or fragment on a base URL', () => {
    expect(providerEndpointProblem('https://api.example.com/v1?key=abc', 'openai-compatible')).toMatch(/query string/i)
    expect(providerEndpointProblem('https://api.example.com/v1#frag', 'openai-compatible')).toMatch(/query string/i)
  })

  it('keeps an Ollama endpoint at the server root', () => {
    expect(providerEndpointProblem('http://127.0.0.1:11434/api', 'ollama')).toMatch(/server root/i)
    expect(providerEndpointProblem('http://127.0.0.1:11434/', 'ollama')).toBeNull()
  })

  it('applies the same rule through the IPC schemas', () => {
    const base = { kind: 'openai-compatible' as const, name: 'My provider' }
    expect(zProviderSave.safeParse({ ...base, baseUrl: 'https://api.example.com/v1' }).success).toBe(true)
    const rejected = zProviderSave.safeParse({ ...base, baseUrl: 'sk-live-key-in-the-url' })
    expect(rejected.success).toBe(false)
    if (!rejected.success) {
      expect(rejected.error.issues[0].message).toMatch(/not a valid URL/i)
      expect(rejected.error.issues[0].path).toEqual(['baseUrl'])
    }
    expect(zProviderSave.safeParse({ ...base, baseUrl: 'https://u:p@api.example.com' }).success).toBe(false)
    expect(
      zProviderTest.safeParse({ kind: 'ollama', baseUrl: 'http://127.0.0.1:11434' }).success
    ).toBe(true)
    expect(zProviderTest.safeParse({ kind: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1' }).success).toBe(false)
  })
})
