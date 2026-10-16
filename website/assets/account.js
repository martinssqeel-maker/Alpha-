// Alpha AI Workspace — account page.
//
// Sign-in is a server-side redirect: this page never sees a provider secret and
// never receives a session token in a URL. The API hands the browser back a
// *single-use* code, which is exchanged over POST for the real tokens.
//
// Tokens are kept in localStorage. The API is Bearer-only — it sets no cookies
// and narrows CORS to the site origin — so there is no cookie-based alternative
// available here. That is acceptable because this page renders no third-party or
// user-authored content, which is what would make XSS token theft realistic.

const STORAGE_KEY = 'alpha-website-session'
/** Refresh this long before the access token actually lapses. */
const REFRESH_MARGIN_MS = 60_000
const REQUEST_TIMEOUT_MS = 15_000

const els = {
  cardTitle: document.querySelector('[data-card-title]'),
  cardLede: document.querySelector('[data-card-lede]'),
  loading: document.querySelector('[data-view="loading"]'),
  unconfigured: document.querySelector('[data-view="unconfigured"]'),
  signedOut: document.querySelector('[data-view="signed-out"]'),
  signedIn: document.querySelector('[data-view="signed-in"]'),
  providers: document.querySelector('[data-providers]'),
  emailForm: document.querySelector('[data-email-form]'),
  emailInput: document.querySelector('#account-email'),
  emailSubmit: document.querySelector('[data-email-submit]'),
  codeForm: document.querySelector('[data-code-form]'),
  codeInput: document.querySelector('#account-code'),
  codeSubmit: document.querySelector('[data-code-submit]'),
  status: document.querySelector('[data-status]'),
  accountEmail: document.querySelector('[data-account-email]'),
  accountPlan: document.querySelector('[data-account-plan]'),
  accountUsage: document.querySelector('[data-account-usage]'),
  usageRows: document.querySelector('[data-usage-rows]'),
  accountModels: document.querySelector('[data-account-models]'),
  signOut: document.querySelector('[data-signout]'),
  pageTitle: document.querySelector('[data-page-title]'),
  pageSub: document.querySelector('[data-page-sub]'),
  downloadLoading: document.querySelector('[data-download-view="loading"]'),
  downloadUnavailable: document.querySelector('[data-download-view="unavailable"]'),
  downloadReady: document.querySelector('[data-download-view="ready"]'),
  downloadMessage: document.querySelector('[data-download-message]'),
  downloadVersion: document.querySelector('[data-download-version]'),
  downloadMeta: document.querySelector('[data-download-meta]'),
  downloadNotes: document.querySelector('[data-download-notes]'),
  downloadChecksum: document.querySelector('[data-download-checksum]'),
  downloadLink: document.querySelector('[data-download-link]')
}

// `?mode=signup` frames the same passwordless flow as account creation. There is
// no separate endpoint to call: the API provisions the account on the first
// verified sign-in, so arriving from a "Sign up" link only changes what the card
// says and which way the toggle under it points.
if (new URLSearchParams(window.location.search).get('mode') === 'signup') {
  document.title = 'Create an account · Alpha AI Workspace'
  if (els.cardTitle) els.cardTitle.textContent = 'Create your account'
  if (els.cardLede) {
    els.cardLede.innerHTML =
      'Create your Alpha account with Google, GitHub or your email — no password needed. ' +
      'Already have one? <a data-mode-link href="/account">Sign in</a>.'
  }
  if (els.emailSubmit) els.emailSubmit.textContent = 'Email me a sign-up link'
}

// `/download` forwards here with `?next=download` because the installer is only
// handed to a signed-in account. The page says why the visitor landed here
// instead of showing a download they cannot have yet.
if (new URLSearchParams(window.location.search).get('next') === 'download') {
  document.title = 'Sign in to download · Alpha AI Workspace'
  if (els.pageTitle) els.pageTitle.textContent = 'Sign in to download the app'
  if (els.pageSub) {
    els.pageSub.textContent =
      'The Windows installer is served to signed-in Alpha accounts. Sign in or create one — ' +
      'it takes a moment and there is no password.'
  }
  if (els.cardTitle && !els.cardTitle.textContent.startsWith('Create')) {
    els.cardTitle.textContent = 'Sign in to continue'
  }
}

