// Alpha AI Workspace — administration dashboard.
//
// This page is a *view* over an API that authorizes every call itself. It holds
// no privileged knowledge: it cannot grant access, and nothing here decides what
// is permitted. If it were deleted, every rule it appears to enforce would still
// be enforced on the server, because the enforcement lives in the database
// functions the API calls (public.require_admin).
//
// Nothing is rendered until the API answers. A metric that cannot be read shows
// as unavailable rather than as zero, and no figure on this page is invented.

const STORAGE_KEY = 'alpha-website-session'
const REFRESH_MARGIN_MS = 60_000
const REQUEST_TIMEOUT_MS = 20_000

const views = {
  loading: document.querySelector('[data-view="loading"]'),
  signedOut: document.querySelector('[data-view="signed-out"]'),
  unconfigured: document.querySelector('[data-view="unconfigured"]'),
  forbidden: document.querySelector('[data-view="forbidden"]'),
  ready: document.querySelector('[data-view="ready"]')
}
const who = document.querySelector('[data-admin-who]')
const forbiddenDetail = document.querySelector('[data-forbidden-detail]')
const confirmEl = document.querySelector('[data-confirm]')

function apiBase() {
  const value = window.ALPHA_PLATFORM && window.ALPHA_PLATFORM.apiBaseUrl
  return typeof value === 'string' && value.trim() ? value.replace(/\/+$/, '') : null
}

function readSession() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed.accessToken !== 'string' || typeof parsed.refreshToken !== 'string') return null
    return parsed
  } catch {
    return null
  }
}

function writeSession(session) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(session))
  } catch {
    /* storage blocked — the session simply does not persist */
  }
}

function clearSession() {
  try {
    localStorage.removeItem(STORAGE_KEY)
  } catch {
    /* nothing to do */
  }
}

async function raw(path, { method = 'GET', body, token } = {}) {
  const base = apiBase()
  if (!base) throw new Error('not_configured')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const headers = { Accept: 'application/json' }
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    if (token) headers.Authorization = `Bearer ${token}`
    const res = await fetch(`${base}${path}`, {
      method,
      headers,
      credentials: 'omit',
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal
    })
    let json = null
    try {
      json = await res.json()
    } catch {
      /* some failures answer with no body */
    }
    return { status: res.status, ok: res.ok, json }
  } finally {
    clearTimeout(timer)
  }
}

let session = readSession()

/** Refresh the access token when it is close to lapsing, or when told to. */
async function refreshToken(force = false) {
  if (!session) return null
  const expiresAt = typeof session.expiresAt === 'number' ? session.expiresAt : 0
  if (!force && expiresAt && expiresAt - Date.now() > REFRESH_MARGIN_MS) return session
  const res = await raw('/auth/refresh', { method: 'POST', body: { refreshToken: session.refreshToken } })
  if (!res.ok || !res.json || !res.json.accessToken) {
    clearSession()
    session = null
    return null
  }
  session = {
    accessToken: res.json.accessToken,
    refreshToken: res.json.refreshToken,
    expiresAt: res.json.expiresAt,
    email: res.json.email || session.email
  }
  writeSession(session)
  return session
}

/**
 * Call an administrative endpoint. A 401 is retried exactly once, after a
 * forced token refresh, so a merely stale token does not look like a refusal.
 */
async function call(path, { method = 'GET', body } = {}) {
  const current = await refreshToken()
  if (!current) return { status: 401, ok: false, json: null, reason: 'signed_out' }
  let res = await raw(path, { method, body, token: current.accessToken })
  if (res.status === 401) {
    const again = await refreshToken(true)
    if (!again) return { status: 401, ok: false, json: null, reason: 'signed_out' }
    res = await raw(path, { method, body, token: again.accessToken })
  }
  return res
}

// ── tiny DOM helpers (textContent only: server data is never injected as HTML) ──

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag)
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined) continue
    if (key === 'class') el.className = value
    else if (key === 'text') el.textContent = value
    else if (key === 'html') el.innerHTML = value
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value)
    else el.setAttribute(key, value)
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue
    el.append(child instanceof Node ? child : document.createTextNode(String(child)))
  }
  return el
}

function table(headers, rows, emptyText) {
  if (!rows || rows.length === 0) {
    return h('p', { class: 'note', text: emptyText || 'Nothing recorded yet.' })
  }
  const thead = h('thead', {}, h('tr', {}, headers.map((label) => h('th', { text: label }))))
  const tbody = h(
    'tbody',
    {},
    rows.map((cells) => h('tr', {}, cells.map((cell) => {
      if (cell instanceof Node) return h('td', {}, cell)
      return h('td', { text: String(cell ?? '—') })
    })))
  )
  return h('div', { class: 'scroll' }, h('table', { class: 'admin' }, thead, tbody))
}

function metric(label, value, window) {
  const readable = value === null || value === undefined || value === ''
  return h(
    'div',
    { class: `card metric${readable ? ' unavailable' : ''}` },
    h('div', { class: 'v', text: readable ? 'Unavailable' : String(value) }),
    h('div', { class: 'k', text: label }),
    window ? h('div', { class: 'w', text: window }) : null
  )
}

function num(value) {
  if (value === null || value === undefined) return '—'
  const n = Number(value)
  return Number.isFinite(n) ? n.toLocaleString() : '—'
}

function money(value) {
  if (value === null || value === undefined) return '—'
  const n = Number(value)
  if (!Number.isFinite(n)) return '—'
  return n === 0 ? '$0.00' : `$${n.toFixed(n < 0.01 ? 4 : 2)}`
}

function when(value) {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return String(value)
  return date.toLocaleString()
}

let toastTimer = null
function toast(message, bad = false) {
  document.querySelectorAll('.toast').forEach((el) => el.remove())
  const el = h('div', { class: `toast${bad ? ' bad' : ''}`, role: 'status', text: message })
  document.body.append(el)
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => el.remove(), bad ? 8000 : 4000)
}

/** Confirmation for anything that changes another account or spends money. */
function confirmAction(title, body, okLabel = 'Confirm') {
  return new Promise((resolve) => {
    const titleEl = confirmEl.querySelector('[data-confirm-title]')
    const bodyEl = confirmEl.querySelector('[data-confirm-body]')
    const okEl = confirmEl.querySelector('[data-confirm-ok]')
    const cancelEl = confirmEl.querySelector('[data-confirm-cancel]')
    titleEl.textContent = title
    bodyEl.textContent = body
    okEl.textContent = okLabel
    const done = (result) => {
      confirmEl.close()
      okEl.removeEventListener('click', onOk)
      cancelEl.removeEventListener('click', onCancel)
      resolve(result)
    }
    const onOk = () => done(true)
    const onCancel = () => done(false)
    okEl.addEventListener('click', onOk)
    cancelEl.addEventListener('click', onCancel)
    confirmEl.showModal()
  })
}

