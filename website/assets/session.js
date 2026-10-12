// Shared session + API helpers for the website (account portal and download page).
//
// The website talks to the Neon Function directly with a bearer token. Sign-in
// methods are discovered from the API rather than hard-coded, so a method that is
// not configured on the deployment is never offered.

const config = window.ALPHA_PLATFORM || {}
export const apiBase = (config.apiBaseUrl || '').replace(/\/+$/, '')
export const configured = Boolean(apiBase)

const STORAGE_KEY = 'alpha-website-session'

export async function api(path, opts = {}) {
  if (!apiBase) throw new Error('Alpha Cloud is not configured for this deployment.')
  const headers = { 'Content-Type': 'application/json' }
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`
  let res
  try {
    res = await fetch(`${apiBase}${path}`, {
      method: opts.method || 'GET',
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body)
    })
  } catch (error) {
    throw new Error('Could not reach Alpha Cloud. Check your connection and try again.')
  }
  const text = await res.text().catch(() => '')
  let body = null
  if (text) {
    try {
      body = JSON.parse(text)
    } catch {
      body = text
    }
  }
  if (!res.ok) {
    const message =
      body && typeof body === 'object' && body.error
        ? body.error.message
        : text || `Request failed (${res.status})`
    const error = new Error(message)
    error.status = res.status
    error.code = body && typeof body === 'object' && body.error ? body.error.code : undefined
    throw error
  }
  return body
}

export function loadSession() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (parsed && parsed.accessToken && parsed.refreshToken) return parsed
  } catch {
    /* ignore */
  }
  return null
}

export function storeSession(session) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(session))
  } catch {
    /* ignore */
  }
}

export function clearSession() {
  try {
    localStorage.removeItem(STORAGE_KEY)
  } catch {
    /* ignore */
  }
}

/** Which sign-in methods this deployment actually supports. */
export async function providers() {
  try {
    const res = await api('/auth/providers')
    return { google: Boolean(res && res.google), password: Boolean(res && res.password), otp: true }
  } catch {
    return { google: false, password: false, otp: true }
  }
}

/** Where the API should send the browser back to. Only same-site paths are honoured. */
export function requestedRedirect(fallback = '/account.html') {
  try {
    const raw = new URLSearchParams(location.search).get('redirect')
    if (!raw) return fallback
    if (!raw.startsWith('/') || raw.startsWith('//')) return fallback
    return raw
  } catch {
    return fallback
  }
}

export function googleStartUrl(redirectPath) {
  const target = `${location.origin}${redirectPath.startsWith('/') ? redirectPath : `/${redirectPath}`}`
  return `${apiBase}/auth/google/start?redirect=${encodeURIComponent(target)}`
}

const OAUTH_ERRORS = {
  access_denied: 'Google sign-in was cancelled.',
  email_not_verified: 'That Google account has no verified email address.',
  account_inactive: 'This account is not active. Contact support.',
  google_verification_failed: 'We could not verify that Google sign-in. Please try again.',
  invalid_state: 'That sign-in attempt expired. Please try again.',
  missing_code: 'Google did not return a sign-in code. Please try again.',
  account_unavailable: 'That account is unavailable. Please try again.'
}

/** Human message for a ?error= the API bounced back with, or null. */
export function signInErrorFromUrl() {
  try {
    const code = new URLSearchParams(location.search).get('error')
    if (!code) return null
    return OAUTH_ERRORS[code] || 'Sign-in failed. Please try again.'
  } catch {
    return null
  }
}

function stripQuery() {
  try {
    history.replaceState({}, '', location.pathname)
  } catch {
    /* ignore */
  }
}

/**
 * Finish a Google return: exchange the single-use `?code=` for real session
 * tokens (they never travel in the URL), then clean the address bar.
 */
export async function completeOAuthReturn() {
  let code = null
  try {
    code = new URLSearchParams(location.search).get('code')
  } catch {
    return null
  }
  if (!code) return null
  try {
    const res = await api('/auth/oauth/exchange', { method: 'POST', body: { code } })
    if (res && res.accessToken && res.refreshToken) {
      const session = {
        accessToken: res.accessToken,
        refreshToken: res.refreshToken,
        email: res.email
      }
      storeSession(session)
      stripQuery()
      return { session, error: null }
    }
    stripQuery()
    return { session: null, error: 'Sign-in failed. Please try again.' }
  } catch (error) {
    stripQuery()
    return { session: null, error: error.message || 'Sign-in failed. Please try again.' }
  }
}

/** Render a status line into an element. */
export function setStatus(el, message, kind) {
  if (!el) return
  el.textContent = message || ''
  el.dataset.kind = kind || ''
}

export function show(el, on) {
  if (el) el.hidden = !on
}