/** The committed config.js supplies the API host; empty means "not configured". */
function apiBase() {
  const value = window.ALPHA_PLATFORM && window.ALPHA_PLATFORM.apiBaseUrl
  if (typeof value !== 'string') return null
  const trimmed = value.trim().replace(/\/+$/, '')
  return trimmed || null
}

function setStatus(message, kind) {
  if (!els.status) return
  els.status.textContent = message || ''
  els.status.dataset.kind = kind || ''
}

function show(view) {
  for (const key of ['loading', 'unconfigured', 'signedOut', 'signedIn']) {
    const el = els[key]
    if (el) el.hidden = key !== view
  }
}

/**
 * Human wording for every failure the API can send back. Anything unmapped still
 * shows something useful rather than a silent dead end.
 */
const ERROR_TEXT = {
  access_denied: 'You cancelled the sign-in. Nothing was changed.',
  email_not_verified: 'That provider has not verified your email address, so we cannot use it to sign in.',
  account_inactive: 'This account is suspended. Contact support if you think that is a mistake.',
  account_unavailable: 'We could not set up an account for that sign-in. Try a different method.',
  google_verification_failed: 'Google sign-in could not be verified. Please try again.',
  github_verification_failed: 'GitHub sign-in could not be verified. Please try again.',
  // Distinguished from the verification failures above on purpose: these mean the
  // server's provider credentials were rejected, so retrying cannot help.
  google_misconfigured: 'Google rejected this deployment\'s sign-in credentials, so Google sign-in is unavailable here. Please use email or GitHub, and let the site administrator know.',
  github_misconfigured: 'GitHub rejected this deployment\'s sign-in credentials, so GitHub sign-in is unavailable here. Please use email or Google, and let the site administrator know.',
  missing_code: 'That sign-in came back incomplete. Please start it again.',
  invalid_state: 'That sign-in attempt expired. Please start it again.',
  invalid_code: 'That sign-in link has expired or was already used. Request a new one.',
  invalid_refresh: 'Your session expired. Please sign in again.',
  invalid_redirect: 'This site is not allowed to complete sign-in for that deployment.',
  google_not_configured: 'Google sign-in is not enabled on this deployment yet.',
  github_not_configured: 'GitHub sign-in is not enabled on this deployment yet.',
  maintenance: 'Alpha is in maintenance mode right now. Please try again shortly.',
  invalid_email: 'That email address does not look right.',
  expired: 'That code has expired. Request a new one.',
  too_many: 'Too many attempts. Wait a moment and request a new code.',
  too_many_requests: 'Too many sign-in emails have been asked for. Wait a few minutes, then request one more.',
  email_delivery_failed: 'We could not send the sign-in email. Please try again in a moment.'
}

function errorText(code, fallback) {
  if (code && ERROR_TEXT[code]) return ERROR_TEXT[code]
  if (fallback) return fallback
  return 'Something went wrong while signing in. Please try again.'
}

/** One fetch helper with a timeout, so a hanging API never freezes the page. */
async function api(path, options = {}) {
  const base = apiBase()
  if (!base) throw new Error('not_configured')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? REQUEST_TIMEOUT_MS)
  try {
    const headers = { Accept: 'application/json' }
    if (options.body !== undefined) headers['Content-Type'] = 'application/json'
    if (options.token) headers.Authorization = `Bearer ${options.token}`
    const res = await fetch(`${base}${path}`, {
      method: options.method ?? 'GET',
      headers,
      // Bearer only: never send or accept cookies from an API call.
      credentials: 'omit',
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: controller.signal
    })
    let json = null
    try {
      json = await res.json()
    } catch {
      /* some failures answer with an empty body */
    }
    return { status: res.status, ok: res.ok, json }
  } finally {
    clearTimeout(timer)
  }
}

function readSession() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed.accessToken !== 'string' || typeof parsed.refreshToken !== 'string') {
      return null
    }
    return parsed
  } catch {
    return null
  }
}

function writeSession(session) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(session))
  } catch {
    /* storage blocked: the session simply does not persist across reloads */
  }
}

function clearSession() {
  try {
    localStorage.removeItem(STORAGE_KEY)
  } catch {
    /* nothing to do */
  }
}

/** Strip one-time codes and tokens from the address bar so they cannot be shared or replayed. */
function cleanUrl() {
  try {
    const url = new URL(window.location.href)
    for (const key of ['code', 'token', 'email', 'error']) url.searchParams.delete(key)
    const query = url.searchParams.toString()
    window.history.replaceState({}, '', `${url.pathname}${query ? `?${query}` : ''}`)
  } catch {
    /* older browsers: leave the URL alone */
  }
}