/** Perform a mutation, confirm first, then reload the tab that showed it. */
async function mutate(path, body, { title, confirm, okLabel, reload, success }) {
  if (confirm) {
    const agreed = await confirmAction(title, confirm, okLabel || 'Confirm')
    if (!agreed) return false
  }
  const res = await call(path, { method: 'POST', body })
  if (!res.ok) {
    const message = (res.json && res.json.error && res.json.error.message) || 'The change was not applied.'
    toast(message, true)
    return false
  }
  toast(success || 'Saved.')
  if (reload) await reload()
  return true
}

function errorLine(res) {
  const message = res && res.json && res.json.error ? res.json.error.message : null
  return message || 'The API did not return usable data.'
}

// ── panels ─────────────────────────────────────────────────────────────────

const panels = {}
for (const el of document.querySelectorAll('.panel')) panels[el.dataset.panel] = el

function setPanel(name, ...content) {
  const el = panels[name]
  el.replaceChildren(...content)
}

const loaded = new Set()

async function loadOverview(force = false) {
  if (loaded.has('overview') && !force) return
  setPanel('overview', h('p', { class: 'note', text: 'Loading metrics…' }))
  const metrics = await call('/admin/metrics')
  if (!metrics.ok) {
    setPanel('overview', h('p', { class: 'note danger', text: errorLine(metrics) }))
    return
  }
  const usage = await call('/admin/ai/usage?days=30')
  const m = metrics.json.data || {}
  const u = usage.ok ? usage.json.data : null

  const cards = [
    metric('Total accounts', m.users && num(m.users.total)),
    metric('Active', m.users && num(m.users.active)),
    metric('Suspended', m.users && num(m.users.suspended)),
    metric('Disabled', m.users && num(m.users.disabled)),
    metric('New accounts', m.users && num(m.users.new7d), 'last 7 days'),
    metric('New accounts', m.users && num(m.users.new30d), 'last 30 days'),
    metric('Signed in', m.users && num(m.users.signedIn7d), 'last 7 days'),
    metric('Google-linked', m.users && num(m.users.google)),
    metric('Password credentials', m.users && num(m.users.withPassword)),
    metric('Administrators', num(m.admins)),
    metric('Active sessions', m.sessions && num(m.sessions.active)),
    metric('Downloads', m.downloads && num(m.downloads.total)),
    metric('Downloads', m.downloads && num(m.downloads.last7d), 'last 7 days'),
    metric('Unique downloaders', m.downloads && num(m.downloads.uniqueUsers)),
    metric('Active subscriptions', m.subscriptions && num(m.subscriptions.active)),
    metric('Providers enabled', m.providers && `${num(m.providers.active)} of ${num(m.providers.total)}`),
    metric('Models enabled', m.models && `${num(m.models.active)} of ${num(m.models.total)}`),
    metric('Feature flags on', m.flags && `${num(m.flags.enabled)} of ${num(m.flags.total)}`),
    metric('Shared AI requests', u && u.totals ? num(u.totals.requests) : null, 'last 30 days'),
    metric('Provider failures', u && u.totals ? num(u.totals.failed) : null, 'last 30 days'),
    metric('Limit rejections', u && u.totals ? num(u.totals.limitRejections) : null, 'last 30 days'),
    metric('AI cost (recorded)', u && u.totals ? money(u.totals.costUsd) : null, 'last 30 days'),
    metric('Monthly budget', u && u.budget && u.budget.enforced ? money(u.budget.monthlyUsd) : null, 'company cap'),
    metric('Budget remaining', u && u.budget && u.budget.enforced ? money(u.budget.remainingUsd) : null, 'this month')
  ]

  const planMix = m.subscriptions && m.subscriptions.byPlan ? Object.entries(m.subscriptions.byPlan) : []
  const extras = [
    h(
      'div',
      { class: 'card' },
      h('h2', { text: 'Reporting window' }),
      h('p', {
        class: 'note',
        text: 'Counts are live from the database at the moment of this request. AI figures cover the last 30 days unless a different range is chosen on the Usage tab. Server time: ' + when(m.serverTime)
      })
    )
  ]
  if (planMix.length > 0) {
    extras.push(
      h(
        'div',
        { class: 'card' },
        h('h2', { text: 'Active subscriptions by plan' }),
        h(
          'ul',
          { class: 'note' },
          planMix.map(([plan, count]) => h('li', { text: `${plan}: ${num(count)}` }))
        )
      )
    )
  }
  extras.push(
    h(
      'div',
      { class: 'card' },
      h('h2', { text: 'Maintenance mode' }),
      h('p', {
        class: 'note',
        text: m.maintenance && m.maintenance.active
          ? `Active — ordinary accounts are refused with: ${m.maintenance.message || '(default message)'}`
          : 'Off — every account can sign in.'
      })
    )
  )

  setPanel('overview', h('div', { class: 'grid' }, cards), h('div', { class: 'section', style: 'margin-top:20px' }, extras))
  loaded.add('overview')
}

let userQuery = ''
let userOffset = 0

