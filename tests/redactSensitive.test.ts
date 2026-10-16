import { describe, expect, it } from 'vitest'
import { redactSensitiveText, redactSensitiveValue } from '../src/shared/redactSensitive'

describe('activity detail redaction', () => {
  it('redacts credentials in nested argument and result objects', () => {
    const safe = redactSensitiveValue({
      apiKey: 'private-key-value',
      nested: { Authorization: 'Bearer abcdefghijklmnopqrstuvwxyz', output: 'done' },
      OPENAI_API_KEY: 'another-private-value'
    })

    expect(safe).toEqual({
      apiKey: '[REDACTED]',
      nested: { Authorization: '[REDACTED]', output: 'done' },
      OPENAI_API_KEY: '[REDACTED]'
    })
  })

  it('redacts common provider tokens, environment assignments, and credential URLs in text', () => {
    const safe = redactSensitiveText(
      'OPENAI_API_KEY=sk-12345678901234567890 ghp_12345678901234567890 postgres://worker:secret@db.example.com/app'
    )

    expect(safe).not.toContain('sk-12345678901234567890')
    expect(safe).not.toContain('ghp_12345678901234567890')
    expect(safe).not.toContain('worker:secret')
    expect(safe).toContain('[REDACTED]')
  })
})
