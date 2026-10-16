import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  EmailDeliveryError,
  isRetryableFailure,
  sanitizeProviderDetail,
  sendOtpEmail
} from '../platform/api/email'
import { renderSignInEmail } from '../platform/api/emailTemplates'
import { otpRequestDecision, type OtpRequestSignals } from '../platform/api/auth'

// The sign-in email is the only way into an account that has no password, so its
// failure modes matter more than its happy path. These drive the real transport
// with a stubbed `fetch`: what is asserted is the request that would have been
// sent, how many times, and what the caller is told when it cannot be sent.

const ENV_KEYS = [
  'EMAIL_PROVIDER',
  'RESEND_API_KEY',
  'EMAIL_FROM',
  'EMAIL_REPLY_TO',
  'WEB_ACCOUNT_URL'
] as const

const saved: Record<string, string | undefined> = {}
const realFetch = globalThis.fetch

beforeEach(() => {
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key]
    delete process.env[key]
  }
  process.env.WEB_ACCOUNT_URL = 'https://alpha-website-lime.vercel.app'
})

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
  globalThis.fetch = realFetch
  vi.restoreAllMocks()
})

interface SentRequest {
  url: string
  method: string
  headers: Record<string, string>
  body: Record<string, unknown>
}

/** Stub `fetch` with one response per call; the last one repeats. */
function stubFetch(responses: Array<{ status: number; body?: unknown; throws?: boolean }>): SentRequest[] {
  const sent: SentRequest[] = []
  let index = 0
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    const spec = responses[Math.min(index, responses.length - 1)]
    index += 1
    sent.push({
      url: String(url),
      method: String(init?.method ?? 'GET'),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {}
    })
    if (spec.throws) throw new TypeError('fetch failed')
    return new Response(JSON.stringify(spec.body ?? {}), {
      status: spec.status,
      headers: { 'content-type': 'application/json' }
    })
  }) as unknown as typeof fetch
  return sent
}

const signIn = { to: 'member@example.com', code: '482913', magicUrl: 'https://site/account?token=abc', expiresMinutes: 10 }

describe('email templates', () => {
  it('carries the code and the link in both the HTML and the plain-text part', () => {
    const mail = renderSignInEmail({ ...signIn, siteUrl: 'https://alpha-website-lime.vercel.app' })
    expect(mail.subject).toContain('482913')
    expect(mail.html).toContain('482913')
    expect(mail.html).toContain('https://site/account?token=abc')
    expect(mail.html).toContain('10 minutes')
    // A client that strips HTML must still be able to sign in.
    expect(mail.text).toContain('482913')
    expect(mail.text).toContain('https://site/account?token=abc')
    expect(mail.preheader).toContain('482913')
  })

  it('escapes a link for the attribute context it is written into', () => {
    const mail = renderSignInEmail({
      ...signIn,
      magicUrl: 'https://site/account?email=a%26b&token=x"><script>alert(1)</script>',
      siteUrl: 'https://site'
    })
    // The `&` that separates query parameters must survive as an entity, and the
    // injected quote must not be able to close the href and start an element.
    expect(mail.html).toContain('?email=a%26b&amp;token=x');
    expect(mail.html).not.toContain('"><script>')
  })

  it('links its footer at the configured site rather than a hard-coded domain', () => {
    const mail = renderSignInEmail({ ...signIn, siteUrl: 'https://example.test/' })
    expect(mail.html).toContain('https://example.test/privacy')
    expect(mail.html).toContain('https://example.test/terms')
    expect(mail.text).toContain('https://example.test/privacy')
  })
})

