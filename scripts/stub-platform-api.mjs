#!/usr/bin/env node
/**
 * QA-only stub of the Alpha platform API.
 *
 * The deployed API narrows CORS to the production site origin, so the signed-in
 * surfaces of `website/` cannot be exercised from `http://127.0.0.1`. This serves
 * the documented response shapes instead — nothing else. It is never used by the
 * site, the desktop app or a deployment; it exists so a browser check can render
 * the authenticated account and administration areas locally.
 *
 * It holds no credentials and no real data: every value below is a fixture that
 * exists to prove the UI renders the shape the real API returns. A real secret
 * must never be added here.
 *
 * Usage: node scripts/stub-platform-api.mjs [port]   (default 8199)
 *   --no-release   answer /downloads/latest with the "no release" error shape
 *   --unauthorized answer authenticated routes with 401 (expired session)
 *   --forbidden    answer /admin/* with 403 (signed in, not an administrator)
 *   --empty        answer /admin/* with empty collections (a brand-new install)
 */
import { createServer } from 'node:http'

const port = Number(process.argv.find((a) => /^\d+$/.test(a)) ?? 8199)
const noRelease = process.argv.includes('--no-release')
const unauthorized = process.argv.includes('--unauthorized')
const forbidden = process.argv.includes('--forbidden')
const empty = process.argv.includes('--empty')

const RELEASE = {
  version: '1.0.6',
  channel: 'stable',
  platform: 'win',
  notes: 'Stub release body — proves the account page renders real release notes.',
  url: 'https://github.com/martinssqeel-maker/Alpha-/releases/latest',
  size: 125492796,
  sha512: 'stub-checksum-not-a-real-digest',
  minimumSupportedVersion: '1.0.0',
  releasedAt: new Date('2026-10-13T09:00:00Z').toISOString()
}

const json = (res, status, body) => {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'authorization,content-type',
    'access-control-allow-methods': 'GET,POST,PATCH,DELETE,OPTIONS'
  })
  res.end(JSON.stringify(body))
}

const ok = (data) => ({ ok: true, data })
const fail = (code, message) => ({ ok: false, error: { code, message } })

const NOW = Date.now()
const daysAgo = (n) => new Date(NOW - n * 86_400_000).toISOString()

// One signed-in QA account, shaped exactly like the real self-service payloads.
const MY_ACCOUNT = {
  id: '99999999-9999-9999-9999-999999999999',
  email: 'qa@example.com',
  fullName: 'QA Tester',
  status: 'active',
  createdAt: daysAgo(45),
  lastSignInAt: daysAgo(0),
  providers: ['github'],
  hasPassword: false,
  admin: false
}

const MY_CONFIG = {
  account: { email: MY_ACCOUNT.email, fullName: MY_ACCOUNT.fullName, status: 'active' },
  plan: { id: 'plan-free', code: 'free', name: 'Free', interval: 'month', isTrial: false },
  subscription: null,
  features: {},
  limits: { tokens: 50000, requests_day: 10 },
  usage: [
    { resource: 'tokens', used: 41250, limit: 50000, unlimited: false },
    { resource: 'requests_day', used: 3, limit: 10, unlimited: false }
  ],
  models: [
    {
      modelId: 'google/gemma-4-31b-it:free',
      providerId: 'openrouter',
      providerLabel: 'OpenRouter',
      label: 'Gemma 4 31B',
      allowed: true,
      capabilities: { streaming: true, tools: true, vision: false },
      contextLength: 131072
    },
    {
      modelId: 'openai/gpt-5',
      providerId: 'openrouter',
      providerLabel: 'OpenRouter',
      label: 'GPT-5',
      allowed: false,
      capabilities: { streaming: true, tools: true, vision: true },
      contextLength: 400000
    }
  ],
  flags: {},
  maintenance: { active: false },
  announcements: [
    {
      id: 'ann-1',
      title: 'Scheduled maintenance',
      body: 'Cloud models are paused for 20 minutes on Sunday 02:00 UTC.',
      level: 'warning'
    }
  ],
  desktop: { current: '1.0.6', minVersion: '1.0.0', recommendedVersion: '1.0.6' },
  serverTime: new Date(NOW).toISOString()
}