function formatLimit(item) {
  if (item.unlimited) return 'Unlimited'
  return item.limit === null || item.limit === undefined ? '—' : String(item.limit)
}

function renderUsage(usage) {
  if (!els.usageRows || !els.accountUsage) return
  const rows = Array.isArray(usage) ? usage : []
  if (rows.length === 0) {
    els.accountUsage.hidden = true
    return
  }
  els.usageRows.innerHTML = ''
  for (const item of rows) {
    const tr = document.createElement('tr')
    const name = document.createElement('td')
    name.textContent = String(item.resource ?? 'usage')
    const used = document.createElement('td')
    used.textContent = String(item.used ?? 0)
    const limit = document.createElement('td')
    limit.textContent = formatLimit(item)
    tr.append(name, used, limit)
    els.usageRows.append(tr)
  }
  els.accountUsage.hidden = false
}

function renderSignedIn(session, config) {
  const account = config && config.account ? config.account : null
  const plan = config && config.plan ? config.plan : null

  if (els.accountEmail) {
    els.accountEmail.textContent = (account && account.email) || session.email || 'Signed in'
  }
  if (els.accountPlan) {
    const parts = []
    parts.push(plan && plan.name ? `Plan: ${plan.name}` : 'Plan: Free')
    if (config && config.subscription && config.subscription.status) {
      parts.push(`subscription ${config.subscription.status}`)
    }
    els.accountPlan.textContent = parts.join(' · ')
  }
  renderUsage(config ? config.usage : [])
  if (els.accountModels) {
    const models = config && Array.isArray(config.models) ? config.models : []
    const allowed = models.filter((m) => m && m.allowed).length
    els.accountModels.textContent =
      models.length > 0
        ? `${allowed} of ${models.length} cloud models available on this plan.`
        : 'No cloud models are published on this deployment yet.'
  }
  show('signedIn')
}

function formatSize(bytes) {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes <= 0) return null
  const mb = bytes / (1024 * 1024)
  return `${mb.toFixed(mb >= 100 ? 0 : 1)} MB`
}

function formatDate(value) {
  if (!value) return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date.toLocaleDateString()
}

function setDownloadState(state, message) {
  const views = {
    loading: els.downloadLoading,
    unavailable: els.downloadUnavailable,
    ready: els.downloadReady
  }
  for (const key of Object.keys(views)) {
    if (views[key]) views[key].hidden = key !== state
  }
  if (message && els.downloadMessage) els.downloadMessage.textContent = message
}

/**
 * The installer link comes from `/downloads/latest`, which requires the session
 * and re-checks the account in the database on every call. There is deliberately
 * no public fallback here: if the API refuses, the page says so rather than
 * handing out an installer the account is not entitled to.
 */
async function renderDownloads(session) {
  if (!els.downloadLoading) return
  setDownloadState('loading')
  try {
    const res = await api('/downloads/latest', { token: session.accessToken })
    if (res.status === 401) {
      setDownloadState('unavailable', 'Your session ended before the download could be loaded. Sign in again.')
      return
    }
    if (!res.ok) {
      const message = res.json && res.json.error ? res.json.error.message : null
      setDownloadState(
        'unavailable',
        message || 'The download service did not answer. Try again in a moment.'
      )
      return
    }

    const release = res.json && res.json.release ? res.json.release : null
    if (!release || !release.url) {
      setDownloadState('unavailable', 'No desktop release is published for this deployment yet.')
      return
    }

    if (els.downloadVersion) els.downloadVersion.textContent = release.version
    if (els.downloadMeta) {
      const parts = ['Windows installer']
      const size = formatSize(release.size)
      if (size) parts.push(size)
      const released = formatDate(release.releasedAt)
      if (released) parts.push(`released ${released}`)
      els.downloadMeta.textContent = parts.join(' · ')
    }
    if (els.downloadLink) els.downloadLink.href = release.url
    if (els.downloadNotes) {
      els.downloadNotes.textContent = release.notes || ''
      els.downloadNotes.hidden = !release.notes
    }
    if (els.downloadChecksum) {
      els.downloadChecksum.textContent = release.sha512 ? `SHA-512 ${release.sha512}` : ''
      els.downloadChecksum.hidden = !release.sha512
    }
    setDownloadState('ready')
  } catch (error) {
    setDownloadState(
      'unavailable',
      error && error.message === 'not_configured'
        ? 'This site has no API address configured, so the download cannot be verified.'
        : 'Could not reach the download service. Check your connection and try again.'
    )
  }
}