async function loadUsers(force = false) {
  if (loaded.has('users') && !force) return
  const limit = 25
  const res = await call(
    `/admin/users?limit=${limit}&offset=${userOffset}&query=${encodeURIComponent(userQuery)}`
  )
  if (!res.ok) {
    setPanel('users', h('p', { class: 'note danger', text: errorLine(res) }))
    return
  }
  const page = res.json.data || { rows: [], total: 0, limit, offset: userOffset }

  const search = h('form', { class: 'row', onsubmit: (event) => event.preventDefault() })
  const input = h('input', {
    type: 'search',
    placeholder: 'Search by email or name',
    value: userQuery,
    'aria-label': 'Search accounts'
  })
  search.append(
    h('div', { class: 'field' }, h('span', { text: 'Find an account' }), input),
    h('button', { class: 'btn primary sm', type: 'submit', text: 'Search' }),
    h('button', {
      class: 'btn ghost sm',
      type: 'button',
      text: 'Clear',
      onclick: () => {
        userQuery = ''
        userOffset = 0
        loadUsers(true)
      }
    })
  )
  search.addEventListener('submit', () => {
    userQuery = input.value.trim()
    userOffset = 0
    loadUsers(true)
  })

  const rows = (page.rows || []).map((user) => {
    const statusPill = h('span', {
      class: `pill ${user.status === 'active' ? 'ok' : user.status === 'suspended' ? 'warn' : 'bad'}`,
      text: user.status
    })
    const open = h('button', { class: 'btn ghost sm', type: 'button', text: 'Open', onclick: () => openUser(user.id) })
    return [
      h('span', {}, user.email || '—', user.isAdmin ? h('span', { class: 'pill ok', text: 'admin' }) : null),
      user.fullName || '—',
      statusPill,
      user.plan || '—',
      num(user.tokensMtd),
      num(user.requestsMtd),
      num(user.sessionsActive),
      when(user.createdAt),
      open
    ]
  })

  const start = page.total === 0 ? 0 : userOffset + 1
  const end = userOffset + (page.rows || []).length
  const pager = h(
    'div',
    { class: 'row', style: 'margin-top:10px' },
    h('button', {
      class: 'btn ghost sm',
      type: 'button',
      text: 'Previous',
      disabled: userOffset === 0 ? '' : null,
      onclick: () => {
        userOffset = Math.max(0, userOffset - limit)
        loadUsers(true)
      }
    }),
    h('button', {
      class: 'btn ghost sm',
      type: 'button',
      text: 'Next',
      disabled: end >= page.total ? '' : null,
      onclick: () => {
        userOffset += limit
        loadUsers(true)
      }
    }),
    h('span', { class: 'note', text: `Showing ${num(start)}–${num(end)} of ${num(page.total)} accounts` })
  )

  setPanel(
    'users',
    h('div', { class: 'section' }, search),
    h('div', { class: 'section' }, table(
      ['Email', 'Name', 'Status', 'Plan', 'Tokens this month', 'Requests today', 'Sessions', 'Created', ''],
      rows,
      'No account matches that search.'
    ), pager),
    h('div', { class: 'drawer', 'data-user-detail': '1' }, h('p', { class: 'note', text: 'Open an account to see its plan, entitlements, devices, sessions, downloads and audit trail.' }))
  )
  loaded.add('users')
}