const MY_SESSIONS = [
  {
    id: '5a5a5a5a-0000-4000-8000-000000000001',
    createdAt: daysAgo(2),
    lastUsedAt: daysAgo(0),
    expiresAt: daysAgo(-27),
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/141.0 Safari/537.36',
    ip: '203.0.113.7',
    current: true
  },
  {
    id: '5a5a5a5a-0000-4000-8000-000000000002',
    createdAt: daysAgo(6),
    lastUsedAt: daysAgo(1),
    expiresAt: daysAgo(-21),
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4) Firefox/142.0',
    ip: '198.51.100.4',
    current: false
  }
]

const MY_ACTIVITY = {
  days: 30,
  totals: { requests: 46, tokens: 132840, failed: 5, estimatedCostUsd: 0.3121, costBasis: 'estimate' },
  daily: [
    { day: daysAgo(6).slice(0, 10), requests: 4, tokens: 9800, failed: 0 },
    { day: daysAgo(4).slice(0, 10), requests: 9, tokens: 21400, failed: 1 },
    { day: daysAgo(3).slice(0, 10), requests: 12, tokens: 30110, failed: 1 },
    { day: daysAgo(2).slice(0, 10), requests: 19, tokens: 54220, failed: 3 },
    { day: daysAgo(1).slice(0, 10), requests: 2, tokens: 17310, failed: 0 }
  ],
  models: [
    { modelId: 'google/gemma-4-31b-it:free', providerId: 'openrouter', requests: 31, tokens: 61440 },
    { modelId: 'openai/gpt-5', providerId: 'openrouter', requests: 15, tokens: 71400 }
  ],
  recent: [
    { modelId: 'google/gemma-4-31b-it:free', providerId: 'openrouter', status: 'ok', tokens: 2840, createdAt: daysAgo(0), durationMs: 2210, errorCode: null },
    { modelId: 'openai/gpt-5', providerId: 'openrouter', status: 'error', tokens: 0, createdAt: daysAgo(1), durationMs: 902, errorCode: 'provider_rate_limited' },
    { modelId: 'google/gemma-4-31b-it:free', providerId: 'openrouter', status: 'ok', tokens: 5210, createdAt: daysAgo(1), durationMs: 3400, errorCode: null }
  ]
}

const MY_GATEWAY = {
  providers: [
    { code: 'openrouter', label: 'OpenRouter', active: true, configured: true, requests7d: 23, failed7d: 2, lastRequestAt: daysAgo(0) },
    { code: 'ollama', label: 'Ollama (local)', active: true, configured: false, requests7d: 4, failed7d: 0, lastRequestAt: daysAgo(1) }
  ],
  sharedEnabled: { enabled: true, message: null },
  budget: { configured: true, enforced: true, monthlyUsd: 10, spentMtdUsd: 0.73, remainingUsd: 9.27 },
  usage: MY_CONFIG.usage
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'))
      } catch {
        resolve({})
      }
    })
    req.on('error', () => resolve({}))
  })
}

const USERS = [
  {
    id: '11111111-1111-1111-1111-111111111111',
    email: 'founder@example.invalid',
    fullName: 'Alpha Founder',
    status: 'active',
    createdAt: daysAgo(40),
    lastSignInAt: daysAgo(1),
    isAdmin: true,
    plan: 'pro',
    identities: ['google'],
    hasPassword: true,
    devices: ['win32'],
    tokensMtd: 812340,
    requestsMtd: 4,
    sessionsActive: 2
  },
  {
    id: '22222222-2222-2222-2222-222222222222',
    email: 'student@example.invalid',
    fullName: null,
    status: 'active',
    createdAt: daysAgo(6),
    lastSignInAt: daysAgo(2),
    isAdmin: false,
    plan: 'free',
    identities: ['otp'],
    hasPassword: false,
    devices: ['win32'],
    tokensMtd: 41250,
    requestsMtd: 9,
    sessionsActive: 1
  },
  {
    id: '33333333-3333-3333-3333-333333333333',
    email: 'suspended@example.invalid',
    fullName: 'Paused Account',
    status: 'suspended',
    createdAt: daysAgo(21),
    lastSignInAt: daysAgo(9),
    isAdmin: false,
    plan: 'free',
    identities: ['github'],
    hasPassword: false,
    devices: [],
    tokensMtd: 0,
    requestsMtd: 0,
    sessionsActive: 0
  }
]

