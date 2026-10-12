// Alpha Cloud account portal (website).
// Talks to the Neon Function API directly; sign-in methods come from the API.
import {
  api,
  clearSession,
  completeOAuthReturn,
  configured,
  googleStartUrl,
  loadSession,
  providers,
  requestedRedirect,
  setStatus,
  show,
  signInErrorFromUrl
} from './session.js'

const els = {
  notice: document.querySelector('[data-account-notice]'),
  signedOut: document.querySelector('[data-signed-out]'),
  signedIn: document.querySelector('[data-signed-in]'),
  form: document.querySelector('[data-signin-form]'),
  email: document.querySelector('[data-email]'),
  status: document.querySelector('[data-status]'),
  emailOut: document.querySelector('[data-email-out]'),
  plan: document.querySelector('[data-plan]'),
  interval: document.querySelector('[data-interval]'),
  subscription: document.querySelector('[data-subscription]'),
  usage: document.querySelector('[data-usage]'),
  models: document.querySelector('[data-models]'),
  announcements: document.querySelector('[data-announcements]'),
  signout: document.querySelector('[data-signout]'),
  refresh: document.querySelector('[data-refresh]'),
  google: document.querySelector('[data-google]'),
  googleWrap: document.querySelector('[data-google-wrap]'),
  signInMethods: document.querySelector('[data-signin-methods]'),
  downloadVersion: document.querySelector('[data-download-version]'),
  downloadLink: document.querySelector('[data-download-link]')
}

let session = loadSession()

function label(resource) {
  return (
    {
      tokens: 'Tokens used',
      messages: 'Messages',
      requests: 'Requests',
      audio_minutes: 'Audio minutes',
      storage: 'Storage'
    }[resource] || resource
  )
}

function renderPortal(cfg) {
  if (!cfg) return
  if (els.emailOut) els.emailOut.textContent = cfg.account?.email || session?.email || ''
  if (els.plan) els.plan.textContent = cfg.plan?.name || 'Free'
  if (els.interval) els.interval.textContent = cfg.plan?.interval ? `billed ${cfg.plan.interval}ly` : ''
  if (els.subscription) {
    els.subscription.textContent = cfg.subscription?.status
      ? `${cfg.subscription.status}${cfg.subscription.endsAt ? ' · until ' + new Date(cfg.subscription.endsAt).toLocaleDateString() : ''}`
      : ''
  }

  if (els.usage) {
    els.usage.innerHTML = ''
    const rows = (cfg.usage || []).filter((u) => !u.unlimited)
    if (!rows.length) {
      els.usage.innerHTML = '<li class="muted">No metered usage this period.</li>'
    }
    for (const u of rows) {
      const pct = u.limit ? Math.min(100, Math.round((u.used / u.limit) * 100)) : 0
      const li = document.createElement('li')
      li.innerHTML = `<div class="row"><span></span><span></span></div><div class="bar"><i></i></div>`
      li.querySelector('.row span:first-child').textContent = label(u.resource)
      li.querySelector('.row span:last-child').textContent = `${u.used}${u.limit ? ' / ' + u.limit : ''}`
      li.querySelector('.bar i').style.width = `${pct}%`
      els.usage.appendChild(li)
    }
  }

  if (els.models) {
    const available = (cfg.models || []).filter((m) => m.allowed)
    els.models.textContent = available.length
      ? `${available.length} cloud model${available.length === 1 ? '' : 's'} available on your plan.`
      : 'No cloud models are included in your current plan. Local models work in the desktop app.'
  }

  if (els.announcements) {
    els.announcements.innerHTML = ''
    for (const a of cfg.announcements || []) {
      const div = document.createElement('div')
      div.className = `announce ${a.level || 'info'}`
      div.innerHTML = '<strong></strong><p></p>'
      div.querySelector('strong').textContent = a.title || ''
      div.querySelector('p').textContent = a.body || ''
      els.announcements.appendChild(div)
    }
    show(els.announcements, (cfg.announcements || []).length > 0)
  }
}

