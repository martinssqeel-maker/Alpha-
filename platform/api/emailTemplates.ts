// Alpha AI Workspace — transactional email templates.
//
// Constraints that shaped this file:
//
//   * Email clients are not browsers. Layout is nested `<table>` with inline
//     styles, no flex/grid, no external CSS, and no remote images — a blocked
//     image is a broken brand mark, so the wordmark is set in text.
//   * Every message ships a plain-text alternative. A code-only email is useless
//     to a screen reader that renders the HTML as one line, and unusable to a
//     client that strips HTML, so both parts carry the full content.
//   * Contrast is deliberate: white on `#5b3ce0` (about 6.3:1) rather than the
//     lighter marketing purple, which fails AA at button sizes.
//   * Nothing here is trusted input except the values interpolated below, and
//     those are escaped for the context they land in — text or attribute — so an
//     address or a link can never break out of the markup.

const BRAND = '#5b3ce0'
const INK = '#10182a'
const BODY = '#4a5468'
const MUTED = '#6b7280'
const HAIRLINE = '#e6e8ee'
const CANVAS = '#f4f5f8'

/** Escape for an HTML text node. */
function text(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

/** Escape for an HTML attribute value (href, title). */
function attr(value: string): string {
  return text(value)
}

export interface RenderedEmail {
  subject: string
  preheader: string
  html: string
  text: string
}

export interface SignInEmailInput {
  code: string
  magicUrl: string
  expiresMinutes: number
  /** Website origin, used for the footer's privacy and terms links. */
  siteUrl: string
}

/**
 * The sign-in email: a six-digit code for the in-page form and a one-tap link
 * for the same sign-in. Both are single-use and expire together.
 */
export function renderSignInEmail({
  code,
  magicUrl,
  expiresMinutes,
  siteUrl
}: SignInEmailInput): RenderedEmail {
  const site = siteUrl.replace(/\/+$/, '')
  const subject = `Your Alpha sign-in code: ${code}`
  const preheader = `Use code ${code} or tap the link to sign in. It expires in ${expiresMinutes} minutes.`
  const expiry = `This code and link expire in ${expiresMinutes} ${expiresMinutes === 1 ? 'minute' : 'minutes'}.`

  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="light" />
    <title>${text(subject)}</title>
  </head>
  <body style="margin:0;padding:0;background:${CANVAS};">
    <!-- Shown by the inbox next to the subject line; hidden in the message body. -->
    <div style="display:none;font-size:1px;color:${CANVAS};line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">
      ${text(preheader)}
    </div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${CANVAS};">
      <tr>
        <td align="center" style="padding:32px 16px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;background:#ffffff;border:1px solid ${HAIRLINE};border-radius:14px;">
            <tr>
              <td style="padding:28px 32px 8px 32px;font-family:'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
                <div style="font-size:13px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:${BRAND};">
                  Alpha AI Workspace
                </div>
              </td>
            </tr>
            <tr>
              <td style="padding:8px 32px 0 32px;font-family:'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
                <h1 style="margin:0 0 12px 0;font-size:22px;line-height:1.3;font-weight:700;color:${INK};">
                  Your sign-in code
                </h1>
                <p style="margin:0;font-size:15px;line-height:1.6;color:${BODY};">
                  Enter this code on the Alpha sign-in page:
                </p>
              </td>
            </tr>
            <tr>
              <td style="padding:20px 32px 4px 32px;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f6f4ff;border:1px solid #e2dcff;border-radius:10px;">
                  <tr>
                    <td align="center" style="padding:18px 12px;">
                      <span style="font-family:'Cascadia Mono',Consolas,Menlo,monospace;font-size:32px;font-weight:700;letter-spacing:8px;color:${INK};">
                        ${text(code)}
                      </span>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td align="center" style="padding:22px 32px 6px 32px;">
                <a href="${attr(magicUrl)}" style="display:inline-block;background:${BRAND};color:#ffffff;font-family:'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:15px;font-weight:600;line-height:1;text-decoration:none;padding:15px 28px;border-radius:9px;">
                  Sign in to Alpha
                </a>
              </td>
            </tr>
            <tr>
              <td align="center" style="padding:6px 32px 0 32px;font-family:'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
                <p style="margin:0;font-size:13px;line-height:1.6;color:${MUTED};">
                  Button not working? Open this link instead:
                </p>
                <p style="margin:6px 0 0 0;font-family:'Cascadia Mono',Consolas,Menlo,monospace;font-size:12px;line-height:1.6;color:${BODY};word-break:break-all;">
                  <a href="${attr(magicUrl)}" style="color:${BRAND};text-decoration:underline;">${text(magicUrl)}</a>
                </p>
              </td>
            </tr>
            <tr>
              <td style="padding:24px 32px 0 32px;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f8f9fc;border-left:3px solid ${BRAND};border-radius:6px;">
                  <tr>
                    <td style="padding:14px 16px;font-family:'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:13px;line-height:1.6;color:${BODY};">
                      <strong style="color:${INK};">${text(expiry)}</strong><br />
                      If you did not try to sign in, ignore this email — the code cannot be used
                      without it, and no one can sign in with your address until then.
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td style="padding:22px 32px 28px 32px;font-family:'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
                <p style="margin:0;font-size:12px;line-height:1.6;color:${MUTED};">
                  Alpha AI Workspace — a local-first AI development cockpit for Windows.
                </p>
              </td>
            </tr>
          </table>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;">
            <tr>
              <td align="center" style="padding:16px 8px 0 8px;font-family:'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:12px;line-height:1.6;color:${MUTED};">
                <a href="${attr(`${site}/privacy`)}" style="color:${BRAND};text-decoration:underline;">Privacy</a>
                &nbsp;·&nbsp;
                <a href="${attr(`${site}/terms`)}" style="color:${BRAND};text-decoration:underline;">Terms</a>
                &nbsp;·&nbsp;
                <a href="https://github.com/martinssqeel-maker/Alpha-" style="color:${BRAND};text-decoration:underline;">GitHub</a>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`

  const text_ = [
    'Alpha AI Workspace',
    '',
    'Your sign-in code',
    '',
    `    ${code}`,
    '',
    'Enter it on the Alpha sign-in page, or open this link to sign in:',
    magicUrl,
    '',
    expiry,
    '',
    'If you did not try to sign in, ignore this email — the code cannot be used',
    'without it, and no one can sign in with your address until then.',
    '',
    'Alpha AI Workspace — a local-first AI development cockpit for Windows.',
    `Privacy: ${site}/privacy`,
    `Terms:   ${site}/terms`,
    ''
  ].join('\n')

  return { subject, preheader, html, text: text_ }
}