/** Keep the access token fresh so a visit never bounces the user back to sign-in. */
async function ensureFresh(session) {
  const expiresAt = typeof session.expiresAt === 'number' ? session.expiresAt : 0
  if (expiresAt && expiresAt - Date.now() > REFRESH_MARGIN_MS) return session
  const res = await api('/auth/refresh', {
    method: 'POST',
    body: { refreshToken: session.refreshToken }
  })
  if (!res.ok || !res.json || !res.json.accessToken) {
    const code = res.json && res.json.error ? res.json.error.code : null
    throw new Error(code || 'invalid_refresh')
  }
  const next = {
    accessToken: res.json.accessToken,
    refreshToken: res.json.refreshToken,
    expiresAt: res.json.expiresAt,
    email: res.json.email || session.email
  }
  writeSession(next)
  return next
}

/** Adopt a freshly minted session from a successful verify/exchange. */
function adopt(json, fallbackEmail) {
  const session = {
    accessToken: json.accessToken,
    refreshToken: json.refreshToken,
    expiresAt: json.expiresAt,
    email: json.email || fallbackEmail || null
  }
  writeSession(session)
  return session
}

/**
 * Render one button per provider the deployment actually offers. Asking first
 * avoids showing a button whose only possible answer is "not configured".
 */
async function renderProviders() {
  if (!els.providers) return
  let summary = null
  try {
    const res = await api('/auth/providers')
    summary = res.ok ? res.json : null
  } catch {
    summary = null
  }
  if (!summary) {
    // The card still describes Google and GitHub at this point, but nothing has
    // confirmed they exist here. Rather than leave that claim standing, the lede
    // drops back to what the page can actually offer.
    if (els.cardLede) {
      els.cardLede.textContent =
        'Enter your email address and we will send a six-digit code and a one-tap ' +
        'sign-in link. New to Alpha? It creates the account.'
    }
    setStatus(
      'Could not reach the sign-in service from this page. Check your connection and reload — ' +
        'if it keeps failing, this site\u2019s address may not be on the service\u2019s allowed list.',
      'error'
    )
    return
  }

  const wanted = [
    {
      key: 'google',
      label: 'Continue with Google',
      svg: '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M21.6 12.2c0-.7-.06-1.36-.18-2H12v3.79h5.4a4.62 4.62 0 0 1-2 3.03v2.51h3.23c1.89-1.74 2.97-4.3 2.97-7.33Z"/><path d="M12 22c2.7 0 4.96-.9 6.62-2.43l-3.23-2.51c-.9.6-2.05.96-3.39.96-2.6 0-4.8-1.76-5.59-4.12H3.08v2.59A10 10 0 0 0 12 22Z"/><path d="M6.41 13.9a6 6 0 0 1 0-3.8V7.51H3.08a10 10 0 0 0 0 8.98l3.33-2.59Z"/><path d="M12 5.98c1.47 0 2.79.5 3.83 1.5l2.86-2.86C16.95 2.99 14.7 2 12 2A10 10 0 0 0 3.08 7.51l3.33 2.59C7.2 7.74 9.4 5.98 12 5.98Z"/></svg>'
    },
    {
      key: 'github',
      label: 'Continue with GitHub',
      svg: '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 .5A11.5 11.5 0 0 0 .5 12a11.5 11.5 0 0 0 7.86 10.94c.58.1.79-.25.79-.56v-2c-3.2.7-3.88-1.36-3.88-1.36-.53-1.34-1.3-1.7-1.3-1.7-1.06-.72.08-.71.08-.71 1.17.08 1.79 1.2 1.79 1.2 1.04 1.79 2.73 1.27 3.4.97.1-.75.4-1.27.73-1.56-2.55-.29-5.23-1.28-5.23-5.7 0-1.26.45-2.29 1.19-3.1-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.18 1.18a11 11 0 0 1 5.8 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.12 3.05.74.81 1.18 1.84 1.18 3.1 0 4.43-2.69 5.4-5.25 5.69.41.35.77 1.05.77 2.12v3.14c0 .31.21.67.8.56A11.5 11.5 0 0 0 23.5 12 11.5 11.5 0 0 0 12 .5Z"/></svg>'
    }
  ]

  els.providers.innerHTML = ''
  for (const provider of wanted) {
    if (summary[provider.key] !== true) continue
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'btn primary provider-btn'
    button.innerHTML = `${provider.svg}<span>${provider.label}</span>`
    button.addEventListener('click', () => startProvider(provider.key))
    els.providers.append(button)
  }
  els.providers.hidden = els.providers.children.length === 0
}

