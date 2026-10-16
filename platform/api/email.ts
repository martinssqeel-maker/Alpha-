import { getEnv } from './env'
import { renderSignInEmail } from './emailTemplates'

export interface OtpEmail {
  to: string
  code: string
  magicUrl: string
  expiresMinutes: number
}

export interface DeliveryResult {
  /** Which transport actually took the message. */
  provider: 'resend' | 'log'
  /** Resend's message id, when the provider returned one. */
  id: string | null
  /** How many HTTP attempts the send took (1 when it worked first time). */
  attempts: number
  /** True only for the dev provider, which delivers nothing. */
  simulated: boolean
}

/**
 * A delivery failure the caller can act on.
 *
 * `retryable` distinguishes "try again in a moment" (429, 5xx, network) from
 * "this will never work" (a rejected sender, a malformed address). The sign-in
 * route uses it to decide whether to leave the freshly minted code usable.
 */
export class EmailDeliveryError extends Error {
  readonly status: number | null
  readonly retryable: boolean
  constructor(message: string, status: number | null, retryable: boolean) {
    super(message)
    this.name = 'EmailDeliveryError'
    this.status = status
    this.retryable = retryable
  }
}

/**
 * Resend returns provider detail in the response body. That body is written to
 * the Function logs for an operator, so it is scrubbed first: a `re_…` credential
 * echoed back by a misbehaving proxy must never end up in a log line, and the
 * text is capped so one bad response cannot flood the log.
 */
export function sanitizeProviderDetail(raw: string): string {
  return raw
    .replace(/\bre_[A-Za-z0-9_-]{6,}/g, 're_[redacted]')
    .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240)
}

/** Resend error `name`/`type` values that mean "retrying is pointless". */
const PERMANENT_PROVIDER_ERRORS = new Set([
  'validation_error',
  'invalid_from_address',
  'missing_required_field',
  'invalid_parameter',
  'invalid_api_key',
  'restricted_api_key',
  'not_authorized',
  'validation_failed'
])

/**
 * Whether a failed HTTP attempt is worth retrying.
 *
 * Deliberately conservative: a 4xx means the request itself is wrong, and the
 * provider's own error name decides the ambiguous 400 case. Retrying a rejected
 * sender ten times only produces ten rejected sends.
 */
export function isRetryableFailure(status: number, providerErrorName?: string): boolean {
  if (providerErrorName && PERMANENT_PROVIDER_ERRORS.has(providerErrorName)) return false
  if (status === 429) return true
  return status >= 500
}

const RESEND_ENDPOINT = 'https://api.resend.com/emails'
/** Two attempts total: a third is unlikely to help inside a Function's budget. */
const MAX_ATTEMPTS = 2
/** Backoff before the second attempt, in milliseconds. */
const RETRY_DELAY_MS = 500

const DEFAULT_FROM = 'Alpha AI Workspace <onboarding@resend.dev>'

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** The website origin, for links that must point at a real page. */
function siteUrl(): string {
  return (getEnv('WEB_ACCOUNT_URL') ?? 'https://alpha-website-lime.vercel.app').replace(/\/+$/, '')
}

async function sendViaResend(input: {
  to: string
  subject: string
  html: string
  text: string
}): Promise<{ id: string | null; attempts: number }> {
  const apiKey = getEnv('RESEND_API_KEY')
  if (!apiKey) {
    throw new EmailDeliveryError(
      'Email is set to send through Resend but no API key is configured on the server.',
      null,
      false
    )
  }
  const from = getEnv('EMAIL_FROM') ?? DEFAULT_FROM
  const replyTo = getEnv('EMAIL_REPLY_TO')

  let lastError: EmailDeliveryError | null = null

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let status = 0
    let detail = ''
    let providerName: string | undefined
    try {
      const res = await fetch(RESEND_ENDPOINT, {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          from,
          to: [input.to],
          subject: input.subject,
          html: input.html,
          text: input.text,
          ...(replyTo ? { reply_to: replyTo } : {})
        })
      })
      status = res.status
      const rawBody = await res.text().catch(() => '')
      if (res.ok) {
        let id: string | null = null
        try {
          const parsed = JSON.parse(rawBody) as { id?: unknown }
          if (typeof parsed.id === 'string' && parsed.id) id = parsed.id
        } catch {
          /* a 2xx with an unreadable body still means it was accepted */
        }
        return { id, attempts: attempt }
      }
      detail = sanitizeProviderDetail(rawBody)
      try {
        const parsed = JSON.parse(rawBody) as { name?: unknown; type?: unknown }
        const candidate = typeof parsed.name === 'string' ? parsed.name : parsed.type
        if (typeof candidate === 'string') providerName = candidate
      } catch {
        /* not JSON — the status alone decides retryability */
      }
    } catch (error) {
      // Network/DNS/TLS failure: no status at all, always worth one retry.
      lastError = new EmailDeliveryError(
        `The email provider could not be reached (${error instanceof Error ? error.name : 'network error'}).`,
        null,
        true
      )
      console.error(`[email:resend] attempt ${attempt} transport failure: ${lastError.message}`)
      if (attempt < MAX_ATTEMPTS) {
        await sleep(RETRY_DELAY_MS)
        continue
      }
      throw lastError
    }

    const retryable = isRetryableFailure(status, providerName)
    // Operator-facing diagnostics only: status + scrubbed provider detail.
    console.error(`[email:resend] attempt ${attempt} failed status=${status} detail=${detail || '(no body)'}`)
    lastError = new EmailDeliveryError(
      retryable
        ? 'The email service is temporarily unavailable.'
        : 'The email service rejected the message.',
      status,
      retryable
    )
    if (retryable && attempt < MAX_ATTEMPTS) {
      await sleep(RETRY_DELAY_MS)
      continue
    }
    throw lastError
  }

  throw lastError ?? new EmailDeliveryError('The email could not be sent.', null, true)
}

/**
 * Send the sign-in code + magic link.
 *
 * Providers:
 *   EMAIL_PROVIDER=resend  -> Resend HTTP API (requires RESEND_API_KEY)
 *   EMAIL_PROVIDER=log     -> dev only: writes the code to the Function logs and
 *                             delivers nothing. The magic-link token is never
 *                             written out even here, so a log line cannot be
 *                             turned into a session.
 *
 * Throws EmailDeliveryError on failure. Callers must not report a code as sent
 * when this throws.
 */
export async function sendOtpEmail(input: OtpEmail): Promise<DeliveryResult> {
  const provider = (getEnv('EMAIL_PROVIDER') ?? 'log').toLowerCase()
  const rendered = renderSignInEmail({
    code: input.code,
    magicUrl: input.magicUrl,
    expiresMinutes: input.expiresMinutes,
    siteUrl: siteUrl()
  })

  if (provider === 'resend') {
    const { id, attempts } = await sendViaResend({
      to: input.to,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text
    })
    return { provider: 'resend', id, attempts, simulated: false }
  }

  if (provider !== 'log') {
    throw new EmailDeliveryError(
      `EMAIL_PROVIDER="${provider}" is not supported. Use "resend" or "log".`,
      null,
      false
    )
  }

  // Dev only. The recipient and the one-time code are logged so a developer can
  // complete a sign-in without a mailbox; the magic-link token is deliberately
  // withheld. Never deploy with EMAIL_PROVIDER=log — no mail is delivered.
  const maskedLink = `${input.magicUrl.split('?')[0]}?…`
  console.log(
    `[email:log] EMAIL_PROVIDER=log delivers NO mail. to=${input.to} code=${input.code} magic=${maskedLink}`
  )
  return { provider: 'log', id: null, attempts: 1, simulated: true }
}
