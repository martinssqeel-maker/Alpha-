import { useCallback, useEffect, useState } from 'react'
import { configured, rpc, supabase } from './supabase'

type Tab = 'overview' | 'users' | 'plans' | 'catalog' | 'flags' | 'announcements' | 'settings' | 'audit'

interface Overview {
  users: number
  admins: number
  activeSubscriptions: number
  plans: number
  models: number
  providers: number
  serverTime: string
}
interface AdminUser {
  id: string
  email: string
  fullName?: string
  status: string
  createdAt: string
  plan?: string | null
  isAdmin: boolean
}
interface Plan {
  id: string
  code: string
  name: string
  description?: string
  interval: string
  price_cents: number
  is_trial: boolean
  active: boolean
}
interface PlanFeature {
  plan_id: string
  feature: string
  value: unknown
}
interface Provider {
  id: string
  code: string
  label: string
  kind: string
  base_url?: string
  api_key_env?: string
  active: boolean
}
interface Model {
  id: string
  provider_id: string
  model_id: string
  label: string
  default_allowed: boolean
  active: boolean
}
interface ModelPlanAccess {
  model_id: string
  plan_id: string
  allowed: boolean
}
interface Flag {
  key: string
  enabled: boolean
  description?: string
  rollout: number
}
interface Announcement {
  id: string
  title: string
  body: string
  level: string
  active: boolean
}
interface Setting {
  key: string
  value: unknown
}
interface Catalog {
  plans: Plan[]
  planFeatures: PlanFeature[]
  providers: Provider[]
  models: Model[]
  modelPlanAccess: ModelPlanAccess[]
  flags: Flag[]
  announcements: Announcement[]
  settings: Setting[]
}
interface AuditEntry {
  id: number
  actor?: string
  action: string
  target?: string
  detail: unknown
  createdAt: string
}