const ADMIN_METRICS = {
  users: {
    total: 3,
    active: 2,
    suspended: 1,
    disabled: 0,
    new7d: 1,
    new30d: 2,
    signedIn7d: 2,
    google: 1,
    withPassword: 1
  },
  admins: 1,
  sessions: { active: 3, total: 11 },
  downloads: { total: 17, last7d: 4, uniqueUsers: 2 },
  releases: { published: 1, latest: '1.0.6' },
  providers: { total: 4, active: 4 },
  models: { total: 14, active: 14 },
  flags: { total: 2, enabled: 2 },
  plans: 4,
  subscriptions: { active: 3, byPlan: { free: 2, pro: 1 } },
  announcements: { active: 0 },
  maintenance: { active: false },
  audit: { total: 26, lastAt: daysAgo(0) },
  serverTime: new Date(NOW).toISOString()
}

const AI_USAGE = {
  window: { days: 30, since: daysAgo(30) },
  totals: {
    requests: 46,
    succeeded: 39,
    failed: 5,
    cancelled: 2,
    inFlight: 0,
    limitRejections: 4,
    tokens: 132840,
    costUsd: 0.7341,
    estimatedCostUsd: 0.3121,
    reportedCostUsd: 0.422,
    pricedRequests: 33,
    avgDurationMs: 2814
  },
  byModel: [
    { providerCode: 'openrouter', modelId: 'google/gemma-4-31b-it:free', requests: 22, failed: 2, tokens: 51200, costUsd: 0 },
    { providerCode: 'openrouter', modelId: 'openai/gpt-5', requests: 14, failed: 3, tokens: 71400, costUsd: 0.7341 }
  ],
  byProvider: [
    { providerCode: 'openrouter', requests: 36, tokens: 122600, costUsd: 0.7341 },
    { providerCode: 'ollama', requests: 10, tokens: 10240, costUsd: 0 }
  ],
  byDay: [
    { day: daysAgo(3).slice(0, 10), requests: 12, failed: 1, tokens: 30110, costUsd: 0.1402 },
    { day: daysAgo(2).slice(0, 10), requests: 19, failed: 3, tokens: 54220, costUsd: 0.3411 },
    { day: daysAgo(1).slice(0, 10), requests: 15, failed: 1, tokens: 48510, costUsd: 0.2528 }
  ],
  errors: [
    { errorCode: 'quota_exceeded', count: 3 },
    { errorCode: 'provider_rate_limited', count: 2 },
    { errorCode: 'upstream_error', count: 1 }
  ],
  topConsumers: [
    { userId: USERS[0].id, requests: 31, tokens: 96400, costUsd: 0.7121 },
    { userId: USERS[1].id, requests: 15, tokens: 36440, costUsd: 0.022 }
  ],
  budget: { configured: true, enforced: true, monthlyUsd: 10, spentMtdUsd: 0.7341, remainingUsd: 9.2659 },
  shared: { enabled: true, message: null }
}

const CREDENTIALS = {
  gateway: { configured: false, role: 'Routes every provider through one credential when set.' },
  storage: {
    kind: 'deployment-secret',
    variable: 'OPENROUTER_API_KEY',
    note: 'Fixture only — the stub holds no real key.'
  },
  providers: [
    {
      code: 'openrouter',
      label: 'OpenRouter',
      kind: 'openai-compatible',
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKeyEnv: 'OPENROUTER_API_KEY',
      active: true,
      configured: true,
      viaGateway: false,
      keyFingerprint: 'stub0001',
      spendLimitUsd: 8,
      docsUrl: 'https://openrouter.ai/docs'
    },
    {
      code: 'ollama',
      label: 'Ollama (local)',
      kind: 'openai-compatible',
      baseUrl: 'http://127.0.0.1:11434/v1',
      apiKeyEnv: 'PROVIDER_API_KEY_OLLAMA',
      active: true,
      configured: false,
      viaGateway: false,
      keyFingerprint: null,
      spendLimitUsd: null,
      docsUrl: 'https://ollama.com/download'
    }
  ]
}

