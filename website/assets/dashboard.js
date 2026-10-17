// Alpha AI Workspace — authenticated dashboard.
//
// A static page with one job: show the signed-in account's own data, read from
// the Alpha Cloud API with the session token. Nothing here is a placeholder
// metric: every figure comes from an endpoint, and anything the API could not
// answer is shown as unavailable rather than as a zero.
//
// The session lives in localStorage because the API is Bearer-only — it sets no
// cookies and narrows CORS to the site origin. This page renders no third-party
// or user-authored HTML (server strings go in through textContent), which is the
// property that makes storing the token that way defensible.

const SESSION_KEY = 'alpha-website-session'
/** Refresh this long before the access token actually lapses. */
const REFRESH_MARGIN_MS = 60_000
const REQUEST_TIMEOUT_MS = 15_000

const NAV = [
  {
    id: 'overview',
    label: 'Overview',
    icon: '<rect x="3.5" y="3.5" width="7" height="7" rx="1.4"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.4"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.4"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.4"/>'
  },
  {
    id: 'account',
    label: 'Profile',
    icon: '<circle cx="12" cy="8.2" r="3.6"/><path d="M4.8 20.2c.9-3.5 3.8-5.4 7.2-5.4s6.3 1.9 7.2 5.4"/>'
  },
  {
    id: 'security',
    label: 'Security',
    icon: '<path d="M12 3.4 5 6v5.4c0 4.1 2.8 7.4 7 9.2 4.2-1.8 7-5.1 7-9.2V6l-7-2.6Z"/><path d="m9.2 12 2 2 3.6-3.8"/>'
  },
  {
    id: 'usage',
    label: 'Usage',
    icon: '<path d="M4 20h16"/><rect x="5.5" y="11" width="3.4" height="6" rx="1"/><rect x="10.3" y="6.5" width="3.4" height="10.5" rx="1"/><rect x="15.1" y="9" width="3.4" height="8" rx="1"/>'
  },
  {
    id: 'models',
    label: 'Models',
    icon: '<path d="m12 3.6 8 4.2-8 4.2-8-4.2 8-4.2Z"/><path d="m4 12.4 8 4.2 8-4.2"/><path d="m4 16.6 8 4.2 8-4.2"/>'
  },
  {
    id: 'downloads',
    label: 'Downloads',
    icon: '<path d="M12 4v10"/><path d="m7.5 10.2 4.5 4.4 4.5-4.4"/><path d="M4.5 19.4h15"/>'
  },
  {
    id: 'help',
    label: 'Help',
    icon: '<circle cx="12" cy="12" r="8.6"/><path d="M9.7 9.4a2.4 2.4 0 1 1 3.5 2.2c-.8.4-1.2 1-1.2 1.9"/><path d="M12 17.2h.01"/>'
  }
]

const VIEW_META = {
  overview: ['Account', 'Overview'],
  account: ['Account', 'Profile'],
  security: ['Account', 'Security and sessions'],
  usage: ['Account', 'Usage and limits'],
  models: ['Account', 'Models and providers'],
  downloads: ['Account', 'Downloads'],
  help: ['Account', 'Help']
}

const VIEW_IDS = NAV.map((item) => item.id)

const state = {
  session: null,
  account: null,
  config: null,
  sessions: null,
  gateway: null,
  activity: null,
  release: null,
  releaseError: null,
  failures: {},
  ready: false
}

const els = {
  nav: document.getElementById('side-nav'),
  view: document.getElementById('view'),
  title: document.querySelector('[data-view-title]'),
  eyebrow: document.querySelector('[data-view-eyebrow]'),
  status: document.querySelector('[data-status]'),
  sidePlan: document.querySelector('[data-side-plan]'),
  whoName: document.querySelector('[data-who-name]'),
  whoEmail: document.querySelector('[data-who-email]'),
  avatar: document.querySelector('[data-avatar]'),
  signOut: document.querySelector('[data-signout]')
}

/* ------------------------------------------------------------------ helpers -- */

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

function readSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY)
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
    localStorage.setItem(SESSION_KEY, JSON.stringify(session))
  } catch {
    /* storage blocked: the session simply does not persist across reloads */
  }
}

function clearSession() {
  try {
    localStorage.removeItem(SESSION_KEY)
  } catch {
    /* nothing to do */
  }
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

/** Keep the access token fresh so a visit never bounces the user back to sign-in. */
async function ensureFresh(session) {
  const expiresAt = typeof session.expiresAt === 'number' ? session.expiresAt : 0
  if (expiresAt && expiresAt - Date.now() > REFRESH_MARGIN_MS) return session
  const res = await api('/auth/refresh', {
    method: 'POST',
    body: { refreshToken: session.refreshToken }
  })
  if (!res.ok || !res.json || !res.json.accessToken) {
    throw new Error('invalid_refresh')
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

/** Minimal element builder; every string becomes a text node, never markup. */
function h(tag, props = {}, ...children) {
  const node = document.createElement(tag)
  for (const [key, value] of Object.entries(props || {})) {
    if (value === null || value === undefined || value === false) continue
    if (key === 'class') node.className = value
    else if (key === 'dataset') Object.assign(node.dataset, value)
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value)
    } else if (value === true) node.setAttribute(key, '')
    else node.setAttribute(key, String(value))
  }
  append(node, children)
  return node
}

function append(node, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue
    node.append(child instanceof Node ? child : document.createTextNode(String(child)))
  }
  return node
}

const numberFmt = new Intl.NumberFormat()
const relativeFmt = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })

function num(value) {
  return typeof value === 'number' && Number.isFinite(value) ? numberFmt.format(value) : '—'
}

