import { describe, expect, it } from 'vitest'
import {
  DEFAULT_OUTPUT_RESERVE,
  MAX_OUTPUT_TOKENS,
  MIN_RESERVE,
  credentialSummary,
  estimateCostUsd,
  estimateInputTokens,
  fingerprint,
  redact,
  reservationFor,
  upstreamErrorMessage,
  upstreamFailure
} from '../platform/api/aiGuard'

describe('credential redaction', () => {
  it('removes an OpenAI-style key', () => {
    expect(redact('auth failed for sk-abcdefgh12345678')).toBe('auth failed for [redacted]')
  })

  it('removes a bearer token', () => {
    expect(redact('header was Bearer eyJhbGciOiJIUzI1NiJ9.abc.def')).toBe('header was Bearer [redacted]')
  })

  it('removes a long opaque value', () => {
    const key = 'a'.repeat(48)
    expect(redact(`key ${key} rejected`)).toBe('key [redacted] rejected')
  })

  it('bounds the length so a provider cannot flood a response', () => {
    expect(redact('x'.repeat(5000)).length).toBeLessThanOrEqual(300)
  })

  it('leaves ordinary prose alone', () => {
    expect(redact('Rate limit exceeded for model gpt-4o-mini')).toBe('Rate limit exceeded for model gpt-4o-mini')
  })
})

describe('provider failures', () => {
  it('reads the provider message out of a JSON error body', () => {
    const body = JSON.stringify({ error: { message: 'Insufficient credits for sk-abcdefgh1234' } })
    expect(upstreamErrorMessage(body)).toBe('Insufficient credits for [redacted]')
  })

  it('falls back to the raw body when it is not JSON', () => {
    expect(upstreamErrorMessage('  upstream exploded  ')).toBe('upstream exploded')
  })

  it('never answers with an empty message', () => {
    expect(upstreamErrorMessage('   ')).toBe('The provider rejected the request.')
  })

  it('treats a rejected credential as a configuration fault, not a retry', () => {
    expect(upstreamFailure(401, 'nope').code).toBe('provider_unauthorized')
    expect(upstreamFailure(403, 'nope').code).toBe('provider_unauthorized')
    expect(upstreamFailure(401, 'nope').http).toBe(502)
  })

  it('distinguishes exhausted credits, missing models and rate limits', () => {
    expect(upstreamFailure(402, '').code).toBe('provider_credits_exhausted')
    expect(upstreamFailure(404, '').code).toBe('provider_model_unavailable')
    const limited = upstreamFailure(429, '')
    expect(limited.code).toBe('provider_rate_limited')
    expect(limited.http).toBe(429)
  })

  it('maps server faults and anything else to a provider error', () => {
    expect(upstreamFailure(503, '').code).toBe('provider_unavailable')
    expect(upstreamFailure(418, '').code).toBe('provider_error')
  })
})

describe('reservation sizing', () => {
  it('counts text inside the message structure', () => {
    // Every string value counts: ("user" 4 + 400) + ("assistant" 9 + 400) = 813
    // characters, divided by 4 and rounded up.
    const tokens = estimateInputTokens([
      { role: 'user', content: 'y'.repeat(400) },
      { role: 'assistant', content: 'z'.repeat(400) }
    ])
    expect(tokens).toBe(204)
  })

  it('ignores structure that is too deep to matter', () => {
    let deep: unknown = 'q'.repeat(400)
    for (let i = 0; i < 12; i += 1) deep = { nested: deep }
    expect(estimateInputTokens(deep)).toBe(0)
  })

  it('always reserves at least a floor, so a tiny prompt is not free', () => {
    expect(reservationFor(null, 0)).toBe(MIN_RESERVE)
    expect(reservationFor('', 0)).toBe(MIN_RESERVE)
    expect(reservationFor([], undefined)).toBeGreaterThanOrEqual(MIN_RESERVE)
  })

  it('reserves room for the output a request may produce', () => {
    const messages = [{ role: 'user', content: 'y'.repeat(400) }]
    const base = estimateInputTokens(messages)
    expect(reservationFor(messages, undefined)).toBe(base + DEFAULT_OUTPUT_RESERVE)
    expect(reservationFor(messages, 500)).toBe(base + 500)
  })

  it('will not let a large max_tokens reserve unbounded allowance', () => {
    const messages = [{ role: 'user', content: 'y'.repeat(400) }]
    const base = estimateInputTokens(messages)
    expect(reservationFor(messages, 10_000_000)).toBe(base + MAX_OUTPUT_TOKENS)
  })

  it('ignores a nonsensical max_tokens', () => {
    const messages = [{ role: 'user', content: 'y'.repeat(400) }]
    const base = estimateInputTokens(messages)
    expect(reservationFor(messages, Number.NaN)).toBe(base + DEFAULT_OUTPUT_RESERVE)
    // A negative max_tokens reserves no output, but the floor still applies.
    expect(reservationFor(messages, -50)).toBe(Math.max(base, MIN_RESERVE))
  })
})