async function openUser(userId) {
  const host = panels.users.querySelector('[data-user-detail]')
  host.replaceChildren(h('p', { class: 'note', text: 'Loading account…' }))
  const res = await call(`/admin/users/${encodeURIComponent(userId)}`)
  if (!res.ok) {
    host.replaceChildren(h('p', { class: 'note danger', text: errorLine(res) }))
    return
  }
  const d = res.json.data || {}
  const a = d.account || {}
  const overview = await call('/admin/catalog')
  const plans = overview.ok && overview.json.data ? overview.json.data.plans || [] : []

  const planSelect = h(
    'select',
    { 'aria-label': 'Plan' },
    plans.map((plan) => h('option', { value: plan.code, text: `${plan.name} (${plan.code})` }))
  )
  if (a.planCode || (d.plan && d.plan.code)) planSelect.value = (d.plan && d.plan.code) || ''

  const featureInput = h('input', { type: 'text', placeholder: 'feature, e.g. limit.tokens', 'aria-label': 'Feature' })
  const valueInput = h('input', { type: 'text', placeholder: 'value, e.g. 500000 (JSON also allowed)', 'aria-label': 'Value' })
  const reasonInput = h('input', { type: 'text', placeholder: 'reason (recorded in the audit log)', 'aria-label': 'Reason' })

  const actions = h(
    'div',
    { class: 'row', style: 'margin-top:12px' },
    h('button', {
      class: 'btn ghost sm',
      type: 'button',
      text: 'Revoke all sessions',
      onclick: () =>
        mutate(
          `/admin/users/${userId}/sessions/revoke`,
          { reason: 'administrator action from the control center' },
          {
            title: 'Revoke every session',
            confirm: `This signs ${a.email || 'this account'} out of every device immediately.`,
            okLabel: 'Revoke sessions',
            reload: () => openUser(userId),
            success: 'Sessions revoked.'
          }
        )
    }),
    h('button', {
      class: 'btn ghost sm',
      type: 'button',
      text: a.status === 'active' ? 'Suspend account' : 'Restore access',
      onclick: () =>
        mutate(
          `/admin/users/${userId}/status`,
          { status: a.status === 'active' ? 'suspended' : 'active' },
          {
            title: a.status === 'active' ? 'Suspend this account' : 'Restore access',
            confirm:
              a.status === 'active'
                ? 'A suspended account cannot sign in or start shared AI requests. Local models on their own machine are unaffected.'
                : 'This lets the account sign in again and use its allowances.',
            okLabel: a.status === 'active' ? 'Suspend' : 'Restore',
            reload: () => openUser(userId)
          }
        )
    }),
    h('button', {
      class: 'btn ghost sm',
      type: 'button',
      text: a.isAdmin ? 'Revoke administrator' : 'Grant administrator',
      onclick: () =>
        mutate(
          `/admin/users/${userId}/admin`,
          { admin: !a.isAdmin, roleCode: 'admin' },
          {
            title: a.isAdmin ? 'Revoke administrator access' : 'Grant administrator access',
            confirm: a.isAdmin
              ? 'They lose access to this control center immediately.'
              : 'They gain full access to this control center, including other accounts.',
            okLabel: a.isAdmin ? 'Revoke' : 'Grant',
            reload: () => openUser(userId)
          }
        )
    })
  )

  const planRow = h(
    'div',
    { class: 'row', style: 'margin-top:12px' },
    h('div', { class: 'field' }, h('span', { text: 'Plan' }), planSelect),
    h('button', {
      class: 'btn primary sm',
      type: 'button',
      text: 'Change plan',
      onclick: () =>
        mutate(
          `/admin/users/${userId}/plan`,
          { planCode: planSelect.value },
          {
            title: 'Change subscription plan',
            confirm: `Set this account's plan to ${planSelect.value}. The previous subscription is cancelled.`,
            okLabel: 'Change plan',
            reload: () => openUser(userId)
          }
        )
    })
  )

  const overrideRow = h(
    'div',
    { class: 'row', style: 'margin-top:12px' },
    h('div', { class: 'field' }, h('span', { text: 'Feature or limit' }), featureInput),
    h('div', { class: 'field' }, h('span', { text: 'Value' }), valueInput),
    h('div', { class: 'field' }, h('span', { text: 'Reason' }), reasonInput),
    h('button', {
      class: 'btn ghost sm',
      type: 'button',
      text: 'Grant override',
      onclick: async () => {
        const feature = featureInput.value.trim()
        const rawValue = valueInput.value.trim()
        if (!feature || !rawValue) {
          toast('A feature and a value are required.', true)
          return
        }
        let value = rawValue
        try {
          value = JSON.parse(rawValue)
        } catch {
          /* a bare string like "true" or a number is used as given */
        }
        await mutate(
          `/admin/users/${userId}/overrides`,
          { feature, value, reason: reasonInput.value.trim() || null },
          {
            title: 'Grant an entitlement override',
            confirm: `${feature} = ${rawValue} for ${a.email || 'this account'}. Overrides beat plan features until they expire.`,
            okLabel: 'Grant',
            reload: () => openUser(userId)
          }
        )
      }
    })
  )

  const grid = h(
    'dl',
    { class: 'kv' },
    h('dt', { text: 'Account' }), h('dd', { text: a.email || '—' }),
    h('dt', { text: 'Name' }), h('dd', { text: a.fullName || '—' }),
    h('dt', { text: 'Status' }), h('dd', { text: a.status || '—' }),
    h('dt', { text: 'Identifiers' }), h('dd', { text: (a.identityProviders || []).join(', ') || '—' }),
    h('dt', { text: 'Password set' }), h('dd', { text: a.hasPassword ? 'Yes' : 'No' }),
    h('dt', { text: 'Roles' }), h('dd', { text: (a.roles || []).join(', ') || 'none' }),
    h('dt', { text: 'Created' }), h('dd', { text: when(a.createdAt) }),
    h('dt', { text: 'Last sign-in' }), h('dd', { text: when(a.lastSignInAt) }),
    h('dt', { text: 'Plan' }), h('dd', { text: d.plan ? `${d.plan.name} (${d.plan.code}) — ${d.plan.status}` : 'none' }),
    h('dt', { text: 'Period ends' }), h('dd', { text: d.plan ? when(d.plan.periodEnd) : '—' })
  )

  host.replaceChildren(
    h('h2', { text: 'Account detail' }),
    grid,
    h('h2', { style: 'margin-top:16px', text: 'Usage this month' }),
    table(
      ['Resource', 'Used', 'Period start'],
      (d.usage || []).map((row) => [row.resource, num(row.used), when(row.periodStart)]),
      'No usage recorded this month.'
    ),
    h('h2', { style: 'margin-top:16px', text: 'Entitlement overrides' }),
    table(
      ['Feature', 'Value', 'Ends', 'Reason', ''],
      (d.overrides || []).map((row) => [
        row.feature,
        JSON.stringify(row.value),
        row.endsAt ? when(row.endsAt) : 'never',
        row.reason || '—',
        h('button', {
          class: 'btn ghost sm',
          type: 'button',
          text: 'Revoke',
          onclick: () =>
            mutate(`/admin/overrides/${row.id}/revoke`, {}, {
              title: 'Revoke override',
              confirm: `Remove the ${row.feature} override. The account falls back to its plan.`,
              okLabel: 'Revoke',
              reload: () => openUser(userId)
            })
        })
      ]),
      'No overrides.'
    ),
    h('div', { class: 'section', style: 'margin-top:16px' }, planRow, overrideRow, actions),
    h('h2', { style: 'margin-top:16px', text: 'Sessions' }),
    table(
      ['Created', 'Last used', 'Expires', 'Active', 'IP', ''],
      (d.sessions || []).map((row) => [
        when(row.createdAt),
        when(row.lastUsedAt),
        when(row.expiresAt),
        row.active ? 'yes' : 'no',
        row.ip || '—',
        row.active
          ? h('button', {
              class: 'btn ghost sm',
              type: 'button',
              text: 'Revoke',
              onclick: () =>
                mutate(`/admin/sessions/${row.id}/revoke`, { reason: 'administrator action' }, {
                  title: 'Revoke this session',
                  confirm: 'That device must sign in again.',
                  okLabel: 'Revoke',
                  reload: () => openUser(userId)
                })
            })
          : null
      ]),
      'No sessions recorded.'
    ),
    h('h2', { style: 'margin-top:16px', text: 'Devices' }),
    table(
      ['Platform', 'App version', 'First seen', 'Last seen'],
      (d.devices || []).map((row) => [row.platform, row.appVersion, when(row.firstSeenAt), when(row.lastSeenAt)]),
      'No devices recorded.'
    ),
    h('h2', { style: 'margin-top:16px', text: 'Downloads' }),
    table(
      ['Version', 'Platform', 'When'],
      (d.downloads || []).map((row) => [row.version || '—', row.platform || '—', when(row.createdAt)]),
      'No downloads recorded.'
    ),
    // Conversations are deliberately absent: administrators do not read private
    // content by default. Sessions, usage and audit are visible; message bodies are not.
    h('h2', { style: 'margin-top:16px', text: 'Account activity (audit)' }),
    table(
      ['When', 'Action', 'Detail'],
      (d.activity || []).map((row) => [when(row.createdAt), row.action, JSON.stringify(row.detail)]),
      'No recorded activity for this account.'
    )
  )
}