describe('provider failure classification', () => {
  it('treats throttling and server faults as retryable, and bad requests as final', () => {
    expect(isRetryableFailure(429)).toBe(true)
    expect(isRetryableFailure(500)).toBe(true)
    expect(isRetryableFailure(503)).toBe(true)
    expect(isRetryableFailure(422)).toBe(false)
    expect(isRetryableFailure(403)).toBe(false)
    // A 400 whose provider error is a rejected sender will never become valid.
    expect(isRetryableFailure(400, 'validation_error')).toBe(false)
    expect(isRetryableFailure(400, 'invalid_from_address')).toBe(false)
    // …but an unclassified 400 is still not a 5xx, so it is final as well.
    expect(isRetryableFailure(400)).toBe(false)
  })

  it('scrubs credentials and bearer headers out of provider detail', () => {
    const scrubbed = sanitizeProviderDetail('re_AbCdEf123456 rejected; Authorization: Bearer re_secretvalue')
    expect(scrubbed).not.toContain('re_AbCdEf123456')
    expect(scrubbed).not.toContain('re_secretvalue')
    expect(scrubbed).toContain('[redacted]')
  })

  it('caps the logged detail so one bad response cannot flood the log', () => {
    expect(sanitizeProviderDetail('x'.repeat(5000)).length).toBe(240)
  })
})

describe('sendOtpEmail: dev transport', () => {
  it('delivers nothing and says so', async () => {
    process.env.EMAIL_PROVIDER = 'log'
    const fetchSpy = vi.fn()
    globalThis.fetch = fetchSpy as unknown as typeof fetch
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    const result = await sendOtpEmail(signIn)

    expect(result.simulated).toBe(true)
    expect(result.provider).toBe('log')
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(logSpy).toHaveBeenCalledOnce()
    // The code is logged (that is the point of this transport) but the one-tap
    // token is not, so a log line can never be opened as a session.
    const line = String(logSpy.mock.calls[0][0])
    expect(line).toContain('482913')
    expect(line).not.toContain('token=abc')
  })

  it('refuses an unsupported provider instead of silently sending nothing', async () => {
    process.env.EMAIL_PROVIDER = 'sendgrid'
    await expect(sendOtpEmail(signIn)).rejects.toBeInstanceOf(EmailDeliveryError)
  })
})