const MODELS = {
  models: [
    {
      id: 'aaaaaaaa-0000-0000-0000-000000000001',
      providerCode: 'openrouter',
      modelId: 'google/gemma-4-31b-it:free',
      label: 'Gemma 4 31B (free)',
      defaultAllowed: true,
      free: true,
      costInputPerMtok: 0,
      costOutputPerMtok: 0,
      priceSource: 'OpenRouter published list price (snapshot)',
      requests30d: 22,
      failed30d: 2,
      lastError: null,
      status: 'verified'
    },
    {
      id: 'aaaaaaaa-0000-0000-0000-000000000002',
      providerCode: 'openrouter',
      modelId: 'openai/gpt-5',
      label: 'GPT-5',
      defaultAllowed: false,
      free: false,
      costInputPerMtok: null,
      costOutputPerMtok: null,
      priceSource: null,
      requests30d: 14,
      failed30d: 3,
      lastError: 'provider_rate_limited',
      status: 'failing'
    },
    {
      id: 'aaaaaaaa-0000-0000-0000-000000000003',
      providerCode: 'openrouter',
      modelId: 'anthropic/claude-sonnet-5',
      label: 'Claude Sonnet 5',
      defaultAllowed: false,
      free: false,
      costInputPerMtok: null,
      costOutputPerMtok: null,
      priceSource: null,
      requests30d: 0,
      failed30d: 0,
      lastError: null,
      status: 'unverified'
    }
  ]
}

const CATALOG = {
  plans: [
    { id: 'plan-free', code: 'free', name: 'Free', interval: 'month', price_cents: 0, active: true, is_trial: false, trial_days: 0 },
    { id: 'plan-pro', code: 'pro', name: 'Pro', interval: 'month', price_cents: 1900, active: true, is_trial: false, trial_days: 0 },
    { id: 'plan-developer', code: 'developer', name: 'Developer', interval: 'month', price_cents: 0, active: true, is_trial: false, trial_days: 0 },
    { id: 'plan-team', code: 'team', name: 'Team', interval: 'month', price_cents: 4900, active: true, is_trial: false, trial_days: 0 }
  ],
  planFeatures: [
    { plan_id: 'plan-free', feature: 'cloud_models', value: true },
    { plan_id: 'plan-free', feature: 'limit.tokens', value: 50000 },
    { plan_id: 'plan-free', feature: 'limit.requests_day', value: 10 },
    { plan_id: 'plan-pro', feature: 'cloud_models', value: true },
    { plan_id: 'plan-pro', feature: 'limit.tokens', value: 2000000 }
  ],
  providers: [],
  models: [],
  modelPlanAccess: [],
  flags: [
    { key: 'gateway', enabled: true, description: 'Route cloud model traffic through the AI gateway', rollout: 100 },
    { key: 'new_ui', enabled: true, description: 'Enable the refreshed workspace UI', rollout: 100 }
  ],
  announcements: [],
  settings: [
    { key: 'maintenance', value: { active: false } },
    { key: 'ai_shared', value: { enabled: true, message: null } },
    { key: 'ai_budget', value: { enabled: true, monthlyUsd: 10 } },
    { key: 'bootstrap_admin_email', value: '' }
  ]
}