async function loadAi(force = false) {
  if (loaded.has('ai') && !force) return
  const creds = await call('/admin/providers/credentials')
  const models = await call('/admin/models/availability')
  if (!creds.ok) {
    setPanel('ai', h('p', { class: 'note danger', text: errorLine(creds) }))
    return
  }
  const c = creds.json.data || {}
  const storage = c.storage || {}

  const credentialNote = h(
    'div',
    { class: 'card' },
    h('h2', { text: 'How provider keys are stored' }),
    h('p', {
      class: 'note',
      text: 'Keys are deployment secrets, not database rows: they are read from the API Function\u2019s own environment and are never returned to a browser. Set the value in .env.local (which is gitignored), then run the deploy script.'
    }),
    h('p', { class: 'note', text: `Variable: ${storage.variable || 'OPENROUTER_API_KEY'}` }),
    h('p', {
      class: 'note',
      text: c.gateway && c.gateway.configured
        ? 'The Neon AI Gateway is configured, so every provider routes through one credential.'
        : 'No AI gateway is configured, so each provider needs its own key.'
    }),
    h('p', {
      class: 'note',
      text: 'Changing a key takes effect for new requests as soon as the Function is redeployed — no desktop app rebuild is needed, because the desktop app never holds a provider key.'
    })
  )

  const spendInputs = new Map()
  const providerRows = (c.providers || []).map((provider) => {
    const spend = h('input', {
      type: 'number',
      min: '0',
      step: '0.01',
      value: provider.spendLimitUsd === null || provider.spendLimitUsd === undefined ? '' : String(provider.spendLimitUsd),
      placeholder: 'no cap',
      'aria-label': `${provider.label} monthly spend cap in USD`
    })
    spendInputs.set(provider.code, spend)
    return [
      h('span', {}, provider.label, h('span', { class: 'pill', text: provider.code })),
      provider.baseUrl || '—',
      provider.apiKeyEnv,
      provider.configured
        ? h('span', {}, h('span', { class: 'pill ok', text: provider.viaGateway ? 'via gateway' : 'configured' }),
            provider.keyFingerprint ? h('span', { class: 'note', text: ` key ${provider.keyFingerprint}` }) : null)
        : h('span', { class: 'pill bad', text: 'not configured' }),
      provider.active ? h('span', { class: 'pill ok', text: 'enabled' }) : h('span', { class: 'pill warn', text: 'disabled' }),
      h('div', { class: 'row' }, spend, 'USD/month'),
      h('div', { class: 'row' },
        h('button', {
          class: 'btn ghost sm',
          type: 'button',
          text: provider.active ? 'Disable' : 'Enable',
          onclick: () =>
            mutate('/admin/providers/policy', { code: provider.code, active: !provider.active }, {
              title: provider.active ? `Disable ${provider.label}` : `Enable ${provider.label}`,
              confirm: provider.active
                ? 'Every model from this provider stops working for shared requests. Users with their own key or a local model are unaffected.'
                : 'Shared requests can use this provider again.',
              okLabel: provider.active ? 'Disable provider' : 'Enable provider',
              reload: () => loadAi(true)
            })
        }),
        h('button', {
          class: 'btn ghost sm',
          type: 'button',
          text: 'Save cap',
          onclick: () => {
            const value = spend.value.trim()
            return mutate('/admin/providers/policy', {
              code: provider.code,
              spendLimitUsd: value === '' ? null : Number(value)
            }, {
              title: 'Set a monthly spend cap',
              confirm: value === ''
                ? 'Clear the cap for this provider.'
                : `Stop shared ${provider.label} requests once this month's recorded cost reaches $${value}.`,
              okLabel: 'Save cap',
              reload: () => loadAi(true)
            })
          }
        })
      )
    ]
  })

  const modelRes = models.ok ? models.json.data || { models: [] } : { models: [] }
  const modelRows = (modelRes.models || []).map((model) => [
    model.label,
    model.modelId,
    model.providerCode,
    model.free ? h('span', { class: 'pill ok', text: 'free' }) : h('span', { class: 'pill warn', text: 'paid' }),
    model.costInputPerMtok === null
      ? h('span', { class: 'note', text: 'price unknown' })
      : `${money(model.costInputPerMtok)} in / ${money(model.costOutputPerMtok)} out per 1M`,
    model.status === 'verified'
      ? h('span', { class: 'pill ok', text: 'verified' })
      : model.status === 'failing'
        ? h('span', { class: 'pill bad', text: 'failing' })
        : h('span', { class: 'pill', text: 'unverified' }),
    num(model.requests30d),
    num(model.failed30d),
    model.lastError || '—',
    h('button', {
      class: 'btn ghost sm',
      type: 'button',
      text: model.defaultAllowed ? 'Restrict to plans' : 'Allow by default',
      onclick: () =>
        mutate('/admin/models', { id: model.id, defaultAllowed: !model.defaultAllowed }, {
          title: model.defaultAllowed ? 'Require an explicit plan grant' : 'Allow for every plan',
          confirm: model.defaultAllowed
            ? 'New accounts will no longer reach this model unless a plan grants it.'
            : 'Every plan, including free, will be able to run this model. Paid models should usually stay restricted.',
          okLabel: 'Apply',
          reload: () => loadAi(true)
        })
    })
  ])

  setPanel(
    'ai',
    h('div', { class: 'section' }, credentialNote),
    h('h2', { text: 'Providers' }),
    h('div', { class: 'section' }, table(
      ['Provider', 'Base URL', 'Key variable', 'Credential', 'State', 'Monthly cap', 'Actions'],
      providerRows,
      'No providers are registered.'
    )),
    h('h2', { text: 'Models' }),
    h('p', {
      class: 'note',
      text: 'A model is “verified” only once a real request has completed against it. “Unverified” means the catalog lists it but no request has succeeded yet — it is not a claim that it works.'
    }),
    h('div', { class: 'section' }, table(
      ['Label', 'Model id', 'Provider', 'Class', 'Published price', 'Status', 'Requests 30d', 'Failed 30d', 'Last error', ''],
      modelRows,
      'No models are registered.'
    ))
  )
  loaded.add('ai')
}