export default function App() {
  const [session, setSession] = useState<Awaited<ReturnType<typeof supabase.auth.getSession>>['data']['session']>(null)
  const [email, setEmail] = useState('')
  const [status, setStatus] = useState('')
  const [tab, setTab] = useState<Tab>('overview')
  const [overview, setOverview] = useState<Overview | null>(null)
  const [users, setUsers] = useState<AdminUser[]>([])
  const [catalog, setCatalog] = useState<Catalog | null>(null)
  const [audit, setAudit] = useState<AuditEntry[]>([])
  const [error, setError] = useState('')

  useEffect(() => {
    void supabase.auth.getSession().then(({ data }) => setSession(data.session))
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s))
    return () => sub.subscription.unsubscribe()
  }, [])

  const reload = useCallback(async () => {
    setError('')
    try {
      const [o, u, c, a] = await Promise.all([
        rpc<Overview>('admin_overview'),
        rpc<AdminUser[]>('admin_list_users', { p_query: '', p_limit: 200 }),
        rpc<Catalog>('admin_list_catalog'),
        rpc<AuditEntry[]>('admin_audit_log', { p_limit: 200 })
      ])
      setOverview(o)
      setUsers(u)
      setCatalog(c)
      setAudit(a)
    } catch (e) {
      setError((e as Error).message)
    }
  }, [])

  useEffect(() => {
    if (session) void reload()
  }, [session, reload])

  async function run(fn: () => Promise<void>) {
    try {
      await fn()
      await reload()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  if (!configured) {
    return (
      <div className="gate">
        <div className="card">
          <h1>Alpha Admin</h1>
          <p className="muted">
            Not configured. Set <code>VITE_SUPABASE_URL</code> and <code>VITE_SUPABASE_ANON_KEY</code> and rebuild.
          </p>
        </div>
      </div>
    )
  }

  if (!session) {
    return (
      <div className="gate">
        <div className="card">
          <h1>Alpha Admin</h1>
          <p className="muted">Sign in with an administrator email.</p>
          <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="admin@example.com" />
          <button
            className="primary"
            onClick={async () => {
              setStatus('Sending link…')
              const { error: err } = await supabase.auth.signInWithOtp({
                email,
                options: { emailRedirectTo: location.origin, shouldCreateUser: false }
              })
              setStatus(err ? err.message : 'Check your email for the sign-in link.')
            }}
          >
            Email me a link
          </button>
          <p className="muted small">{status}</p>
        </div>
      </div>
    )
  }

  const TABS: Tab[] = ['overview', 'users', 'plans', 'catalog', 'flags', 'announcements', 'settings', 'audit']

  return (
    <div className="app">
      <aside className="side">
        <div className="brand">Alpha Admin</div>
        {TABS.map((t) => (
          <button key={t} className={t === tab ? 'nav active' : 'nav'} onClick={() => setTab(t)}>
            {t}
          </button>
        ))}
        <div className="spacer" />
        <div className="muted small">{session.user.email}</div>
        <button className="nav" onClick={() => void supabase.auth.signOut()}>
          Sign out
        </button>
      </aside>

      <main className="main">
        <header className="topbar">
          <h2>{tab}</h2>
          <button onClick={() => void reload()}>Reload</button>
        </header>
        {error && <div className="error">{error}</div>}

        {tab === 'overview' && overview && (
          <div className="stats">
            <Stat label="Users" value={overview.users} />
            <Stat label="Admins" value={overview.admins} />
            <Stat label="Active subs" value={overview.activeSubscriptions} />
            <Stat label="Plans" value={overview.plans} />
            <Stat label="Providers" value={overview.providers} />
            <Stat label="Models" value={overview.models} />
          </div>
        )}

        {tab === 'users' && (
          <table>
            <thead>
              <tr>
                <th>Email</th>
                <th>Plan</th>
                <th>Status</th>
                <th>Admin</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id}>
                  <td>{u.email}</td>
                  <td>{u.plan ?? '—'}</td>
                  <td>{u.status}</td>
                  <td>{u.isAdmin ? 'yes' : ''}</td>
                  <td className="actions">
                    <button
                      onClick={() =>
                        run(async () => {
                          const status = window.prompt('Status (active/suspended/disabled)', u.status)
                          if (!status) return
                          await rpc('admin_set_user_status', { p_user: u.id, p_status: status })
                        })
                      }
                    >
                      Status
                    </button>
                    <button
                      onClick={() =>
                        run(async () => {
                          const code = window.prompt('Plan code (free/pro/team)', u.plan ?? 'pro')
                          if (!code) return
                          await rpc('admin_set_user_plan', { p_user: u.id, p_plan_code: code })
                        })
                      }
                    >
                      Plan
                    </button>
                    <button
                      onClick={() =>
                        run(async () => {
                          const feature = window.prompt('Entitlement feature (e.g. cloud_models or limit.tokens)')
                          if (!feature) return
                          const raw = window.prompt('Value (JSON — e.g. true or 5000000)', 'true')
                          if (raw === null) return
                          await rpc('admin_grant_override', {
                            p_user: u.id,
                            p_feature: feature,
                            p_value: JSON.parse(raw),
                            p_reason: 'admin console'
                          })
                        })
                      }
                    >
                      Grant
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {tab === 'plans' && catalog && (
          <div className="list">
            {catalog.plans.map((p) => (
              <div key={p.id} className="card">
                <div className="row">
                  <strong>
                    {p.name} <span className="muted small">({p.code})</span>
                  </strong>
                  <button
                    onClick={() =>
                      run(async () => {
                        const feature = window.prompt('Feature key (e.g. cloud_models or limit.tokens)')
                        if (!feature) return
                        const raw = window.prompt('JSON value (blank removes)', 'true')
                        await rpc('admin_set_plan_feature', {
                          p_plan: p.id,
                          p_feature: feature,
                          p_value: raw ? JSON.parse(raw) : null
                        })
                      })
                    }
                  >
                    Set feature
                  </button>
                </div>
                <div className="muted small">
                  {catalog.planFeatures
                    .filter((f) => f.plan_id === p.id)
                    .map((f) => `${f.feature}=${JSON.stringify(f.value)}`)
                    .join(' · ') || 'no features'}
                </div>
              </div>
            ))}
          </div>
        )}

        {tab === 'catalog' && catalog && (
          <div className="list">
            <div className="row">
              <strong>Providers</strong>
              <button
                onClick={() =>
                  run(async () => {
                    const code = window.prompt('Provider code')
                    if (!code) return
                    const label = window.prompt('Label', code) ?? code
                    const kind = window.prompt('Kind (openai/anthropic/google/openai-compatible)', 'openai-compatible')
                    const baseUrl = window.prompt('Base URL', 'https://api.example.com/v1')
                    const apiKeyEnv = window.prompt('API key env var name', 'PROVIDER_API_KEY_' + code.toUpperCase())
                    await rpc('admin_upsert_provider', { p: { code, label, kind, baseUrl, apiKeyEnv, active: true } })
                  })
                }
              >
                Add provider
              </button>
            </div>
            {catalog.providers.map((pr) => (
              <div key={pr.id} className="card small">
                <strong>{pr.label}</strong> <span className="muted">{pr.code} · {pr.kind}</span>
                <div className="muted small">{pr.base_url} · key: {pr.api_key_env}</div>
                <div className="muted small">
                  Models:{' '}
                  {catalog.models
                    .filter((m) => m.provider_id === pr.id)
                    .map((m) => m.model_id)
                    .join(', ') || 'none'}
                </div>
                <button
                  onClick={() =>
                    run(async () => {
                      const modelId = window.prompt('Model id (as sent to provider)')
                      if (!modelId) return
                      const label = window.prompt('Label', modelId) ?? modelId
                      const allowed = window.confirm('Allow by default for all plans?')
                      await rpc('admin_upsert_model', {
                        p: { providerId: pr.id, modelId, label, defaultAllowed: allowed, active: true }
                      })
                    })
                  }
                >
                  Add model
                </button>
              </div>
            ))}
          </div>
        )}

        {tab === 'flags' && catalog && (
          <div className="list">
            {catalog.flags.map((f) => (
              <div key={f.key} className="card small row">
                <div>
                  <strong>{f.key}</strong>
                  <div className="muted small">{f.description}</div>
                </div>
                <button
                  onClick={() =>
                    run(() => rpc('admin_upsert_flag', { p_key: f.key, p_enabled: !f.enabled, p_description: f.description }))
                  }
                >
                  {f.enabled ? 'Disable' : 'Enable'}
                </button>
              </div>
            ))}
            <div className="row">
              <button
                onClick={() =>
                  run(async () => {
                    const key = window.prompt('New flag key')
                    if (!key) return
                    await rpc('admin_upsert_flag', { p_key: key, p_enabled: true, p_description: '' })
                  })
                }
              >
                New flag
              </button>
            </div>
          </div>
        )}

        {tab === 'announcements' && catalog && (
          <div className="list">
            <button
              onClick={() =>
                run(async () => {
                  const title = window.prompt('Title')
                  if (!title) return
                  const body = window.prompt('Body', '') ?? ''
                  const level = window.prompt('Level (info/warning/critical)', 'info')
                  await rpc('admin_upsert_announcement', { p: { title, body, level, active: true } })
                })
              }
            >
              New announcement
            </button>
            {catalog.announcements.map((a) => (
              <div key={a.id} className="card small">
                <strong>{a.title}</strong> <span className="muted">[{a.level}]</span>
                <div className="muted small">{a.body}</div>
              </div>
            ))}
          </div>
        )}

        {tab === 'settings' && catalog && (
          <div className="list">
            {catalog.settings.map((s) => (
              <div key={s.key} className="card small row">
                <div>
                  <strong>{s.key}</strong>
                  <div className="muted small mono">{JSON.stringify(s.value)}</div>
                </div>
                <button
                  onClick={() =>
                    run(async () => {
                      const raw = window.prompt(`Value for ${s.key}`, JSON.stringify(s.value))
                      if (raw === null) return
                      await rpc('admin_set_setting', { p_key: s.key, p_value: JSON.parse(raw) })
                    })
                  }
                >
                  Edit
                </button>
              </div>
            ))}
            <button
              onClick={() =>
                run(async () => {
                  const key = window.prompt('Setting key')
                  if (!key) return
                  const raw = window.prompt('JSON value', '{}')
                  if (raw === null) return
                  await rpc('admin_set_setting', { p_key: key, p_value: JSON.parse(raw) })
                })
              }
            >
              New setting
            </button>
          </div>
        )}

        {tab === 'audit' && (
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>Actor</th>
                <th>Action</th>
                <th>Target</th>
                <th>Detail</th>
              </tr>
            </thead>
            <tbody>
              {audit.map((a) => (
                <tr key={a.id}>
                  <td>{new Date(a.createdAt).toLocaleString()}</td>
                  <td className="mono small">{a.actor?.slice(0, 8)}</td>
                  <td>{a.action}</td>
                  <td className="mono small">{a.target?.slice(0, 12)}</td>
                  <td className="mono small">{JSON.stringify(a.detail)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </main>
    </div>
  )
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="stat">
      <div className="stat-value">{value}</div>
      <div className="muted small">{label}</div>
    </div>
  )
}