const SECURITY = {
  window: { hours: 24, since: daysAgo(1) },
  adminLogins: [
    { id: 1, actorId: USERS[0].id, action: 'auth.password_set', detail: { method: 'password' }, createdAt: daysAgo(2) },
    { id: 2, actorId: USERS[0].id, action: 'admin.grant', detail: { role: 'owner' }, createdAt: daysAgo(40) }
  ],
  failedAttempts: [
    { scope: 'otp', key: 'ghost@example.invalid', attempts: 3, lastAt: daysAgo(1) },
    { scope: 'password', key: 'admin', attempts: 2, lastAt: daysAgo(0) }
  ],
  activeSessions: [
    { id: 's-1', email: USERS[0].email, createdAt: daysAgo(1), lastUsedAt: daysAgo(0), ip: '203.0.113.7' },
    { id: 's-2', email: USERS[1].email, createdAt: daysAgo(2), lastUsedAt: daysAgo(1), ip: '198.51.100.4' }
  ],
  admins: [{ id: USERS[0].id, email: USERS[0].email, status: 'active', roles: ['owner'], lastSignInAt: daysAgo(1) }],
  suspendedAccounts: 1
}

const AUDIT = [
  { id: 9, actorId: USERS[0].id, action: 'setting.set', target: 'ai_budget', detail: { enabled: true, monthlyUsd: 10 }, createdAt: daysAgo(1) },
  { id: 8, actorId: USERS[0].id, action: 'provider.policy', target: 'openrouter', detail: { active: true, spendLimitUsd: 8 }, createdAt: daysAgo(2) },
  { id: 7, actorId: USERS[0].id, action: 'user.set_status', target: USERS[2].id, detail: { status: 'suspended' }, createdAt: daysAgo(3) }
]

const SYSTEM = {
  database: { connected: true, latencyMs: 1.42, serverTime: new Date(NOW).toISOString(), sizeBytes: 41_943_040, migration: '0004_shared_ai.sql' },
  maintenance: { active: false },
  settings: { ai_shared: { enabled: true }, ai_budget: { enabled: true, monthlyUsd: 10 } },
  providers: [
    { code: 'openrouter', label: 'OpenRouter', kind: 'openai-compatible', active: true, apiKeyEnv: 'OPENROUTER_API_KEY', models: 11 }
  ],
  releases: [
    {
      version: '1.0.6',
      channel: 'stable',
      platform: 'win',
      published: true,
      size: 125492796,
      notes: 'Stub release',
      minimumSupportedVersion: '1.0.0',
      releasedAt: daysAgo(3)
    }
  ],
  posts: { sessionsActive: 3 }
}