function bytes(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null
  const mb = value / (1024 * 1024)
  return `${mb.toFixed(mb >= 100 ? 0 : 1)} MB`
}

function date(value, withTime = false) {
  if (!value) return null
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return null
  return parsed.toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    ...(withTime ? { hour: '2-digit', minute: '2-digit' } : {})
  })
}

function relative(value) {
  if (!value) return null
  const parsed = new Date(value).getTime()
  if (!Number.isFinite(parsed)) return null
  const diff = Math.round((parsed - Date.now()) / 1000)
  const abs = Math.abs(diff)
  if (abs < 60) return relativeFmt.format(diff, 'second')
  if (abs < 3600) return relativeFmt.format(Math.round(diff / 60), 'minute')
  if (abs < 86400) return relativeFmt.format(Math.round(diff / 3600), 'hour')
  return relativeFmt.format(Math.round(diff / 86400), 'day')
}

function greeting() {
  const hour = new Date().getHours()
  if (hour < 12) return 'Good morning'
  if (hour < 18) return 'Good afternoon'
  return 'Good evening'
}

function firstName(account) {
  const name = account && typeof account.fullName === 'string' ? account.fullName.trim() : ''
  return name ? name.split(/\s+/)[0] : ''
}

function planName() {
  return (state.config && state.config.plan && state.config.plan.name) || 'Free'
}

function planLabel() {
  const plan = state.config && state.config.plan
  if (!plan) return '—'
  if (plan.isTrial) return `${plan.name} (trial)`
  return plan.name
}

/** Turn a user-agent string into something a person recognises. */
function deviceLabel(ua) {
  if (!ua || typeof ua !== 'string') return 'Unknown device'
  const browser = /Electron\//.test(ua)
    ? 'Alpha desktop'
    : /Edg\//.test(ua)
    ? 'Edge'
    : /OPR\//.test(ua)
      ? 'Opera'
      : /Firefox\//.test(ua)
        ? 'Firefox'
        : /Chrome\//.test(ua)
          ? 'Chrome'
          : /Safari\//.test(ua)
            ? 'Safari'
            : 'Browser'
  const system = /Windows/.test(ua)
    ? 'Windows'
    : /Android/.test(ua)
      ? 'Android'
      : /iPhone|iPad|iPod/.test(ua)
        ? 'iOS'
        : /Mac OS X|Macintosh/.test(ua)
          ? 'macOS'
          : /Linux/.test(ua)
            ? 'Linux'
            : ''
  return system ? `${browser} on ${system}` : browser
}

/* ------------------------------------------------------------------ chrome -- */