/** The download surface is authenticated, so this is the signed-in view of it. */
async function loadDownload() {
  if (!session) return
  try {
    const res = await api('/downloads/latest', { token: session.accessToken })
    const release = res?.release
    if (els.downloadVersion) {
      els.downloadVersion.textContent = release
        ? `Version ${release.version} for Windows`
        : 'No desktop release is published yet.'
    }
    if (els.downloadLink && release?.url) {
      els.downloadLink.href = release.url
      show(els.downloadLink, true)
    }
  } catch (error) {
    if (error.status === 401 || error.status === 403) {
      clearSession()
      session = null
      show(els.signedIn, false)
      show(els.signedOut, true)
      setStatus(els.status, error.message, 'error')
      return
    }
  }
}

async function loadPortal() {
  try {
    if (!session) return
    const cfg = await api('/platform/config', { token: session.accessToken })
    renderPortal(cfg)
    show(els.signedOut, false)
    show(els.signedIn, true)
    setStatus(els.status, '')
    await loadDownload()
  } catch (error) {
    if (error.status === 401) {
      clearSession()
      session = null
      show(els.signedIn, false)
      show(els.signedOut, true)
      setStatus(els.status, 'Your session expired. Sign in again.', 'error')
      return
    }
    setStatus(els.status, error.message || 'Failed to load account.', 'error')
  }
}

function wireSignOut() {
  els.signout?.addEventListener('click', async () => {
    try {
      if (session) await api('/auth/signout', { method: 'POST', token: session.accessToken })
    } catch {
      /* best effort */
    }
    clearSession()
    session = null
    show(els.signedIn, false)
    show(els.signedOut, true)
    setStatus(els.status, 'Signed out.', 'ok')
  })
  els.refresh?.addEventListener('click', () => void loadPortal())
}

function parseTokenFromUrl() {
  try {
    return new URLSearchParams(location.search).get('token')
  } catch {
    return null
  }
}

async function handleMagicLink() {
  const token = parseTokenFromUrl()
  if (!token) return
  setStatus(els.status, 'Verifying your sign-in link…', '')
  try {
    const res = await api('/auth/verify', { method: 'POST', body: { token } })
    if (res && res.accessToken && res.refreshToken) {
      session = { accessToken: res.accessToken, refreshToken: res.refreshToken, email: res.email }
      try {
        localStorage.setItem('alpha-website-session', JSON.stringify(session))
      } catch {
        /* ignore */
      }
      try {
        history.replaceState({}, '', location.pathname)
      } catch {
        /* ignore */
      }
      await loadPortal()
      setStatus(els.status, 'Signed in successfully.', 'ok')
    } else {
      setStatus(els.status, 'Verification failed. Request a new link.', 'error')
    }
  } catch (error) {
    setStatus(els.status, error.message || 'Verification failed.', 'error')
  }
}

async function init() {
  if (!configured) {
    if (els.notice) {
      els.notice.textContent = 'Alpha Cloud is not configured for this deployment yet.'
      show(els.notice, true)
    }
    return
  }

  const urlError = signInErrorFromUrl()
  if (urlError) setStatus(els.status, urlError, 'error')

  // Finish a Google return before anything else, so the portal can render for it.
  const returned = await completeOAuthReturn()
  if (returned?.error) setStatus(els.status, returned.error, 'error')
  if (returned?.session) session = returned.session

  // Offer only the methods this deployment actually has.
  const caps = await providers()
  show(els.googleWrap, caps.google)
  show(els.signInMethods, caps.google || caps.otp)
  els.google?.addEventListener('click', () => {
    setStatus(els.status, 'Taking you to Google…', '')
    location.href = googleStartUrl(requestedRedirect('/account.html'))
  })

  els.form?.addEventListener('submit', async (e) => {
    e.preventDefault()
    const email = els.email?.value?.trim()
    if (!email) return
    setStatus(els.status, 'Sending a secure sign-in code/link…', '')
    try {
      await api('/auth/request', { method: 'POST', body: { email } })
      setStatus(els.status, 'Check your email for the sign-in link.', 'ok')
    } catch (error) {
      setStatus(els.status, error.message || 'Could not send the sign-in link.', 'error')
    }
  })

  wireSignOut()
  await handleMagicLink()

  if (returned?.session && !els.status?.textContent && !parseTokenFromUrl()) {
    setStatus(els.status, 'Signed in with Google.', 'ok')
  }

  if (session) {
    await loadPortal()
  } else {
    show(els.signedOut, true)
    show(els.signedIn, false)
  }
}

void init()
