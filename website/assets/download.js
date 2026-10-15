// `/download` is the public entry point to a signed-in area.
//
// The installer link itself is never stored here and never resolved from a public
// URL: it comes from `GET /downloads/latest`, which requires the session and
// re-checks the account server-side. This page therefore has one job — send a
// visitor who already has a session straight to their account downloads, and
// otherwise explain how to get one.

const SESSION_KEY = 'alpha-website-session'

function hasSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY)
    if (!raw) return false
    const parsed = JSON.parse(raw)
    return Boolean(
      parsed && typeof parsed.accessToken === 'string' && typeof parsed.refreshToken === 'string'
    )
  } catch {
    // Storage blocked or unparsable: fall through to the sign-in gate.
    return false
  }
}

const status = document.querySelector('[data-status]')

if (hasSession()) {
  if (status) status.textContent = 'You are signed in — opening your downloads…'
  window.location.replace('/account#download')
}