/**
 * Hand the browser to the API's own start route, which 302s on to the provider.
 * `redirect` must be an origin the deployment allows, so it is always derived
 * from this page rather than hardcoded.
 */
function startProvider(provider) {
  const base = apiBase()
  if (!base) return
  setStatus('Opening the provider…', '')
  const target = `${window.location.origin}/account`
  const url = `${base}/auth/${provider}/start?redirect=${encodeURIComponent(target)}`
  window.location.assign(url)
}

function bindEmailForm() {
  if (!els.emailForm) return
  els.emailForm.addEventListener('submit', async (event) => {
    event.preventDefault()
    const email = (els.emailInput && els.emailInput.value ? els.emailInput.value : '').trim()
    if (!email) {
      setStatus('Enter your email address first.', 'error')
      return
    }
    if (els.emailSubmit) els.emailSubmit.disabled = true
    setStatus('Sending your sign-in link…', '')
    try {
      const res = await api('/auth/request', { method: 'POST', body: { email } })
      if (res.status === 200 && res.ok) {
        const data = res.json || {}
        const minutes = data.expiresInMinutes ? data.expiresInMinutes : 10
        if (data.delivered === false && !data.alreadySent) {
          // The API says plainly that it delivered nothing (the `log` transport).
          // Telling someone to go and check an inbox would send them to wait for
          // a message that was never sent.
          setStatus(
            `This deployment is not delivering email yet, so nothing was sent to ${email}. ` +
              'Please tell the site operator to finish the email configuration.',
            'error'
          )
        } else if (data.alreadySent) {
          if (els.codeForm) els.codeForm.hidden = false
          setStatus(data.message || `A sign-in code was already sent to ${email}.`, 'ok')
        } else {
          if (els.codeForm) els.codeForm.hidden = false
          setStatus(
            `Check ${email} — we sent a sign-in link and a six-digit code. They expire in ${minutes} minutes.`,
            'ok'
          )
        }
      } else {
        const code = res.json && res.json.error ? res.json.error.code : null
        const message = res.json && res.json.error ? res.json.error.message : null
        setStatus(errorText(code, message), 'error')
      }
    } catch (error) {
      setStatus(
        error && error.message === 'not_configured'
          ? 'This site has no API address configured.'
          : 'Could not reach the sign-in service. Check your connection and try again.',
        'error'
      )
    } finally {
      if (els.emailSubmit) els.emailSubmit.disabled = false
    }
  })
}

function bindCodeForm() {
  if (!els.codeForm) return
  els.codeForm.addEventListener('submit', async (event) => {
    event.preventDefault()
    const email = (els.emailInput && els.emailInput.value ? els.emailInput.value : '').trim()
    const code = (els.codeInput && els.codeInput.value ? els.codeInput.value : '').trim()
    if (!email || !code) {
      setStatus('Enter the email address and the six-digit code.', 'error')
      return
    }
    if (els.codeSubmit) els.codeSubmit.disabled = true
    setStatus('Checking your code…', '')
    try {
      const res = await api('/auth/verify', { method: 'POST', body: { email, code } })
      if (res.ok && res.json && res.json.accessToken) {
        adopt(res.json, email)
        cleanUrl()
        await showSignedIn(res.json.email || email)
        setStatus('You are signed in.', 'ok')
      } else {
        const errCode = res.json && res.json.error ? res.json.error.code : null
        const message = res.json && res.json.error ? res.json.error.message : null
        setStatus(errorText(errCode, message), 'error')
      }
    } catch {
      setStatus('Could not reach the sign-in service. Check your connection and try again.', 'error')
    } finally {
      if (els.codeSubmit) els.codeSubmit.disabled = false
    }
  })
}