async function loadUsage(days = 30, force = false) {
  const key = `usage:${days}`
  if (loaded.has(key) && !force) return
  const res = await call(`/admin/ai/usage?days=${days}`)
  if (!res.ok) {
    setPanel('usage', h('p', { class: 'note danger', text: errorLine(res) }))
    return
  }
  const d = res.json.data || {}
  const t = d.totals || {}
  const budget = d.budget || {}
  const shared = d.shared || {}

  const range = h(
    'form',
    { class: 'row', onsubmit: (event) => event.preventDefault() },
    h('div', { class: 'field' }, h('span', { text: 'Window' }),
      h('select', { 'aria-label': 'Reporting window' },
        [7, 30, 90, 365].map((value) => h('option', { value: String(value), text: `Last ${value} days` })))),
    h('button', { class: 'btn primary sm', type: 'submit', text: 'Apply' })
  )
  const select = range.querySelector('select')
  select.value = String(days)
  range.addEventListener('submit', () => {
    loaded.delete('usage:7')
    loaded.delete('usage:30')
    loaded.delete('usage:90')
    loaded.delete('usage:365')
    loadUsage(Number(select.value), true)
  })

  const budgetInput = h('input', {
    type: 'number',
    min: '0',
    step: '1',
    placeholder: 'no cap',
    value: budget.monthlyUsd === null || budget.monthlyUsd === undefined ? '' : String(budget.monthlyUsd),
    'aria-label': 'Company monthly AI budget in USD'
  })

  const controls = h(
    'div',
    { class: 'section' },
    h('h2', { text: 'Spending controls' }),
    h('p', {
      class: 'note',
      text: `Recorded spend this month: ${money(budget.spentMtdUsd)}. The cap is enforced inside Alpha on every claim, so it cannot be bypassed by a client — OpenRouter's own key limit is a second, independent safeguard.`
    }),
    h('div', { class: 'row' },
      h('button', {
        class: 'btn ghost sm',
        type: 'button',
        text: shared.enabled ? 'Turn off shared cloud AI' : 'Turn shared cloud AI back on',
        onclick: () =>
          mutate('/admin/settings', { key: 'ai_shared', value: { enabled: !shared.enabled, message: shared.enabled ? 'Shared cloud AI is paused right now. Local models and your own provider keys still work.' : null } }, {
            title: shared.enabled ? 'Pause shared cloud AI' : 'Resume shared cloud AI',
            confirm: shared.enabled
              ? 'Every user is refused company-funded cloud requests immediately. Local models and BYOK are unaffected.'
              : 'Company-funded cloud requests resume for users whose plan includes them.',
            okLabel: shared.enabled ? 'Pause shared AI' : 'Resume',
            reload: () => loadUsage(days, true)
          })
      }),
      h('div', { class: 'field' }, h('span', { text: 'Company monthly budget (USD)' }), budgetInput),
      h('button', {
        class: 'btn ghost sm',
        type: 'button',
        text: 'Save budget',
        onclick: () => {
          const value = budgetInput.value.trim()
          return mutate('/admin/settings', { key: 'ai_budget', value: { enabled: value !== '', monthlyUsd: value === '' ? null : Number(value) } }, {
            title: 'Set the company AI budget',
            confirm: value === ''
              ? 'Remove the monthly cap. Spending will only be limited by each account\u2019s own allowance.'
              : `Stop all shared cloud requests once recorded spend reaches $${value} this month.`,
            okLabel: 'Save budget',
            reload: () => loadUsage(days, true)
          })
        }
      })
    )
  )

  const costCard = h(
    'div',
    { class: 'card' },
    h('h2', { text: 'How these costs are known' }),
    h('p', {
      class: 'note',
      text: `Provider-reported: ${money(t.reportedCostUsd)} across ${num(t.pricedRequests)} priced requests. Estimates from published list prices: ${money(t.estimatedCostUsd)}. An estimate is labelled as one and is never presented as a charge; token counts are exact, money is not, unless the provider supplied it.`
    })
  )

  setPanel(
    'usage',
    h('div', { class: 'section' }, range),
    h('div', { class: 'grid' },
      metric('Requests', num(t.requests), `last ${days} days`),
      metric('Succeeded', num(t.succeeded), `last ${days} days`),
      metric('Failed', num(t.failed), `last ${days} days`),
      metric('Cancelled by user', num(t.cancelled), `last ${days} days`),
      metric('In flight now', num(t.inFlight), 'live'),
      metric('Refused by a limit', num(t.limitRejections), `last ${days} days`),
      metric('Tokens', num(t.tokens), `last ${days} days`),
      metric('Cost (all priced)', money(t.costUsd), `last ${days} days`),
      metric('Cost reported by provider', money(t.reportedCostUsd), `last ${days} days`),
      metric('Cost estimated from list price', money(t.estimatedCostUsd), `last ${days} days`),
      metric('Average response', t.avgDurationMs === null || t.avgDurationMs === undefined ? null : `${num(t.avgDurationMs)} ms`, `last ${days} days`)
    ),
    h('div', { class: 'section', style: 'margin-top:20px' }, costCard),
    controls,
    h('h2', { text: 'By day' }),
    h('div', { class: 'section' }, table(
      ['Day', 'Requests', 'Failed', 'Tokens', 'Cost'],
      (d.byDay || []).map((row) => [String(row.day).slice(0, 10), num(row.requests), num(row.failed), num(row.tokens), money(row.costUsd)]),
      'No requests in this window.'
    )),
    h('h2', { text: 'By model' }),
    h('div', { class: 'section' }, table(
      ['Provider', 'Model', 'Requests', 'Failed', 'Tokens', 'Cost'],
      (d.byModel || []).map((row) => [row.providerCode, row.modelId, num(row.requests), num(row.failed), num(row.tokens), money(row.costUsd)]),
      'No model usage in this window.'
    )),
    h('h2', { text: 'By provider' }),
    h('div', { class: 'section' }, table(
      ['Provider', 'Requests', 'Tokens', 'Cost'],
      (d.byProvider || []).map((row) => [row.providerCode, num(row.requests), num(row.tokens), money(row.costUsd)]),
      'No provider usage in this window.'
    )),
    h('h2', { text: 'Errors' }),
    h('div', { class: 'section' }, table(
      ['Code', 'Occurrences'],
      (d.errors || []).map((row) => [row.errorCode, num(row.count)]),
      'No failures in this window.'
    )),
    h('h2', { text: 'Highest consumers' }),
    h('div', { class: 'section' }, table(
      ['Account', 'Requests', 'Tokens', 'Cost'],
      (d.topConsumers || []).map((row) => [row.userId, num(row.requests), num(row.tokens), money(row.costUsd)]),
      'No consumers in this window.'
    ))
  )
  loaded.add(key)
}