function adminRoute(path, query, res) {
  if (forbidden) {
    return json(res, 403, fail('forbidden', 'Administrator access is required for that action.'))
  }
  if (unauthorized) {
    return json(res, 401, fail('unauthorized', 'Invalid or expired session.'))
  }
  const blank = empty
  switch (path) {
    case '/admin/metrics':
      return json(res, 200, ok(blank ? { users: { total: 1, active: 1 }, admins: 1, sessions: { active: 0 }, downloads: {}, subscriptions: {}, providers: {}, models: {}, flags: {}, maintenance: { active: false }, serverTime: new Date(NOW).toISOString() } : ADMIN_METRICS))
    case '/admin/ai/usage':
      return json(res, 200, ok(blank ? { window: AI_USAGE.window, totals: { requests: 0, succeeded: 0, failed: 0, cancelled: 0, inFlight: 0, limitRejections: 0, tokens: 0, costUsd: 0 }, byModel: [], byProvider: [], byDay: [], errors: [], topConsumers: [], budget: { configured: false, enforced: false, monthlyUsd: null, spentMtdUsd: 0, remainingUsd: null }, shared: { enabled: true, message: null } } : AI_USAGE))
    case '/admin/users': {
      const q = (query.get('query') || '').toLowerCase()
      const limit = Number(query.get('limit') || 25)
      const offset = Number(query.get('offset') || 0)
      const matched = blank ? [] : USERS.filter((u) => !q || u.email.toLowerCase().includes(q) || String(u.fullName || '').toLowerCase().includes(q))
      return json(res, 200, ok({ total: matched.length, limit, offset, rows: matched.slice(offset, offset + limit) }))
    }
    case '/admin/catalog':
      return json(res, 200, ok(blank ? { plans: CATALOG.plans, planFeatures: [], flags: [], announcements: [], settings: [] } : CATALOG))
    case '/admin/security':
      return json(res, 200, ok(blank ? { window: SECURITY.window, adminLogins: [], failedAttempts: [], activeSessions: [], admins: SECURITY.admins, suspendedAccounts: 0 } : SECURITY))
    case '/admin/audit':
      return json(res, 200, ok(blank ? [] : AUDIT))
    case '/admin/system':
      return json(res, 200, ok(blank ? { database: SYSTEM.database, maintenance: { active: false }, settings: {}, providers: [], releases: [], posts: { sessionsActive: 0 } } : SYSTEM))
    case '/admin/providers/credentials':
      return json(res, 200, ok(blank ? { gateway: { configured: false }, storage: CREDENTIALS.storage, providers: [] } : CREDENTIALS))
    case '/admin/models/availability':
      return json(res, 200, ok(blank ? { models: [] } : MODELS))
    default:
      if (path.startsWith('/admin/users/')) {
        const id = path.split('/')[3]
        const account = USERS.find((u) => u.id === id) || USERS[0]
        return json(res, 200, ok({
          account: {
            id: account.id,
            email: account.email,
            fullName: account.fullName,
            status: account.status,
            createdAt: account.createdAt,
            lastSignInAt: account.lastSignInAt,
            isAdmin: account.isAdmin,
            roles: account.isAdmin ? ['owner'] : [],
            hasPassword: account.hasPassword,
            identityProviders: account.identities
          },
          plan: { code: account.plan, name: account.plan, status: 'active', periodEnd: null },
          overrides: [{ id: 'ov-1', feature: 'limit.tokens', value: 500000, endsAt: null, reason: 'support credit' }],
          usage: [{ resource: 'tokens', used: account.tokensMtd, periodStart: daysAgo(20).slice(0, 10) }],
          devices: account.devices.map((platform) => ({ platform, appVersion: '1.0.6', firstSeenAt: account.createdAt, lastSeenAt: account.lastSignInAt })),
          sessions: [{ id: 's-1', createdAt: daysAgo(1), lastUsedAt: daysAgo(0), expiresAt: daysAgo(-29), revokedAt: null, active: true, userAgent: 'stub', ip: '203.0.113.7' }],
          downloads: [{ version: '1.0.6', platform: 'win', createdAt: daysAgo(2) }],
          activity: [{ id: 1, action: 'subscription.set_plan', actorId: USERS[0].id, detail: { plan: account.plan }, createdAt: daysAgo(4) }]
        }))
      }
      // Any other /admin POST is the stub accepting a change it does not persist.
      if (path.startsWith('/admin/')) return json(res, 200, ok({ stub: true }))
      return json(res, 404, fail('not_found', `No stub admin route for ${path}`))
  }
}

createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  const path = url.pathname
  if (req.method === 'OPTIONS') return json(res, 204, {})

  if (path.startsWith('/admin')) {
    // The real API requires a bearer token on every admin route. The stub does
    // the same, so the page's signed-out path stays exercised.
    const header = req.headers.authorization || ''
    if (unauthorized || !header.toLowerCase().startsWith('bearer ')) {
      return json(res, 401, fail('unauthorized', 'Missing bearer token.'))
    }
    return adminRoute(path, url.searchParams, res)
  }

  if (path === '/auth/providers') {
    return json(res, 200, { ok: true, google: true, github: true, password: true, otp: true })
  }
  // Sign-up answers with the same 202 the real API sends: no session yet, a code
  // in the inbox. The stub stores nothing.
  if (path === '/auth/register' && req.method === 'POST') {
    return json(res, 202, {
      ok: true,
      needsVerification: true,
      delivered: true,
      message: 'Check your inbox for a six-digit code. Enter it here to finish setting up your account.'
    })
  }
  // The stub holds no credentials, so every password sign-in is refused the way
  // the real API refuses a wrong one. Useful as-is: it is the shape a visitor
  // sees after a typo, which is the state the account card has to place well.
  if (path === '/auth/password' && req.method === 'POST') {
    return json(res, 401, {
      ok: false,
      error: { code: 'invalid_password', message: 'That password is not correct.' }
    })
  }
  // A sign-in link was "sent": the same shape the real API returns for a live
  // deployment, which is what reveals the code well and its address line.
  if (path === '/auth/request' && req.method === 'POST') {
    return json(res, 200, {
      ok: true,
      message: 'We sent a sign-in code to that address.',
      expiresInMinutes: 10,
      delivered: true,
      provider: 'stub'
    })
  }
  // No code was ever issued, so a verification is refused exactly as the real
  // API refuses a wrong one. This is the state the code field has to report.
  if (path === '/auth/verify' && req.method === 'POST') {
    return json(res, 400, {
      ok: false,
      error: { code: 'invalid_code', message: 'That code is not correct.' }
    })
  }
  // Password recovery, so the account page's reset well can be exercised locally.
  // The stub keeps no credentials: posting any code and password succeeds.
  if (path === '/auth/password/forgot' && req.method === 'POST') {
    return json(res, 202, {
      ok: true,
      message: 'If that address has an account, a reset code is on its way.'
    })
  }
  if (path === '/auth/password/reset' && req.method === 'POST') {
    return json(res, 200, { ok: true })
  }
  if (path === '/auth/refresh') {
    return json(res, 200, {
      ok: true,
      accessToken: 'stub-access-token',
      refreshToken: 'stub-refresh-token',
      expiresAt: Date.now() + 3_600_000,
      email: 'qa@example.com'
    })
  }
  if (path === '/platform/config') {
    return json(res, 200, MY_CONFIG)
  }
  if (path === '/auth/me' && req.method === 'PATCH') {
    return readBody(req).then((body) => {
      MY_ACCOUNT.fullName = typeof body.fullName === 'string' ? body.fullName : MY_ACCOUNT.fullName
      MY_CONFIG.account.fullName = MY_ACCOUNT.fullName
      json(res, 200, { ok: true, account: MY_ACCOUNT })
    })
  }
  if (path === '/auth/me') {
    return json(res, 200, { ok: true, account: MY_ACCOUNT })
  }
  if (path === '/auth/sessions') {
    return json(res, 200, { ok: true, sessions: MY_SESSIONS.filter((s) => !s.revoked) })
  }
  if (path.startsWith('/auth/sessions/') && req.method === 'DELETE') {
    const id = path.split('/')[3]
    const session = MY_SESSIONS.find((s) => s.id === id)
    if (!session || session.revoked) {
      return json(res, 404, { ok: false, error: { code: 'session_not_found', message: 'That session is already signed out.' } })
    }
    session.revoked = true
    return json(res, 200, { ok: true, revoked: 1, current: session.current })
  }
  if (path === '/auth/sessions/revoke-others' && req.method === 'POST') {
    const others = MY_SESSIONS.filter((s) => !s.current && !s.revoked).length
    for (const session of MY_SESSIONS) if (!session.current) session.revoked = true
    return json(res, 200, { ok: true, revoked: others })
  }
  if (path === '/auth/signout' && req.method === 'POST') {
    return json(res, 200, { ok: true })
  }
  if (path === '/gateway/status') {
    return json(res, 200, { ok: true, ...MY_GATEWAY })
  }
  if (path === '/gateway/activity') {
    return json(res, 200, { ok: true, ...MY_ACTIVITY })
  }
  if (path === '/downloads/latest') {
    if (unauthorized) {
      return json(res, 401, { ok: false, error: { code: 'unauthorized', message: 'Invalid or expired session.' } })
    }
    if (noRelease) {
      return json(res, 404, { ok: false, error: { code: 'no_release', message: 'No desktop release is published yet.' } })
    }
    return json(res, 200, { ok: true, release: RELEASE })
  }
  json(res, 404, { ok: false, error: { code: 'not_found', message: `No stub route for ${path}` } })
}).listen(port, '127.0.0.1', () => {
  console.log(
    `stub platform API on http://127.0.0.1:${port}${noRelease ? ' (no-release)' : ''}${unauthorized ? ' (unauthorized)' : ''}${forbidden ? ' (forbidden)' : ''}${empty ? ' (empty)' : ''}`
  )
})