describe('provider credential summaries', () => {
  const row = {
    code: 'openrouter',
    label: 'OpenRouter',
    kind: 'openai-compatible',
    base_url: 'https://openrouter.ai/api/v1',
    api_key_env: 'OPENROUTER_API_KEY',
    active: true,
    spend_limit_usd: '8.00',
    docs_url: 'https://openrouter.ai/docs'
  }
  const SECRET = 'sk-or-v1-abcdefghijklmnopqrstuvwxyz0123456789'

  it('never carries the secret, in any field', () => {
    const summary = credentialSummary(row, SECRET, false)
    const serialised = JSON.stringify(summary)
    expect(serialised).not.toContain(SECRET)
    // No field may hold any meaningful fragment of the key either.
    for (const fragment of [SECRET.slice(0, 8), SECRET.slice(8, 24), SECRET.slice(-16)]) {
      expect(serialised).not.toContain(fragment)
    }
    expect(Object.values(summary)).not.toContain(SECRET)
  })

  it('reports presence and a stable fingerprint instead', () => {
    const first = credentialSummary(row, SECRET, false)
    expect(first.configured).toBe(true)
    expect(first.keyFingerprint).toMatch(/^[0-9a-f]{8}$/)
    // Stable, so a rotation is visibly confirmed rather than guessed at.
    expect(credentialSummary(row, SECRET, false).keyFingerprint).toBe(first.keyFingerprint)
    expect(credentialSummary(row, 'a-different-key', false).keyFingerprint).not.toBe(first.keyFingerprint)
  })

  it('reports a missing credential as unconfigured, with no fingerprint', () => {
    const summary = credentialSummary(row, null, false)
    expect(summary.configured).toBe(false)
    expect(summary.keyFingerprint).toBeNull()
  })

  it('treats a configured AI gateway as covering every provider', () => {
    const summary = credentialSummary(row, null, true)
    expect(summary.configured).toBe(true)
    expect(summary.viaGateway).toBe(true)
    // Still no fingerprint: the gateway's own token is what would be used.
    expect(summary.keyFingerprint).toBeNull()
  })

  it('derives the environment variable name when the row omits one', () => {
    expect(credentialSummary({ ...row, api_key_env: null }, null, false).apiKeyEnv).toBe('PROVIDER_API_KEY_OPENROUTER')
  })

  it('passes through the operator-set cap and docs link', () => {
    const summary = credentialSummary(row, null, false)
    expect(summary.spendLimitUsd).toBe(8)
    expect(summary.docsUrl).toBe('https://openrouter.ai/docs')
    expect(credentialSummary({ ...row, spend_limit_usd: null }, null, false).spendLimitUsd).toBeNull()
  })
})

describe('cost estimation', () => {
  it('applies published per-million prices to both directions', () => {
    // 1M input at $3, 1M output at $15
    expect(estimateCostUsd({ input: 3, output: 15 }, 1_000_000, 1_000_000)).toBe(18)
  })

  it('scales to a realistic small request', () => {
    expect(estimateCostUsd({ input: 3, output: 15 }, 1000, 500)).toBeCloseTo(0.003 + 0.0075, 6)
  })

  it('costs nothing for a free model', () => {
    expect(estimateCostUsd({ input: 0, output: 0 }, 5000, 5000)).toBe(0)
  })
})