async function loadPlans(force = false) {
  if (loaded.has('plans') && !force) return
  const res = await call('/admin/catalog')
  if (!res.ok) {
    setPanel('plans', h('p', { class: 'note danger', text: errorLine(res) }))
    return
  }
  const d = res.json.data || {}
  const planById = new Map((d.plans || []).map((plan) => [plan.id, plan]))

  const featureValue = h('input', { type: 'text', placeholder: 'value as JSON, e.g. 500000 or true', 'aria-label': 'Feature value' })
  const featureName = h('input', { type: 'text', placeholder: 'feature, e.g. limit.tokens', 'aria-label': 'Feature name' })
  const featurePlan = h('select', { 'aria-label': 'Plan' },
    (d.plans || []).map((plan) => h('option', { value: plan.id, text: plan.name })))

  const flagRows = (d.flags || []).map((flag) => [
    flag.key,
    flag.enabled ? h('span', { class: 'pill ok', text: 'on' }) : h('span', { class: 'pill', text: 'off' }),
    String(flag.rollout ?? 100) + '%',
    flag.description || '—',
    h('button', {
      class: 'btn ghost sm',
      type: 'button',
      text: flag.enabled ? 'Turn off' : 'Turn on',
      onclick: () =>
        mutate('/admin/flags', { key: flag.key, enabled: !flag.enabled, description: flag.description, rollout: flag.rollout ?? 100 }, {
          title: `${flag.enabled ? 'Turn off' : 'Turn on'} ${flag.key}`,
          confirm: 'Feature flags are read by clients on their next config load.',
          okLabel: 'Apply',
          reload: () => loadPlans(true)
        })
    })
  ])

  setPanel(
    'plans',
    h('h2', { text: 'Plans' }),
    h('p', { class: 'note', text: 'Prices are whatever this table says. No payment provider is connected, so changing a price changes what the product advertises, not what anyone is charged.' }),
    h('div', { class: 'section' }, table(
      ['Code', 'Name', 'Interval', 'Price', 'Active', 'Trial'],
      (d.plans || []).map((plan) => [
        plan.code,
        plan.name,
        plan.interval,
        plan.price_cents === 0 ? 'free' : money(plan.price_cents / 100),
        plan.active ? 'yes' : 'no',
        plan.is_trial ? `yes (${plan.trial_days}d)` : 'no'
      ]),
      'No plans defined.'
    )),
    h('h2', { text: 'What each plan grants' }),
    h('div', { class: 'section' }, table(
      ['Plan', 'Feature or limit', 'Value'],
      (d.planFeatures || []).map((row) => [
        (planById.get(row.plan_id) || {}).name || row.plan_id,
        row.feature,
        JSON.stringify(row.value)
      ]),
      'No plan features defined.'
    )),
    h('div', { class: 'section' },
      h('h2', { text: 'Change a plan feature' }),
      h('div', { class: 'row' },
        h('div', { class: 'field' }, h('span', { text: 'Plan' }), featurePlan),
        h('div', { class: 'field' }, h('span', { text: 'Feature' }), featureName),
        h('div', { class: 'field' }, h('span', { text: 'Value' }), featureValue),
        h('button', {
          class: 'btn primary sm',
          type: 'button',
          text: 'Save feature',
          onclick: async () => {
            const feature = featureName.value.trim()
            const rawValue = featureValue.value.trim()
            if (!feature || !rawValue) {
              toast('A feature and a value are required.', true)
              return
            }
            let value = rawValue
            try {
              value = JSON.parse(rawValue)
            } catch {
              /* keep the raw string */
            }
            await mutate(`/admin/plans/${featurePlan.value}/features`, { feature, value }, {
              title: 'Change an entitlement',
              confirm: `${feature} becomes ${rawValue} for this plan. Every account on the plan is affected on its next config load.`,
              okLabel: 'Save feature',
              reload: () => loadPlans(true)
            })
          }
        })
      ),
      h('p', { class: 'note', text: 'Limits use the prefix limit. (for example limit.tokens, limit.requests_day); anything else is treated as a feature switch.' })
    ),
    h('h2', { text: 'Feature flags' }),
    h('div', { class: 'section' }, table(['Key', 'State', 'Rollout', 'Description', ''], flagRows, 'No feature flags defined.'))
  )
  loaded.add('plans')
}

async function loadSecurity(force = false) {
  if (loaded.has('security') && !force) return
  const hours = 24
  const overview = await call(`/admin/security?hours=${hours}`)
  const audit = await call('/admin/audit?limit=200')
  if (!overview.ok) {
    setPanel('security', h('p', { class: 'note danger', text: errorLine(overview) }))
    return
  }
  const d = overview.json.data || {}
  // Deliberately not named `window`: that would shadow the global inside this scope.
  const windowHours = (d.window && d.window.hours) || hours

  setPanel(
    'security',
    h('div', { class: 'grid' },
      metric('Administrators', num((d.admins || []).length), 'total'),
      metric('Active sessions', num((d.activeSessions || []).length), `right now`),
      metric('Accounts not active', num(d.suspendedAccounts), 'suspended or disabled'),
      metric('Failed sign-in attempts', num((d.failedAttempts || []).length), `last ${windowHours} hours`)
    ),
    h('h2', { style: 'margin-top:20px', text: 'Administrator accounts' }),
    h('div', { class: 'section' }, table(
      ['Email', 'Roles', 'Status', 'Last sign-in'],
      (d.admins || []).map((row) => [row.email, (row.roles || []).join(', '), row.status, when(row.lastSignInAt)]),
      'No administrators recorded.'
    )),
    h('h2', { text: 'Recent privileged and authentication events' }),
    h('div', { class: 'section' }, table(
      ['When', 'Action', 'Actor', 'Detail'],
      (d.adminLogins || []).map((row) => [when(row.createdAt), row.action, row.actorId || '—', JSON.stringify(row.detail)]),
      `Nothing recorded in the last ${windowHours} hours.`
    )),
    h('h2', { text: 'Failed attempts' }),
    h('div', { class: 'section' }, table(
      ['Scope', 'Key', 'Attempts', 'Last attempt'],
      (d.failedAttempts || []).map((row) => [row.scope, row.key, num(row.attempts), when(row.lastAt)]),
      `No failed attempts in the last ${windowHours} hours.`
    )),
    h('h2', { text: 'Active sessions' }),
    h('div', { class: 'section' }, table(
      ['Account', 'Created', 'Last used', 'IP'],
      (d.activeSessions || []).map((row) => [row.email, when(row.createdAt), when(row.lastUsedAt), row.ip || '—']),
      'No active sessions.'
    )),
    h('h2', { text: 'Audit log' }),
    h('p', { class: 'note', text: 'Every administrative change is recorded with its actor. This log is append-only; nothing on this page edits or deletes it.' }),
    h('div', { class: 'section' }, table(
      ['When', 'Actor', 'Action', 'Target', 'Detail'],
      audit.ok
        ? (audit.json.data || []).map((row) => [when(row.createdAt), row.actorId || '—', row.action, row.target || '—', JSON.stringify(row.detail)])
        : [],
      audit.ok ? 'No audit entries.' : errorLine(audit)
    ))
  )
  loaded.add('security')
}

