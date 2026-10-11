import { getEnv } from './env'

export interface OtpEmail {
  to: string
  code: string
  magicUrl: string
  expiresMinutes: number
}

/**
 * Send the sign-in code + magic link. Pluggable provider:
 *   EMAIL_PROVIDER=resend  -> Resend HTTP API (RESEND_API_KEY)
 *   EMAIL_PROVIDER=log     -> dev only: write to Neon function logs
 */
export async function sendOtpEmail({ to, code, magicUrl, expiresMinutes }: OtpEmail): Promise<void> {
  const provider = (getEnv('EMAIL_PROVIDER') ?? 'log').toLowerCase()
  const from = getEnv('EMAIL_FROM') ?? 'Alpha AI Workspace <no-reply@alpha.example>'
  const subject = 'Your Alpha AI Workspace sign-in code'
  const text = [
    `Your sign-in code is: ${code}`,
    '',
    `Or open this link to sign in: ${magicUrl}`,
    '',
    `This code expires in ${expiresMinutes} minutes.`
  ].join('\n')
  const html =
    `<p>Your sign-in code is <strong style="font-size:20px;letter-spacing:2px">${code}</strong>.</p>` +
    `<p>Or <a href="${magicUrl}">click here to sign in</a>.</p>` +
    `<p>This code expires in ${expiresMinutes} minutes.</p>`

  if (provider === 'resend') {
    const apiKey = getEnv('RESEND_API_KEY')
    if (!apiKey) throw new Error('EMAIL_PROVIDER=resend but RESEND_API_KEY is not set')
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from, to, subject, text, html })
    })
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      throw new Error(`Email send failed (${res.status}): ${detail.slice(0, 200)}`)
    }
    return
  }

  console.log(`[email:log] to=${to} code=${code} magic=${magicUrl}`)
}