async function showSignedIn(email) {
  const session = readSession()
  if (!session) {
    show('signedOut')
    return
  }
  renderSignedIn(session, null)
  try {
    const res = await api('/platform/config', { token: session.accessToken })
    if (res.ok && res.json) renderSignedIn(session, res.json)
  } catch {
    /* the session is still valid; only the extra detail failed to load */
  }
  // A download failure must never break the account view, so it is isolated here.
  try {
    await renderDownloads(session)
  } catch {
    setDownloadState('unavailable', 'Could not load the download details.')
  }
}

function bindSignOut() {
  if (!els.signOut) return
  els.signOut.addEventListener('click', async () => {
    const session = readSession()
    els.signOut.disabled = true
    try {
      // Revoke server-side first; a failure here must not trap the user signed in.
      if (session) await api('/auth/signout', { method: 'POST', token: session.accessToken })
    } catch {
      /* local sign-out below is what the visitor asked for */
    } finally {
      clearSession()
      els.signOut.disabled = false
      setDownloadState('loading', '')
      if (els.downloadVersion) els.downloadVersion.textContent = ''
      if (els.downloadLink) els.downloadLink.removeAttribute('href')
      if (els.codeForm) els.codeForm.hidden = true
      if (els.emailInput) els.emailInput.value = ''
      if (els.codeInput) els.codeInput.value = ''
      await renderProviders()
      show('signedOut')
      setStatus('Signed out.', 'ok')
    }
  })
}

async function init() {
  if (!apiBase()) {
    show('unconfigured')
    setStatus('No Alpha Cloud API address is configured for this site.', 'error')
    return
  }

  const params = new URLSearchParams(window.location.search)
  const errorCode = params.get('error')
  const code = params.get('code')
  const magicToken = params.get('token')
  const magicEmail = params.get('email')

  bindEmailForm()
  bindCodeForm()
  bindSignOut()

  // 1. A provider sent us back with a failure.
  if (errorCode) {
    cleanUrl()
    await renderProviders()
    show('signedOut')
    setStatus(errorText(errorCode), 'error')
    return
  }

  // 2. A provider sent us back with a single-use code: exchange it for a session.
  if (code) {
    setStatus('Finishing sign-in…', '')
    try {
      const res = await api('/auth/oauth/exchange', { method: 'POST', body: { code } })
      if (res.ok && res.json && res.json.accessToken) {
        const session = adopt(res.json)
        cleanUrl()
        await renderProviders()
        await showSignedIn(session.email)
        setStatus('You are signed in.', 'ok')
        return
      }
      const errCode = res.json && res.json.error ? res.json.error.code : null
      const message = res.json && res.json.error ? res.json.error.message : null
      setStatus(errorText(errCode, message), 'error')
    } catch {
      setStatus('Could not finish sign-in. Please try again.', 'error')
    }
    cleanUrl()
    await renderProviders()
    show('signedOut')
    return
  }

  // 3. An emailed one-tap link: same single-use code shape, different endpoint.
  if (magicToken && magicEmail) {
    setStatus('Signing you in…', '')
    try {
      const res = await api('/auth/verify', {
        method: 'POST',
        body: { email: magicEmail, token: magicToken }
      })
      if (res.ok && res.json && res.json.accessToken) {
        const session = adopt(res.json, magicEmail)
        cleanUrl()
        await renderProviders()
        await showSignedIn(session.email)
        setStatus('You are signed in.', 'ok')
        return
      }
      const errCode = res.json && res.json.error ? res.json.error.code : null
      const message = res.json && res.json.error ? res.json.error.message : null
      setStatus(errorText(errCode, message), 'error')
    } catch {
      setStatus('Could not complete that sign-in link. Please try again.', 'error')
    }
    cleanUrl()
    await renderProviders()
    show('signedOut')
    return
  }

  // 4. An existing session: refresh it and show the account.
  await renderProviders()
  const session = readSession()
  if (session) {
    try {
      const fresh = await ensureFresh(session)
      await showSignedIn(fresh.email)
      return
    } catch (error) {
      clearSession()
      const errCode = error && error.message ? error.message : null
      setStatus(
        errCode && errCode !== 'invalid_refresh'
          ? errorText(errCode)
          : 'Your session expired. Please sign in again.',
        errCode && errCode !== 'invalid_refresh' ? 'error' : ''
      )
    }
  }
  show('signedOut')
}

void init()
