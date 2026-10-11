// Alpha Cloud account portal (website).
// Uses the Neon Function API directly (no Supabase client).

const config = window.ALPHA_PLATFORM || {}
const configured = Boolean(config.apiBaseUrl)
const apiBase = (config.apiBaseUrl || '').replace(/\/+$/, '')

const els = {
  root: document.querySelector('[data-account-root]'),
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
  refresh: document.querySelector('[data-refresh]')
}

let session = null

function show(el, on) {
  if (el) el.hidden = !on
}

function setStatus(message, kind) {
  if (!els.status) return
  els.status.textContent = message || ''
  els.status.dataset.kind = kind || ''
}

function storeSession(s) {
  session = s
  try {
    localStorage.setItem('alpha-website-session', JSON.stringify(s))
  } catch (e) {
    /* ignore */
  }
}

function clearSession() {
  session = null
  try {
    localStorage.removeItem('alpha-website-session')
  } catch (e) {
    /* ignore */
  }
}

function loadStoredSession() {
  try {
    const raw = localStorage.getItem('alpha-website-session')
    if (!raw) return null
    const s = JSON.parse(raw)
    if (s && s.accessToken && s.refreshToken) return s
  } catch (e) {
    /* ignore */
  }
  return null
}

async function api(path, opts = {}) {
  if (!apiBase) throw new Error('API not configured')
  const headers = { 'Content-Type': 'application/json' }
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`
  const res = await fetch(`${apiBase}${path}`, {
    method: opts.method || 'GET',
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body)
  })
  let body = null
  const text = await res.text().catch(() => '')
  if (text) {
    try { body = JSON.parse(text) } catch { body = text }
  }
  if (!res.ok) {
    const msg = body && typeof body === 'object' && body.error ? body.error.message : (text || `Request failed (${res.status})`)
    throw new Error(msg)
  }
  return body
}

function renderPortal(cfg) {
  if (!cfg) return
  if (els.emailOut) els.emailOut.textContent = cfg.account?.email || ''
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
      li.innerHTML = `<div class="row"><span>${label(u.resource)}</span><span>${u.used}${u.limit ? ' / ' + u.limit : ''}</span></div>
        <div class="bar"><i style="width:${pct}%"></i></div>`
      els.usage.appendChild(li)
    }
  }

  if (els.models) {
    const available = (cfg.models || []).filter((m) => m.allowed)
    els.models.textContent = available.length
      ? `${available.length} cloud model${available.length === 1 ? '' : 's'} available on your plan.`
      : 'No cloud models are included in your current plan.'
  }

  if (els.announcements) {
    els.announcements.innerHTML = ''
    for (const a of cfg.announcements || []) {
      const div = document.createElement('div')
      div.className = `announce ${a.level || 'info'}`
      div.innerHTML = `<strong></strong><p></p>`
      div.querySelector('strong').textContent = a.title || ''
      div.querySelector('p').textContent = a.body || ''
      els.announcements.appendChild(div)
    }
    show(els.announcements, (cfg.announcements || []).length > 0)
  }
}

function label(resource) {
  return (
    { tokens: 'Tokens used', messages: 'Messages', requests: 'Requests', audio_minutes: 'Audio minutes', storage: 'Storage' }[
      resource
    ] || resource
  )
}

async function loadPortal() {
  try {
    if (!session) return
    const cfg = await api('/platform/config', { token: session.accessToken })
    renderPortal(cfg)
    show(els.signedOut, false)
    show(els.signedIn, true)
    setStatus('')
  } catch (e) {
    setStatus((e && e.message) || 'Failed to load account.', 'error')
  }
}

function wireSignOut() {
  els.signout?.addEventListener('click', async () => {
    try {
      if (session) await api('/auth/signout', { method: 'POST', token: session.accessToken })
    } catch (e) {
      /* best effort */
    }
    clearSession()
    show(els.signedIn, false)
    show(els.signedOut, true)
    setStatus('Signed out.', 'ok')
  })
  els.refresh?.addEventListener('click', () => void loadPortal())
}

function parseTokenFromUrl() {
  try {
    const url = new URL(location.href)
    const params = new URLSearchParams(url.search)
    const token = params.get('token')
    const email = params.get('email')
    if (!token) return null
    return { token, email }
  } catch (e) {
    return null
  }
}

async function handleMagicLink() {
  const t = parseTokenFromUrl()
  if (!t) return
  setStatus('Verifying your sign-in link…', '')
  try {
    const res = await api('/auth/verify', { method: 'POST', body: { token: t.token } })
    if (res && res.accessToken && res.refreshToken) {
      storeSession({ accessToken: res.accessToken, refreshToken: res.refreshToken, email: res.email || t.email })
      // Clean URL
      try { history.replaceState({}, '', location.pathname) } catch (e) {}
      await loadPortal()
      setStatus('Signed in successfully.', 'ok')
    } else {
      setStatus('Verification failed. Request a new link.', 'error')
    }
  } catch (e) {
    setStatus((e && e.message) || 'Verification failed.', 'error')
  }
}

async function init() {
  if (!configured) {
    if (els.notice) {
      els.notice.textContent =
        'Account portal is not configured for this deployment yet. Set API_BASE_URL on the host.'
      show(els.notice, true)
    }
    return
  }

  const stored = loadStoredSession()
  if (stored) {
    session = stored
  }

  els.form?.addEventListener('submit', async (e) => {
    e.preventDefault()
    const email = els.email?.value?.trim()
    if (!email) return
    setStatus('Sending a secure sign-in code/link…', '')
    try {
      await api('/auth/request', { method: 'POST', body: { email } })
      setStatus('Check your email for the sign-in link.', 'ok')
    } catch (e) {
      setStatus((e && e.message) || 'Could not send the sign-in link.', 'error')
    }
  })

  wireSignOut()

  await handleMagicLink()

  if (session) {
    await loadPortal()
  } else {
    show(els.signedOut, true)
    show(els.signedIn, false)
  }
}

void init()