async function loadSystem(force = false) {
  if (loaded.has('system') && !force) return
  const res = await call('/admin/system')
  if (!res.ok) {
    setPanel('system', h('p', { class: 'note danger', text: errorLine(res) }))
    return
  }
  const d = res.json.data || {}
  const db = d.database || {}
  const maintenance = d.maintenance || {}
  const messageInput = h('input', { type: 'text', placeholder: 'message shown to ordinary accounts', 'aria-label': 'Maintenance message', value: maintenance.message || '' })

  const settings = d.settings || {}
  const settingKeys = Object.keys(settings)

  setPanel(
    'system',
    h('div', { class: 'grid' },
      metric('Database', db.connected ? 'Connected' : 'Unavailable'),
      metric('Query round trip', db.latencyMs === null || db.latencyMs === undefined ? null : `${db.latencyMs} ms`, 'measured now'),
      metric('Database size', num(db.sizeBytes) === '—' ? null : `${(Number(db.sizeBytes) / 1024 / 1024).toFixed(1)} MB`, 'current'),
      metric('Latest migration', db.migration || null),
      metric('Active sessions', d.posts && num(d.posts.sessionsActive), 'right now'),
      metric('Maintenance mode', maintenance.active ? 'Active' : 'Off')
    ),
    h('div', { class: 'section', style: 'margin-top:20px' },
      h('h2', { text: 'Maintenance mode' }),
      h('p', { class: 'note', text: 'While this is on, ordinary accounts cannot start a sign-in or fetch a download, and they see the message below instead of a generic failure. Administrators keep full access, so there is always a way back in.' }),
      h('div', { class: 'row' },
        h('div', { class: 'field' }, h('span', { text: 'Message for ordinary accounts' }), messageInput),
        h('button', {
          class: 'btn primary sm',
          type: 'button',
          text: maintenance.active ? 'Turn maintenance off' : 'Turn maintenance on',
          onclick: () =>
            mutate('/admin/settings', { key: 'maintenance', value: { active: !maintenance.active, message: messageInput.value.trim() || null } }, {
              title: maintenance.active ? 'End maintenance' : 'Begin maintenance',
              confirm: maintenance.active
                ? 'Sign-in and downloads work again for everybody.'
                : 'Ordinary accounts are refused sign-in and downloads until you turn this off. Existing sessions keep working.',
              okLabel: maintenance.active ? 'End maintenance' : 'Begin maintenance',
              reload: () => loadSystem(true)
            })
        })
      )
    ),
    h('h2', { text: 'Providers and models as the database sees them' }),
    h('div', { class: 'section' }, table(
      ['Provider', 'Kind', 'Key variable', 'Enabled', 'Active models'],
      (d.providers || []).map((row) => [row.label, row.kind, row.apiKeyEnv || '—', row.active ? 'yes' : 'no', num(row.models)]),
      'No providers registered.'
    )),
    h('h2', { text: 'Published releases' }),
    h('div', { class: 'section' }, table(
      ['Version', 'Channel', 'Platform', 'Published', 'Size', 'Minimum supported', 'Released'],
      (d.releases || []).map((row) => [
        row.version,
        row.channel,
        row.platform,
        row.published ? 'yes' : 'no',
        num(row.size) === '—' ? '—' : `${(Number(row.size) / 1024 / 1024).toFixed(1)} MB`,
        row.minimumSupportedVersion || '—',
        when(row.releasedAt)
      ]),
      'No releases recorded.'
    )),
    h('h2', { text: 'System settings (raw)' }),
    h('p', { class: 'note', text: 'These are the operator-controlled rows the API reads. Changing them bypasses the guided controls above, so prefer those.' }),
    h('div', { class: 'section' }, table(
      ['Key', 'Value', ''],
      settingKeys.map((key) => [
        key,
        JSON.stringify(settings[key]),
        key === 'bootstrap_admin_email' ? h('span', { class: 'pill', text: 'owner provisioning' }) : null
      ]),
      'No settings recorded.'
    ))
  )
  loaded.add('system')
}

// ── routing ────────────────────────────────────────────────────────────────

const loaders = {
  overview: () => loadOverview(true),
  users: () => loadUsers(true),
  ai: () => loadAi(true),
  usage: () => loadUsage(30, true),
  plans: () => loadPlans(true),
  security: () => loadSecurity(true),
  system: () => loadSystem(true)
}

function selectTab(name) {
  for (const tab of document.querySelectorAll('.tab')) {
    tab.setAttribute('aria-selected', String(tab.dataset.tab === name))
  }
  for (const [key, panel] of Object.entries(panels)) {
    panel.hidden = key !== name
  }
  if (loaders[name]) loaders[name]()
  const url = new URL(window.location.href)
  url.searchParams.set('tab', name)
  window.history.replaceState({}, '', `${url.pathname}?${url.searchParams.toString()}`)
}

for (const tab of document.querySelectorAll('.tab')) {
  tab.addEventListener('click', () => selectTab(tab.dataset.tab))
}
document.querySelector('[data-reload]').addEventListener('click', () => {
  loaded.clear()
  const active = document.querySelector('.tab[aria-selected="true"]')
  selectTab(active ? active.dataset.tab : 'overview')
})

function show(view) {
  for (const [key, el] of Object.entries(views)) el.hidden = key !== view
}

async function boot() {
  if (!apiBase()) {
    who.textContent = 'No API host configured'
    show('unconfigured')
    return
  }
  if (!session) {
    who.textContent = 'Not signed in'
    show('signedOut')
    return
  }
  const probe = await call('/admin/metrics')
  if (probe.status === 401) {
    who.textContent = 'Session expired'
    show('signedOut')
    return
  }
  if (!probe.ok) {
    if (probe.status === 403) {
      who.textContent = 'Signed in without administrator access'
      const detail = probe.json && probe.json.error ? probe.json.error.message : null
      if (detail) forbiddenDetail.textContent = detail
      show('forbidden')
      return
    }
    who.textContent = 'The API could not be reached'
    views.loading.replaceChildren(
      h('h2', { text: 'The API did not answer' }),
      h('p', { text: errorLine(probe) })
    )
    show('loading')
    return
  }

  who.textContent = `${session.email || 'Signed in'} · administrative access verified`
  show('ready')
  // The probe already proved access, so the overview can render from its result
  // without asking for the same data twice.
  const metricsTab = new URLSearchParams(window.location.search).get('tab') || 'overview'
  selectTab(loaders[metricsTab] ? metricsTab : 'overview')
}

boot().catch((error) => {
  console.error('[admin]', error)
  who.textContent = 'Failed to start'
  views.loading.replaceChildren(
    h('h2', { text: 'The page could not start' }),
    h('p', { text: 'A client-side error stopped the dashboard from loading. The console has the detail.' })
  )
  show('loading')
})