function renderNav() {
  if (!els.nav) return
  els.nav.innerHTML = ''
  for (const item of NAV) {
    els.nav.append(
      h(
        'a',
        { href: `#${item.id}`, dataset: { nav: item.id } },
        h('span', { class: 'nav-icon', 'aria-hidden': 'true' }),
        h('span', {}, item.label)
      )
    )
    const icon = els.nav.lastElementChild.querySelector('.nav-icon')
    if (icon) icon.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${item.icon}</svg>`
  }
  if (state.account && state.account.admin) {
    els.nav.append(
      h(
        'a',
        { href: '/admin', dataset: { nav: 'admin' } },
        h('span', { class: 'nav-icon', 'aria-hidden': 'true' }),
        h('span', {}, 'Administration')
      )
    )
    const icon = els.nav.lastElementChild.querySelector('.nav-icon')
    if (icon) {
      icon.innerHTML =
        '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14.7 6.3a3.6 3.6 0 0 0 4.9 4.9l-8.1 8.1a2.4 2.4 0 0 1-3.4-3.4l8.1-8.1Z"/><path d="M6.5 4.5 4.5 6.5"/></svg>'
    }
  }
}

let navAdminShown = false

function renderChrome() {
  const account = state.account || (state.config && state.config.account) || null
  const admin = Boolean(account && account.admin)
  // The administration link is the only nav item that depends on data, so the
  // nav is rebuilt once when that answer arrives — not on every re-render.
  if (admin !== navAdminShown) {
    navAdminShown = admin
    renderNav()
  }
  const name = firstName(account)
  const email = (account && account.email) || (state.session && state.session.email) || ''
  if (els.whoName) els.whoName.textContent = name || email.split('@')[0] || 'Account'
  if (els.whoEmail) els.whoEmail.textContent = email
  if (els.avatar) els.avatar.textContent = (name || email || 'A').trim().charAt(0).toUpperCase() || 'A'
  if (els.sidePlan) els.sidePlan.textContent = planLabel()
  document.title = `${(VIEW_META[currentView()] || VIEW_META.overview)[1]} · Alpha AI Workspace`
}

/* ----------------------------------------------------------------- panels -- */

function panel(title, lede, ...children) {
  const head = h(
    'div',
    { class: 'panel-head' },
    h('div', {}, h('h2', { class: 'panel-title' }, title), lede ? h('p', { class: 'panel-lede' }, lede) : null)
  )
  return h('section', { class: 'panel' }, head, ...children)
}

function tile(label, value, note) {
  return h(
    'div',
    { class: 'tile' },
    h('span', { class: 'tile-label' }, label),
    h('span', { class: 'tile-value' }, value),
    note ? h('span', { class: 'tile-note' }, note) : null
  )
}

function emptyState(title, body) {
  return h('div', { class: 'empty' }, h('strong', {}, title), body ? h('span', {}, body) : null)
}

function table(headers, rows) {
  return h(
    'div',
    { class: 'table-wrap' },
    h(
      'table',
      { class: 'app-table' },
      h('thead', {}, h('tr', {}, headers.map((head) => h('th', { class: head.align === 'right' ? 'num' : null }, head.label)))),
      h('tbody', {}, rows)
    )
  )
}

function statusLabel(status) {
  if (status === 'ok') return 'Succeeded'
  if (status === 'streaming') return 'Running'
  if (status === 'cancelled') return 'Cancelled'
  if (status === 'error') return 'Failed'
  return status || 'Unknown'
}

function resourceLabel(resource) {
  const name = String(resource || 'usage')
  if (name === 'requests_day') return 'Requests per day'
  if (name === 'requests_month') return 'Requests per month'
  const words = name.replace(/[._]/g, ' ')
  return words.charAt(0).toUpperCase() + words.slice(1)
}

function quotaRows(usage) {
  if (!Array.isArray(usage) || usage.length === 0) {
    return emptyState('No limits are set for this plan', 'Usage appears here once the API records it.')
  }
  return usage.map((item) => {
    const unlimited = item.unlimited === true || item.limit === null || item.limit === undefined
    const used = typeof item.used === 'number' ? item.used : Number(item.used) || 0
    const limit = unlimited ? null : Number(item.limit)
    const pct = limit && limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : null
    return h(
      'div',
      { class: 'quota' },
      h(
        'div',
        { class: 'quota-head' },
        h('span', { class: 'quota-name' }, resourceLabel(item.resource)),
        h(
          'span',
          { class: 'quota-figure' },
          unlimited ? `${num(used)} used · no limit` : `${num(used)} / ${num(limit)}`
        )
      ),
      h(
        'div',
        { class: 'progress', dataset: { unlimited: String(unlimited), over: String(pct !== null && pct >= 90) } },
        h('span', { style: `width:${unlimited ? 100 : pct ?? 0}%` })
      )
    )
  })
}

function announcementList(items) {
  return items.map((item) =>
    h(
      'div',
      { class: 'announcement' },
      h(
        'div',
        { class: 'announcement-title' },
        item.title || 'Announcement',
        item.level ? h('span', { class: `badge ${item.level === 'error' ? 'bad' : item.level === 'warning' ? 'warn' : ''}`, style: 'margin-left:8px' }, item.level) : null
      ),
      item.body ? h('p', { class: 'announcement-body' }, item.body) : null
    )
  )
}

function releaseBlock() {
  if (state.releaseError) {
    return emptyState('The installer is not available right now', state.releaseError)
  }
  const release = state.release
  if (!release) {
    return emptyState('No Windows release is published yet', 'The download link appears here once a release is published.')
  }
  const meta = ['Windows installer']
  const size = bytes(release.size)
  if (size) meta.push(size)
  const released = date(release.releasedAt)
  if (released) meta.push(`released ${released}`)

  return h(
    'div',
    {},
    h(
      'div',
      { class: 'dl-block' },
      h(
        'div',
        {},
        h('div', { class: 'plan-name' }, `Alpha AI Workspace ${release.version}`),
        h('div', { class: 'muted' }, meta.join(' · '))
      ),
      h('a', { class: 'btn primary', href: release.url, target: '_blank', rel: 'noopener' }, 'Download installer')
    ),
    release.notes ? h('p', { class: 'muted', style: 'margin-top:12px' }, release.notes) : null,
    release.sha512 ? h('p', { class: 'micro mono' }, `SHA-512 ${release.sha512}`) : null
  )
}

/* ------------------------------------------------------------------ views -- */

function viewOverview() {
  const frag = document.createDocumentFragment()
  const account = state.account
  const name = firstName(account)
  const email = (account && account.email) || (state.session && state.session.email) || ''
  const config = state.config
  const plan = config && config.plan
  const sub = config && config.subscription
  const models = (config && Array.isArray(config.models) && config.models) || null
  const allowed = models ? models.filter((model) => model.allowed).length : null
  const totals = state.activity && state.activity.totals

  const planNote = sub && sub.status ? `Subscription ${sub.status}` : plan && plan.isTrial ? 'Trial plan' : 'No subscription'

  frag.append(
    h(
      'div',
      { class: 'hero-panel' },
      h('h2', {}, name ? `${greeting()}, ${name}` : greeting()),
      h(
        'p',
        {},
        email
          ? `You are signed in as ${email}. This is your website account — the desktop workspace uses the same login.`
          : 'This is your website account. The desktop workspace uses the same login.'
      ),
      h(
        'div',
        { class: 'hero-actions' },
        h('a', { class: 'btn primary', href: '#downloads' }, 'Download the Windows app'),
        h('a', { class: 'btn ghost', href: '#security' }, 'Manage sessions')
      )
    )
  )

  const announcements = (config && config.announcements) || []
  if (announcements.length) {
    frag.append(panel('Announcements', null, ...announcementList(announcements)))
  }

  frag.append(
    h(
      'div',
      { class: 'tiles' },
      tile('Plan', plan ? planLabel() : '—', !config ? 'Could not load your plan' : planNote),
      tile(
        'Cloud models',
        models ? `${allowed} / ${models.length}` : '—',
        models ? 'available on your plan' : 'Could not load the catalog'
      ),
      tile(
        'AI requests',
        totals ? num(totals.requests) : '—',
        totals ? `last ${state.activity.days} days` : 'Could not load usage'
      ),
      tile(
        'Tokens',
        totals ? num(totals.tokens) : '—',
        totals ? `last ${state.activity.days} days` : 'Could not load usage'
      )
    )
  )

  const quotaPanel = panel(
    'Usage this month',
    'Counters the API records for your account.',
    h('div', {}, ...(config ? quotaRows(config.usage) : [emptyState('Usage is unavailable', 'The account API did not answer.')]))
  )

  const recent = (state.activity && state.activity.recent) || []
  const recentPanel = panel(
    'Recent activity',
    'AI requests from this account.',
    recent.length
      ? table(
          [{ label: 'Model' }, { label: 'Result' }, { label: 'Tokens', align: 'right' }],
          recent.slice(0, 6).map((row) =>
            h(
              'tr',
              {},
              h(
                'td',
                {},
                h('span', { class: 'cell-title' }, row.modelId || 'Unknown model'),
                h('span', { class: 'cell-sub' }, row.providerId || '')
              ),
              h(
                'td',
                {},
                h(
                  'span',
                  { class: `badge ${row.status === 'ok' ? 'ok' : row.status === 'streaming' ? 'brand' : 'warn'}` },
                  statusLabel(row.status)
                ),
                h('span', { class: 'cell-sub' }, relative(row.createdAt) || date(row.createdAt) || '—')
              ),
              h('td', { class: 'num' }, row.tokens === null || row.tokens === undefined ? '—' : num(row.tokens))
            )
          )
        )
      : emptyState(
          'No AI requests yet',
          "Open the desktop app, pick a model and start a conversation — usage will appear here."
        )
  )

  frag.append(
    h('div', { class: 'grid-2 wide-left' }, quotaPanel, recentPanel),
    panel(
      'Desktop app',
      'The installer for your account. Downloads are only served to signed-in accounts.',
      releaseBlock(),
      h('div', { class: 'panel-foot' }, h('a', { class: 'btn ghost', href: '#downloads' }, 'Install and requirements'))
    )
  )

  return frag
}

function viewAccount() {
  const account = state.account
  const config = state.config
  if (!account) {
    return panel('Profile', null, emptyState('Your profile is unavailable', 'The account API did not answer. Reload the page.'))
  }

  const nameField = h('input', {
    id: 'profile-name',
    type: 'text',
    name: 'fullName',
    maxlength: '80',
    autocomplete: 'name',
    placeholder: 'Add your name',
    value: account.fullName || ''
  })
  const formStatus = h('p', { class: 'status-line', role: 'status', 'aria-live': 'polite' })
  const saveButton = h('button', { class: 'btn primary', type: 'submit' }, 'Save name')

  const form = h(
    'form',
    {
      class: 'panel',
      onsubmit: async (event) => {
        event.preventDefault()
        saveButton.disabled = true
        formStatus.textContent = 'Saving…'
        formStatus.dataset.kind = ''
        try {
          const res = await api('/auth/me', {
            method: 'PATCH',
            token: state.session.accessToken,
            body: { fullName: nameField.value }
          })
          if (res.status === 401) {
            sessionEnded()
            return
          }
          if (!res.ok) {
            formStatus.textContent =
              (res.json && res.json.error && res.json.error.message) || 'That name could not be saved.'
            formStatus.dataset.kind = 'error'
            return
          }
          state.account = res.json.account
          renderChrome()
          formStatus.textContent = 'Saved.'
          formStatus.dataset.kind = 'ok'
        } catch {
          formStatus.textContent = 'Could not reach the account service. Try again.'
          formStatus.dataset.kind = 'error'
        } finally {
          saveButton.disabled = false
        }
      }
    },
    h('div', { class: 'panel-head' }, h('div', {}, h('h2', { class: 'panel-title' }, 'Your name'))),
    h(
      'p',
      { class: 'panel-lede', style: 'margin:-8px 0 16px' },
      'Used to greet you here. It is not a sign-in method.'
    ),
    h(
      'div',
      { class: 'form-row' },
      h('div', { class: 'field' }, h('label', { for: 'profile-name' }, 'Full name'), nameField),
      saveButton
    ),
    formStatus
  )

  const providers = Array.isArray(account.providers) ? account.providers : []
  const methodRows = [
    ['Email code', 'Enabled', 'A one-time code sent to your address.'],
    ...['google', 'github'].map((provider) => [
      provider === 'google' ? 'Google' : 'GitHub',
      providers.includes(provider) ? 'Linked' : 'Not linked',
      providers.includes(provider)
        ? 'Signing in with this provider uses this account.'
        : 'Sign in with this provider using the same email address to link it.'
    ])
  ]

  const plan = config && config.plan
  const sub = config && config.subscription

  return h(
    'div',
    { class: 'view' },
    form,
    panel(
      'Account',
      'Details the API holds for this account.',
      h(
        'dl',
        { class: 'kv' },
        h('dt', {}, 'Email'),
        h('dd', {}, account.email || '—'),
        h('dt', {}, 'Status'),
        h('dd', {}, h('span', { class: `badge ${account.status === 'active' ? 'ok' : 'warn'}` }, account.status || 'unknown')),
        h('dt', {}, 'Member since'),
        h('dd', {}, date(account.createdAt) || '—'),
        h('dt', {}, 'Last sign-in'),
        h('dd', {}, account.lastSignInAt ? `${date(account.lastSignInAt, true)} (${relative(account.lastSignInAt)})` : '—'),
        h('dt', {}, 'Account ID'),
        h('dd', { class: 'mono' }, account.id || '—')
      )
    ),
    panel(
      'Sign-in methods',
      'Ways this account can be signed in to.',
      table(
        [{ label: 'Method' }, { label: 'State' }, { label: 'Notes' }],
        methodRows.map(([method, methodState, note]) =>
          h(
            'tr',
            {},
            h('td', { class: 'cell-title' }, method),
            h('td', {}, h('span', { class: `badge ${methodState === 'Linked' || methodState === 'Enabled' ? 'ok' : ''}` }, methodState)),
            h('td', { class: 'muted' }, note)
          )
        )
      ),
      h(
        'p',
        { class: 'micro' },
        'This website and the desktop app share one account. Sign in with your email and password, a one-time code, or GitHub/Google when linked — it is the same account everywhere.'
      )
    ),
    panel(
      'Plan',
      'What your account is entitled to.',
      h(
        'dl',
        { class: 'kv' },
        h('dt', {}, 'Plan'),
        h('dd', {}, plan ? plan.name : '—'),
        h('dt', {}, 'Billing interval'),
        h('dd', {}, plan && plan.interval ? plan.interval : '—'),
        h('dt', {}, 'Subscription'),
        h('dd', {}, sub && sub.status ? h('span', { class: 'badge ok' }, sub.status) : 'No subscription record'),
        h('dt', {}, 'Renews'),
        h('dd', {}, sub && sub.endsAt ? date(sub.endsAt) : '—')
      ),
      h(
        'p',
        { class: 'micro' },
        'Plan changes and billing are not available in the browser yet. Nothing on this page can change what you are charged.'
      )
    )
  )
}

function viewSecurity() {
  const sessions = state.sessions
  const frag = document.createDocumentFragment()

  const revokeOthers = h(
    'button',
    { class: 'btn ghost', type: 'button', disabled: true },
    'Sign out other sessions'
  )
  revokeOthers.addEventListener('click', async () => {
    if (!window.confirm('Sign out every other device? They will need to sign in again.')) return
    revokeOthers.disabled = true
    setStatus('Signing out other sessions…', '')
    try {
      const res = await api('/auth/sessions/revoke-others', {
        method: 'POST',
        token: state.session.accessToken
      })
      if (res.status === 401) {
        sessionEnded()
        return
      }
      if (!res.ok) {
        setStatus((res.json && res.json.error && res.json.error.message) || 'That did not work. Try again.', 'error')
        return
      }
      const count = res.json && typeof res.json.revoked === 'number' ? res.json.revoked : 0
      setStatus(count === 1 ? 'Signed out 1 other session.' : `Signed out ${count} other sessions.`, 'ok')
      await loadSessions()
      renderRoute()
    } catch (error) {
      if (error && error.code === 'session_ended') {
        sessionEnded()
        return
      }
      setStatus('Could not reach the account service. Try again.', 'error')
    } finally {
      revokeOthers.disabled = false
    }
  })

  if (!sessions) {
    frag.append(
      panel('Security and sessions', null, emptyState('Sessions are unavailable', 'The account API did not answer. Reload the page.'))
    )
  } else {
    const rows = sessions.sessions
    // There is something to sign out only when another live session exists.
    if (rows.length > 1) revokeOthers.disabled = false
    frag.append(
      panel(
        'Security and sessions',
        'Every signed-in browser and the installed app. Revoking a session takes effect immediately.',
        rows.length
          ? table(
              [{ label: 'Device' }, { label: 'Signed in' }, { label: 'Last used' }, { label: 'Expires' }, { label: '' }],
              rows.map((session) =>
                h(
                  'tr',
                  {},
                  h(
                    'td',
                    {},
                    h('span', { class: 'cell-title' }, deviceLabel(session.userAgent)),
                    h('span', { class: 'cell-sub' }, session.ip ? session.ip : 'No address recorded'),
                    session.current ? h('span', { class: 'badge brand', style: 'margin-top:5px' }, 'This device') : null
                  ),
                  h('td', { class: 'nowrap' }, date(session.createdAt) || '—'),
                  h('td', { class: 'nowrap' }, relative(session.lastUsedAt) || '—'),
                  h('td', { class: 'nowrap' }, date(session.expiresAt) || '—'),
                  h(
                    'td',
                    {},
                    session.current
                      ? h('span', { class: 'muted' }, 'Sign out below')
                      : revokeButton(session)
                  )
                )
              )
            )
          : emptyState('No other sessions', 'This device is the only one signed in.'),
        rows.length > 1 ? h('div', { class: 'panel-foot' }, revokeOthers) : null
      )
    )
  }

  frag.append(
    panel(
      'Signing out',
      null,
      h(
        'p',
        { class: 'muted', style: 'margin-top:0' },
        'Signing out revokes this session on the server. The token stops working immediately rather than at its next expiry.'
      ),
      h('div', { class: 'actions' }, h('button', { class: 'btn danger', type: 'button', onclick: signOut }, 'Sign out of this device'))
    ),
    panel(
      'Password',
      null,
      h(
        'p',
        { class: 'muted', style: 'margin-top:0' },
        state.account && state.account.hasPassword
          ? 'Change the password you use here and in the desktop app. Changing it signs your other devices out.'
          : 'Set a password to sign in without waiting for an email. The emailed code keeps working either way.'
      ),
      passwordForm(Boolean(state.account && state.account.hasPassword))
    )
  )
  return frag
}

/**
 * Set or change the account password.
 *
 * The current-password field is only required by the API when a credential
 * already exists, so it is always shown — labelled with what it is for — rather
 * than hidden behind a state we would have to guess. A change revokes every other
 * session server-side, which is why the confirmation says so.
 */
function passwordForm(hasPassword) {
  const current = h('input', {
    type: 'password',
    autocomplete: 'current-password',
    placeholder: hasPassword ? 'Current password' : 'Current password (if you have one)',
    'aria-label': hasPassword ? 'Current password' : 'Current password, if you have one'
  })
  const next = h('input', {
    type: 'password',
    autocomplete: 'new-password',
    placeholder: 'New password (12+ characters)',
    'aria-label': 'New password'
  })
  const submit = h('button', { class: 'btn primary', type: 'button' }, hasPassword ? 'Change password' : 'Set password')

  submit.addEventListener('click', async () => {
    if (!next.value) {
      setStatus('Enter the new password first.', 'error')
      next.focus()
      return
    }
    submit.disabled = true
    setStatus('Saving your password…', '')
    try {
      const res = await api('/auth/password/change', {
        method: 'POST',
        token: state.session.accessToken,
        body: { currentPassword: current.value, newPassword: next.value }
      })
      if (res.status === 401) {
        sessionEnded()
        return
      }
      if (!res.ok) {
        setStatus((res.json && res.json.error && res.json.error.message) || 'That password could not be saved.', 'error')
        return
      }
      current.value = ''
      next.value = ''
      if (state.account) state.account.hasPassword = true
      const revoked = res.json && typeof res.json.revokedOthers === 'number' ? res.json.revokedOthers : 0
      setStatus(
        res.json && res.json.replaced
          ? `Password changed.${revoked ? ` ${revoked} other session${revoked === 1 ? '' : 's'} signed out.` : ''}`
          : 'Password set. You can sign in with it from now on.',
        'ok'
      )
      renderRoute()
    } catch {
      setStatus('Could not reach the account service. Check your connection and try again.', 'error')
    } finally {
      submit.disabled = false
    }
  })

  return h('div', { class: 'field-row' }, current, next, submit)
}

function revokeButton(session) {
  const button = h('button', { class: 'btn small danger', type: 'button' }, 'Revoke')
  button.addEventListener('click', async () => {
    button.disabled = true
    try {
      const res = await api(`/auth/sessions/${encodeURIComponent(session.id)}`, {
        method: 'DELETE',
        token: state.session.accessToken
      })
      if (res.status === 401) {
        sessionEnded()
        return
      }
      if (!res.ok) {
        setStatus((res.json && res.json.error && res.json.error.message) || 'That session could not be revoked.', 'error')
        button.disabled = false
        return
      }
      setStatus('Session revoked.', 'ok')
      await loadSessions()
      renderRoute()
    } catch (error) {
      if (error && error.code === 'session_ended') {
        sessionEnded()
        return
      }
      setStatus('Could not reach the account service. Try again.', 'error')
      button.disabled = false
    }
  })
  return button
}

function viewUsage() {
  const config = state.config
  const activity = state.activity
  const frag = document.createDocumentFragment()

  const daily = (activity && activity.daily) || []
  const days = (activity && activity.days) || 30
  const byDay = new Map(daily.map((row) => [row.day, row]))
  const slots = []
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const day = new Date(today)
    day.setDate(day.getDate() - offset)
    const key = day.toISOString().slice(0, 10)
    slots.push({ key, label: day, row: byDay.get(key) || null })
  }
  const peak = slots.reduce((max, slot) => Math.max(max, slot.row ? slot.row.requests : 0), 0)

  const chart = activity
    ? peak === 0
      ? emptyState('No AI requests in this period', 'Requests made from the desktop app appear here.')
      : h(
          'div',
          { role: 'img', 'aria-label': `AI requests per day over the last ${days} days` },
          h(
            'div',
            { class: 'chart' },
            slots.map((slot) =>
              h('div', {
                class: 'chart-bar',
                dataset: { zero: String(!slot.row) },
                style: `height:${slot.row ? Math.max(3, Math.round((slot.row.requests / peak) * 100)) : 2}%`,
                title: `${slot.label.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} · ${
                  slot.row ? `${slot.row.requests} request${slot.row.requests === 1 ? '' : 's'}` : 'no requests'
                }`
              })
            )
          ),
          h(
            'div',
            { class: 'chart-axis' },
            h('span', {}, slots[0] ? slots[0].label.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : ''),
            h('span', {}, 'Today')
          )
        )
    : emptyState('Usage history is unavailable', 'The API did not answer.')

  frag.append(
    panel(
      `Requests, last ${days} days`,
      activity ? `${num(activity.totals.requests)} requests · ${num(activity.totals.tokens)} tokens` : null,
      chart
    )
  )

  frag.append(
    h(
      'div',
      { class: 'grid-2' },
      panel(
        'Monthly allowances',
        'Server-enforced counters for the current period.',
        h('div', {}, ...(config ? quotaRows(config.usage) : [emptyState('Allowances are unavailable', 'The account API did not answer.')]))
      ),
      panel(
        `By model, last ${days} days`,
        activity && activity.models.length ? null : 'Nothing has been run yet.',
        activity && activity.models.length
          ? table(
              [{ label: 'Model' }, { label: 'Requests', align: 'right' }, { label: 'Tokens', align: 'right' }],
              activity.models.map((row) =>
                h(
                  'tr',
                  {},
                  h('td', {}, h('span', { class: 'cell-title' }, row.modelId), h('span', { class: 'cell-sub' }, row.providerId)),
                  h('td', { class: 'num' }, num(row.requests)),
                  h('td', { class: 'num' }, num(row.tokens))
                )
              )
            )
          : emptyState('No model usage', 'The desktop app records usage per model as you chat.')
      )
    )
  )

  if (activity && activity.totals.estimatedCostUsd !== null) {
    frag.append(
      panel(
        'Estimated cost',
        null,
        h('div', { class: 'tiles' }, tile('Estimated spend', `$${activity.totals.estimatedCostUsd.toFixed(2)}`, 'last 30 days')),
        h(
          'p',
          { class: 'micro' },
          'This is an estimate computed from catalog pricing when each request finished. It is not a provider invoice and not a charge.'
        )
      )
    )
  }

  return frag
}

function viewModels() {
  const config = state.config
  const gateway = state.gateway
  const frag = document.createDocumentFragment()

  if (gateway && gateway.sharedEnabled && gateway.sharedEnabled.enabled === false) {
    frag.append(
      h(
        'div',
        { class: 'callout warn' },
        h('p', {}, 'Shared cloud access is switched off on this deployment.'),
        gateway.sharedEnabled.message ? h('p', {}, gateway.sharedEnabled.message) : null
      )
    )
  }

  const providers = (gateway && gateway.providers) || []
  if (providers.length) {
    frag.append(
      panel(
        'Providers',
        'The gateway’s own view of each provider. “Configured” means the server holds credentials — never that a request has succeeded.',
        table(
          [{ label: 'Provider' }, { label: 'State' }, { label: 'Requests (7d)', align: 'right' }, { label: 'Last request' }],
          providers.map((provider) =>
            h(
              'tr',
              {},
              h('td', { class: 'cell-title' }, provider.label || provider.code),
              h(
                'td',
                {},
                h(
                  'span',
                  { class: `badge ${provider.configured && provider.active ? 'ok' : 'warn'}` },
                  provider.configured ? (provider.active ? 'Configured' : 'Disabled') : 'No credentials'
                )
              ),
              h('td', { class: 'num' }, num(provider.requests7d)),
              h('td', { class: 'nowrap' }, provider.lastRequestAt ? relative(provider.lastRequestAt) : '—')
            )
          )
        )
      )
    )
  }

  const models = (config && Array.isArray(config.models) && config.models) || null
  if (!models) {
    frag.append(panel('Models', null, emptyState('The model catalog is unavailable', 'The account API did not answer.')))
    return frag
  }

  const groups = new Map()
  for (const model of models) {
    const key = model.providerLabel || model.providerId || 'Other'
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(model)
  }

  frag.append(
    panel(
      'Cloud models',
      'Everything this deployment publishes, and whether your plan includes it.',
      models.length
        ? [...groups.entries()].map(([provider, list]) =>
            h(
              'div',
              { style: 'margin-bottom:18px' },
              h('p', { class: 'eyebrow' }, provider),
              h(
                'div',
                { class: 'model-list' },
                list.map((model) =>
                  h(
                    'div',
                    { class: 'model-row' },
                    h(
                      'div',
                      {},
                      h('div', { class: 'model-name' }, model.label || model.modelId),
                      h(
                        'div',
                        { class: 'model-meta' },
                        [model.modelId, model.contextLength ? `${num(model.contextLength)} token context` : null]
                          .filter(Boolean)
                          .join(' · ')
                      ),
                      model.capabilities
                        ? h(
                            'div',
                            { class: 'chips' },
                            Object.entries(model.capabilities)
                              .filter(([, enabled]) => enabled)
                              .map(([capability]) => h('span', { class: 'chip' }, capability))
                          )
                        : null
                    ),
                    model.allowed
                      ? h('span', { class: 'badge ok' }, 'In your plan')
                      : h('span', { class: 'badge' }, 'Not in your plan')
                  )
                )
              )
            )
          )
        : emptyState('No cloud models are published', 'An administrator has not enabled any models yet.'),
      h(
        'p',
        { class: 'micro' },
        'These are hosted cloud models, reached through the Alpha API from the desktop app. Local Ollama models stay on your machine and are not listed here.'
      )
    )
  )
  return frag
}

function viewDownloads() {
  return h(
    'div',
    { class: 'view' },
    panel('Windows installer', 'Downloads are served to active, signed-in accounts.', releaseBlock()),
    panel(
      'Install it',
      null,
      h(
        'ol',
        { class: 'install-steps' },
        h('li', {}, 'Run the installer above. It is unsigned — if SmartScreen warns, choose More info → Run anyway.'),
        h('li', {}, 'Install Ollama if you want to run models locally.'),
        h('li', {}, 'Open Alpha, sign in with this same account, and choose a model in the app.')
      )
    ),
    panel(
      'System requirements',
      null,
      h(
        'ul',
        { class: 'req-list' },
        h('li', {}, 'Windows 10 or 11 (x64)'),
        h('li', {}, 'Per-user install — no administrator rights required'),
        h('li', {}, 'Roughly 400 MB of disk after install'),
        h('li', {}, 'Ollama for local models, or a cloud model on your plan')
      )
    )
  )
}

function viewHelp() {
  return h(
    'div',
    { class: 'view' },
    panel(
      'Common questions',
      'What this page is, and what it is not.',
      h(
        'dl',
        { class: 'kv' },
        h('dt', {}, 'Website vs desktop'),
        h(
          'dd',
          {},
          'This dashboard manages your Alpha account. Conversations, projects and local models live in the installed Windows app.'
        ),
        h('dt', {}, 'Signing in'),
        h('dd', {}, 'Use a one-time email code, Google, or GitHub. Any of them reach the same account for the same email address.'),
        h('dt', {}, 'Downloads'),
        h('dd', {}, 'Installers are only handed out here, to a signed-in account. There is no public download link.'),
        h('dt', {}, 'Billing'),
        h('dd', {}, 'Plans are visible but cannot be purchased or changed on the website yet.')
      )
    ),
    panel(
      'Get help',
      null,
      h(
        'div',
        { class: 'actions' },
        h('a', { class: 'btn', href: '/#faq' }, 'Read the FAQ'),
        h(
          'a',
          { class: 'btn', href: 'https://github.com/martinssqeel-maker/Alpha-/issues', target: '_blank', rel: 'noopener' },
          'Report a problem'
        )
      )
    ),
    panel(
      'Account links',
      null,
      h(
        'div',
        { class: 'actions' },
        h('a', { class: 'btn ghost', href: '/privacy' }, 'Privacy policy'),
        h('a', { class: 'btn ghost', href: '/terms' }, 'Terms of service'),
        h('a', { class: 'btn ghost', href: '/account' }, 'Sign-in page')
      )
    )
  )
}

const RENDERERS = {
  overview: viewOverview,
  account: viewAccount,
  security: viewSecurity,
  usage: viewUsage,
  models: viewModels,
  downloads: viewDownloads,
  help: viewHelp
}

/* ------------------------------------------------------------------ router -- */

function currentView() {
  const id = window.location.hash.replace(/^#/, '')
  return VIEW_IDS.includes(id) ? id : 'overview'
}

function renderRoute() {
  if (!state.ready) return
  const id = currentView()
  const meta = VIEW_META[id] || VIEW_META.overview
  if (els.title) els.title.textContent = meta[1]
  if (els.eyebrow) els.eyebrow.textContent = meta[0]
  document.title = `${meta[1]} · Alpha AI Workspace`

  for (const [navId, link] of navLinks()) {
    if (navId === id) link.setAttribute('aria-current', 'page')
    else link.removeAttribute('aria-current')
  }

  for (const section of document.querySelectorAll('[data-view]')) {
    section.hidden = section.dataset.view !== id
  }
  const section = document.querySelector(`[data-view="${id}"]`)
  if (!section) return
  section.innerHTML = ''
  const rendered = RENDERERS[id]()
  if (rendered instanceof Node) section.append(rendered)
  else append(section, [rendered])
}

function navLinks() {
  if (!els.nav) return []
  return [...els.nav.querySelectorAll('a[data-nav]')].map((link) => [link.dataset.nav, link])
}

window.addEventListener('hashchange', () => {
  renderRoute()
  if (els.view) els.view.focus({ preventScroll: true })
})

/* -------------------------------------------------------------------- data -- */

async function loadSessions() {
  const res = await api('/auth/sessions', { token: state.session.accessToken })
  if (res.status === 401) throw Object.assign(new Error('session_ended'), { code: 'session_ended' })
  state.sessions = res.ok ? res.json : null
}

async function loadAll() {
  const token = state.session.accessToken
  const results = await Promise.allSettled([
    api('/platform/config', { token }).then((res) => {
      if (res.status === 401) throw Object.assign(new Error('session_ended'), { code: 'session_ended' })
      state.config = res.ok ? res.json : null
      state.failures.config = res.ok ? null : (res.json && res.json.error && res.json.error.message) || 'The account API did not answer.'
    }),
    api('/auth/me', { token }).then((res) => {
      if (res.status === 401) throw Object.assign(new Error('session_ended'), { code: 'session_ended' })
      state.account = res.ok && res.json ? res.json.account : null
    }),
    loadSessions(),
    api('/gateway/status', { token }).then((res) => {
      if (res.status === 401) throw Object.assign(new Error('session_ended'), { code: 'session_ended' })
      state.gateway = res.ok ? res.json : null
    }),
    api('/gateway/activity?days=30', { token }).then((res) => {
      if (res.status === 401) throw Object.assign(new Error('session_ended'), { code: 'session_ended' })
      state.activity = res.ok ? res.json : null
    }),
    api('/downloads/latest', { token }).then((res) => {
      if (res.status === 401) throw Object.assign(new Error('session_ended'), { code: 'session_ended' })
      if (res.ok && res.json && res.json.release) {
        state.release = res.json.release
        state.releaseError = null
      } else {
        state.release = null
        state.releaseError =
          (res.json && res.json.error && res.json.error.message) || 'The download service did not answer.'
      }
    })
  ])

  for (const result of results) {
    if (result.status === 'rejected' && result.reason && result.reason.code === 'session_ended') {
      throw result.reason
    }
  }
}

/* ------------------------------------------------------------------ states -- */

function setState(name) {
  for (const node of document.querySelectorAll('[data-state]')) {
    node.hidden = node.dataset.state !== name
  }
  for (const section of document.querySelectorAll('[data-view]')) {
    if (name !== 'ready') section.hidden = true
  }
}

function sessionEnded() {
  clearSession()
  setState('signed-out')
  setStatus('Your session has ended. Sign in again.', 'error')
  if (els.whoName) els.whoName.textContent = 'Signed out'
  if (els.whoEmail) els.whoEmail.textContent = ''
  if (els.avatar) els.avatar.textContent = 'A'
  if (els.sidePlan) els.sidePlan.textContent = '—'
}

async function signOut() {
  const session = state.session
  if (els.signOut) els.signOut.disabled = true
  try {
    if (session) await api('/auth/signout', { method: 'POST', token: session.accessToken })
  } catch {
    /* local sign-out below is what the visitor asked for */
  } finally {
    clearSession()
    state.session = null
    window.location.assign('/')
  }
}

/* -------------------------------------------------------------------- boot -- */

async function boot() {
  if (els.signOut) els.signOut.addEventListener('click', signOut)
  renderNav()

  if (!apiBase()) {
    setState('unconfigured')
    setStatus('No Alpha Cloud API address is configured for this site.', 'error')
    return
  }

  const stored = readSession()
  if (!stored) {
    window.location.replace('/account?next=app')
    return
  }

  try {
    state.session = await ensureFresh(stored)
  } catch {
    sessionEnded()
    return
  }

  try {
    await loadAll()
  } catch (error) {
    if (error && error.code === 'session_ended') {
      sessionEnded()
      return
    }
    setStatus('Some account data could not be loaded. Reload to try again.', 'error')
  }

  if (!state.account && !state.config) {
    sessionEnded()
    return
  }

  state.ready = true
  renderChrome()
  setState('ready')
  renderRoute()
  if (state.failures.config) setStatus(state.failures.config, 'error')
}

void boot()