describe('sendOtpEmail: Resend', () => {
  it('refuses to pretend it sent when no key is configured', async () => {
    process.env.EMAIL_PROVIDER = 'resend'
    const fetchSpy = vi.fn()
    globalThis.fetch = fetchSpy as unknown as typeof fetch

    await expect(sendOtpEmail(signIn)).rejects.toMatchObject({ retryable: false })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('posts one message with both parts and the verified sender', async () => {
    process.env.EMAIL_PROVIDER = 'resend'
    process.env.RESEND_API_KEY = 're_testkey_0123456789'
    process.env.EMAIL_FROM = 'Alpha AI Workspace <no-reply@alpha.example>'
    const sent = stubFetch([{ status: 200, body: { id: 'msg_123' } }])

    const result = await sendOtpEmail(signIn)

    expect(result).toMatchObject({ provider: 'resend', id: 'msg_123', attempts: 1, simulated: false })
    expect(sent).toHaveLength(1)
    expect(sent[0].url).toBe('https://api.resend.com/emails')
    expect(sent[0].method).toBe('POST')
    expect(sent[0].headers.authorization).toBe('Bearer re_testkey_0123456789')
    expect(sent[0].body.from).toBe('Alpha AI Workspace <no-reply@alpha.example>')
    expect(sent[0].body.to).toEqual(['member@example.com'])
    expect(String(sent[0].body.subject)).toContain('482913')
    expect(String(sent[0].body.html)).toContain('482913')
    expect(String(sent[0].body.text)).toContain('482913')
  })

  it('falls back to the provider’s own permitted sender when none is configured', async () => {
    process.env.EMAIL_PROVIDER = 'resend'
    process.env.RESEND_API_KEY = 're_testkey_0123456789'
    const sent = stubFetch([{ status: 200, body: { id: 'msg_1' } }])
    await sendOtpEmail(signIn)
    // Resend's onboarding sender is the only address it permits without a
    // verified domain, so an unconfigured deployment must not invent one.
    expect(String(sent[0].body.from)).toContain('@resend.dev')
  })

  it('does not retry a rejected request, and never leaks the key into the error', async () => {
    process.env.EMAIL_PROVIDER = 'resend'
    process.env.RESEND_API_KEY = 're_livekey_shouldnotappear'
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const sent = stubFetch([
      { status: 422, body: { name: 'validation_error', message: 'from is not verified: re_livekey_shouldnotappear' } }
    ])

    const failure = await sendOtpEmail(signIn).catch((error: EmailDeliveryError) => error)

    expect(failure).toBeInstanceOf(EmailDeliveryError)
    expect((failure as EmailDeliveryError).retryable).toBe(false)
    expect((failure as EmailDeliveryError).message).not.toContain('re_livekey_shouldnotappear')
    // One attempt only: a rejected sender does not improve on a second try.
    expect(sent).toHaveLength(1)
    // The operator still gets the detail — scrubbed.
    const logged = errorSpy.mock.calls.map((call) => String(call[0])).join('\n')
    expect(logged).toContain('422')
    expect(logged).not.toContain('re_livekey_shouldnotappear')
  })

  it('retries a server fault once, and reports it as retryable when it persists', async () => {
    process.env.EMAIL_PROVIDER = 'resend'
    process.env.RESEND_API_KEY = 're_testkey_0123456789'
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const sent = stubFetch([{ status: 500, body: { name: 'internal_server_error' } }])

    await expect(sendOtpEmail(signIn)).rejects.toMatchObject({ retryable: true, status: 500 })
    expect(sent).toHaveLength(2)
    expect(errorSpy).toHaveBeenCalledTimes(2)
  })

  it('retries a network failure once and then fails loudly', async () => {
    process.env.EMAIL_PROVIDER = 'resend'
    process.env.RESEND_API_KEY = 're_testkey_0123456789'
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const sent = stubFetch([{ status: 0, throws: true }])

    await expect(sendOtpEmail(signIn)).rejects.toMatchObject({ retryable: true, status: null })
    expect(sent).toHaveLength(2)
  })

  it('accepts a success on the second attempt', async () => {
    process.env.EMAIL_PROVIDER = 'resend'
    process.env.RESEND_API_KEY = 're_testkey_0123456789'
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const sent = stubFetch([
      { status: 503, body: { name: 'service_unavailable' } },
      { status: 200, body: { id: 'msg_retry' } }
    ])

    const result = await sendOtpEmail(signIn)
    expect(result).toMatchObject({ id: 'msg_retry', attempts: 2 })
    expect(sent).toHaveLength(2)
  })
})

describe('sign-in email volume control', () => {
  const base: OtpRequestSignals = {
    emailCount: 0,
    ipCount: 0,
    secondsSinceLastEmail: Number.POSITIVE_INFINITY,
    perEmailMax: 3,
    perIpMax: 10,
    cooldownSeconds: 60
  }

  it('allows the first request from a fresh address', () => {
    expect(otpRequestDecision(base)).toBe('allow')
  })

  it('turns an immediate repeat into a cooldown instead of a second email', () => {
    expect(otpRequestDecision({ ...base, emailCount: 1, secondsSinceLastEmail: 5 })).toBe('cooldown')
    expect(otpRequestDecision({ ...base, emailCount: 1, secondsSinceLastEmail: 60 })).toBe('allow')
  })

  it('refuses once the per-address ceiling is reached, cooldown or not', () => {
    expect(otpRequestDecision({ ...base, emailCount: 3, secondsSinceLastEmail: 600 })).toBe('throttled')
  })

  it('refuses a source that keeps asking for different addresses', () => {
    expect(otpRequestDecision({ ...base, ipCount: 10, secondsSinceLastEmail: 600 })).toBe('throttled')
  })

  it('reports throttling rather than cooldown when both apply', () => {
    expect(otpRequestDecision({ ...base, emailCount: 9, ipCount: 99, secondsSinceLastEmail: 0 })).toBe('throttled')
  })
})
