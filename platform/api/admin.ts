import { Hono } from 'hono'
import type { Context } from 'hono'
import type { AppEnv } from './types'
import { withContext, type Queryable } from './db'
import { getEnv } from './env'
import { requireAuth } from './middleware'
import { credentialSummary } from './aiGuard'

/**
 * Company administration API.
 *
 * Authorization is *not* decided here. Every handler below calls an
 * `admin_*` RPC, and each of those begins with `public.require_admin(permission)`,
 * which resolves the caller from the transaction-scoped `app.user_id` and raises
 * `forbidden` unless that account holds a role granting the permission. Adding,
 * removing or renaming a permission is therefore a database change, and no route
 * can be reached by editing a request body — there is nothing in this file for an
 * attacker to escalate through.
 *
 * The middleware only establishes *who* is calling; the database decides whether
 * that identity may do the thing.
 */
export const adminRoutes = new Hono<AppEnv>()

adminRoutes.use('*', requireAuth)

interface PgError {
  code?: string
  message?: string
}

/** Business errors the UI should show verbatim, with the status they deserve. */
const KNOWN_ERRORS: Record<string, { status: number; message?: string }> = {
  user_not_found: { status: 404, message: 'That account no longer exists.' },
  provider_not_found: { status: 404, message: 'That provider is not registered.' },
  plan_not_found: { status: 400, message: 'That plan code does not exist.' },
  unknown_role: { status: 400, message: 'That administrator role does not exist.' },
  invalid_status: { status: 400, message: 'Status must be active, suspended or disabled.' },
  invalid_request: { status: 400, message: 'The request was not understood.' },
  cannot_remove_own_admin: {
    status: 409,
    message: 'You cannot remove your own administrator access. Ask another owner to do it.'
  },
  cannot_remove_last_owner: {
    status: 409,
    message: 'That is the last owner. Promote another owner first, so the product keeps an administrator.'
  },
  already_admin: { status: 409, message: 'That account is already an administrator.' },
  version_required: { status: 400, message: 'A release needs a version.' },
  installer_url_required: { status: 400, message: 'A release needs an https installer URL.' }
}

export interface AdminFailure {
  status: number
  body: { ok: false; error: { code: string; message: string } }
}

/**
 * Translate a database refusal into the response the portal should render.
 *
 * Order matters and is asserted by `tests/adminErrorMap.test.ts`. Business
 * refusals raised with SQLSTATE 42501 — "you cannot remove your own admin
 * rights", "that is the last owner" — are matched *before* the generic 42501
 * branch, so the operator sees the real reason instead of "administrator access
 * is required". The generic `forbidden` from `require_admin` matches none of the
 * specific keys and still lands on 403.
 */
export function describeAdminError(error: unknown): AdminFailure {
  const pg = error as PgError
  const message = pg?.message ?? ''
  const code = pg?.code ?? ''

  if (/not_authenticated/i.test(message)) {
    return { status: 401, body: { ok: false, error: { code: 'unauthorized', message: 'Not signed in.' } } }
  }
  for (const [key, mapped] of Object.entries(KNOWN_ERRORS)) {
    if (message.includes(key)) {
      return {
        status: mapped.status,
        body: { ok: false, error: { code: key, message: mapped.message ?? message } }
      }
    }
  }
  if (code === '42501' || /forbidden/i.test(message)) {
    return {
      status: 403,
      body: {
        ok: false,
        error: { code: 'forbidden', message: 'Administrator access is required for that action.' }
      }
    }
  }
  if (code === 'P0002') {
    return {
      status: 404,
      body: { ok: false, error: { code: 'not_found', message: 'That record no longer exists.' } }
    }
  }
  if (code === '22P02' || code === '22023' || code === '23503' || code === '23505' || code === '23514') {
    return {
      status: 400,
      body: {
        ok: false,
        error: { code: 'invalid_input', message: 'One of the supplied values was not accepted.' }
      }
    }
  }

  // The real error goes to the operator's logs; the client gets something safe.
  console.error('[admin:error]', error)
  return {
    status: 500,
    body: { ok: false, error: { code: 'internal', message: 'The change could not be completed.' } }
  }
}

function failure(c: Context<AppEnv>, error: unknown): Response {
  const { status, body } = describeAdminError(error)
  return c.json(body, status as 400)
}

/** Run `fn` as the caller and shape any database refusal into a response. */
async function asAdmin(
  c: Context<AppEnv>,
  fn: (q: Queryable) => Promise<unknown>,
  shape: (value: unknown) => unknown = (value) => value
): Promise<Response> {
  const userId = c.get('userId')
  try {
    const result = await withContext(userId, 'authenticated', fn)
    return c.json({ ok: true, data: shape(result) })
  } catch (error) {
    return failure(c, error)
  }
}

async function scalar<T>(q: Queryable, sql: string, params: unknown[] = []): Promise<T | null> {
  const res = await q.query<Record<string, T>>(sql, params as never[])
  const row = res.rows[0]
  if (!row) return null
  const key = Object.keys(row)[0]
  return row[key] ?? null
}

function jsonParam(value: unknown): string {
  return JSON.stringify(value ?? {})
}

function intParam(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(value ?? '', 10)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(Math.max(parsed, min), max)
}

function str(value: unknown, max = 200): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null
  return trimmed.slice(0, max)
}

// ── overview, health, security ─────────────────────────────────────────────

adminRoutes.get('/metrics', (c) => asAdmin(c, (q) => scalar(q, 'select public.admin_metrics() as r')))
adminRoutes.get('/overview', (c) => asAdmin(c, (q) => scalar(q, 'select public.admin_overview() as r')))
adminRoutes.get('/system', (c) => asAdmin(c, (q) => scalar(q, 'select public.admin_system_status() as r')))
adminRoutes.get('/catalog', (c) => asAdmin(c, (q) => scalar(q, 'select public.admin_list_catalog() as r')))

adminRoutes.get('/security', (c) =>
  asAdmin(c, (q) => scalar(q, 'select public.admin_security_overview($1) as r', [intParam(c.req.query('hours'), 24, 1, 720)]))
)

adminRoutes.get('/audit', (c) =>
  asAdmin(c, (q) => scalar(q, 'select public.admin_audit_log($1) as r', [intParam(c.req.query('limit'), 200, 1, 500)]))
)

adminRoutes.get('/downloads', (c) =>
  asAdmin(c, (q) => scalar(q, 'select public.admin_list_downloads($1) as r', [intParam(c.req.query('limit'), 200, 1, 1000)]))
)

adminRoutes.get('/ai/usage', (c) =>
  asAdmin(c, (q) => scalar(q, 'select public.admin_ai_usage($1) as r', [intParam(c.req.query('days'), 30, 1, 365)]))
)

// ── users ──────────────────────────────────────────────────────────────────

adminRoutes.get('/users', (c) =>
  asAdmin(c, (q) =>
    scalar(q, 'select public.admin_users_page($1, $2, $3) as r', [
      str(c.req.query('query'), 120),
      intParam(c.req.query('limit'), 25, 1, 200),
      intParam(c.req.query('offset'), 0, 0, 1_000_000)
    ])
  )
)

adminRoutes.get('/users/:id', (c) =>
  asAdmin(c, (q) => scalar(q, 'select public.admin_get_user($1::uuid) as r', [c.req.param('id')]))
)

adminRoutes.post('/users/:id/status', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { status?: string }
  const status = str(body.status, 20)
  if (!status) return c.json({ ok: false, error: { code: 'invalid_request', message: 'A status is required.' } }, 400)
  return asAdmin(c, async (q) => {
    await q.query('select public.admin_set_user_status($1::uuid, $2)', [c.req.param('id'), status])
    return { status }
  })
})

adminRoutes.post('/users/:id/plan', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { planCode?: string; periodEnd?: string | null }
  const planCode = str(body.planCode, 40)
  if (!planCode) return c.json({ ok: false, error: { code: 'invalid_request', message: 'A plan code is required.' } }, 400)
  const periodEnd = str(body.periodEnd, 40)
  return asAdmin(c, async (q) => {
    await q.query('select public.admin_set_user_plan($1::uuid, $2, $3, $4::timestamptz)', [
      c.req.param('id'),
      planCode,
      'month',
      periodEnd
    ])
    return { planCode }
  })
})

adminRoutes.post('/users/:id/admin', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { admin?: boolean; roleCode?: string }
  if (typeof body.admin !== 'boolean') {
    return c.json({ ok: false, error: { code: 'invalid_request', message: 'Say whether to grant or revoke.' } }, 400)
  }
  return asAdmin(c, (q) =>
    scalar(q, 'select public.admin_set_user_admin($1::uuid, $2, $3) as r', [
      c.req.param('id'),
      body.admin,
      str(body.roleCode, 40) ?? 'admin'
    ])
  )
})

adminRoutes.post('/users/:id/overrides', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    feature?: string
    value?: unknown
    endsAt?: string | null
    reason?: string | null
  }
  const feature = str(body.feature, 80)
  if (!feature) return c.json({ ok: false, error: { code: 'invalid_request', message: 'A feature is required.' } }, 400)
  if (body.value === undefined) {
    return c.json({ ok: false, error: { code: 'invalid_request', message: 'A value is required.' } }, 400)
  }
  return asAdmin(c, async (q) => {
    await q.query('select public.admin_grant_override($1::uuid, $2, $3::jsonb, $4::timestamptz, $5)', [
      c.req.param('id'),
      feature,
      jsonParam(body.value),
      str(body.endsAt, 40),
      str(body.reason, 300)
    ])
    return { feature }
  })
})

adminRoutes.post('/overrides/:id/revoke', (c) =>
  asAdmin(c, async (q) => {
    await q.query('select public.admin_revoke_override($1::uuid)', [c.req.param('id')])
    return { revoked: true }
  })
)

// ── sessions ───────────────────────────────────────────────────────────────

adminRoutes.get('/sessions', (c) => {
  const userId = str(c.req.query('userId'), 40)
  return asAdmin(c, (q) =>
    scalar(q, 'select public.admin_list_sessions($1::uuid, $2) as r', [
      userId,
      intParam(c.req.query('limit'), 100, 1, 500)
    ])
  )
})

adminRoutes.post('/sessions/:id/revoke', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { reason?: string }
  return asAdmin(c, (q) =>
    scalar(q, 'select public.admin_revoke_session($1::uuid, $2) as r', [
      c.req.param('id'),
      str(body.reason, 300)
    ])
  )
})

adminRoutes.post('/users/:id/sessions/revoke', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { reason?: string }
  return asAdmin(c, async (q) => {
    const count = await scalar<number>(q, 'select public.admin_revoke_user_sessions($1::uuid, $2) as r', [
      c.req.param('id'),
      str(body.reason, 300)
    ])
    return { revoked: count ?? 0 }
  })
})

// ── releases ───────────────────────────────────────────────────────────────

adminRoutes.get('/releases', (c) => asAdmin(c, (q) => scalar(q, 'select public.admin_list_releases() as r')))

adminRoutes.post('/releases', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
  return asAdmin(c, (q) => scalar(q, 'select public.admin_upsert_release($1::jsonb) as r', [jsonParam(body)]))
})

// ── catalog writes ─────────────────────────────────────────────────────────

adminRoutes.post('/providers', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
  return asAdmin(c, (q) => scalar(q, 'select public.admin_upsert_provider($1::jsonb) as r', [jsonParam(body)]))
})

adminRoutes.post('/providers/policy', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    code?: string
    active?: boolean | null
    spendLimitUsd?: number | null
    docsUrl?: string | null
  }
  const code = str(body.code, 40)
  if (!code) return c.json({ ok: false, error: { code: 'invalid_request', message: 'A provider code is required.' } }, 400)
  const spend =
    typeof body.spendLimitUsd === 'number' && Number.isFinite(body.spendLimitUsd) && body.spendLimitUsd >= 0
      ? body.spendLimitUsd
      : null
  return asAdmin(c, (q) =>
    scalar(q, 'select public.admin_set_provider_policy($1, $2, $3, $4) as r', [
      code,
      typeof body.active === 'boolean' ? body.active : null,
      spend,
      str(body.docsUrl, 300)
    ])
  )
})

adminRoutes.post('/models', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
  return asAdmin(c, (q) => scalar(q, 'select public.admin_upsert_model($1::jsonb) as r', [jsonParam(body)]))
})

adminRoutes.post('/models/:id/plans', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { planId?: string; allowed?: boolean }
  const planId = str(body.planId, 40)
  if (!planId || typeof body.allowed !== 'boolean') {
    return c.json({ ok: false, error: { code: 'invalid_request', message: 'A plan and an allowed flag are required.' } }, 400)
  }
  return asAdmin(c, async (q) => {
    await q.query('select public.admin_set_model_plan_access($1::uuid, $2::uuid, $3)', [
      c.req.param('id'),
      planId,
      body.allowed
    ])
    return { allowed: body.allowed }
  })
})

adminRoutes.post('/plans', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
  return asAdmin(c, (q) => scalar(q, 'select public.admin_upsert_plan($1::jsonb) as r', [jsonParam(body)]))
})

adminRoutes.post('/plans/:id/features', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { feature?: string; value?: unknown }
  const feature = str(body.feature, 80)
  if (!feature) return c.json({ ok: false, error: { code: 'invalid_request', message: 'A feature is required.' } }, 400)
  return asAdmin(c, async (q) => {
    await q.query('select public.admin_set_plan_feature($1::uuid, $2, $3::jsonb)', [
      c.req.param('id'),
      feature,
      body.value === null || body.value === undefined ? null : jsonParam(body.value)
    ])
    return { feature }
  })
})

adminRoutes.post('/flags', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    key?: string
    enabled?: boolean
    description?: string | null
    rollout?: number
  }
  const key = str(body.key, 80)
  if (!key || typeof body.enabled !== 'boolean') {
    return c.json({ ok: false, error: { code: 'invalid_request', message: 'A key and an enabled flag are required.' } }, 400)
  }
  return asAdmin(c, async (q) => {
    await q.query('select public.admin_upsert_flag($1, $2, $3, $4)', [
      key,
      body.enabled,
      str(body.description, 300),
      intParam(String(body.rollout ?? ''), 100, 0, 100)
    ])
    return { key, enabled: body.enabled }
  })
})

adminRoutes.post('/settings', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { key?: string; value?: unknown }
  const key = str(body.key, 80)
  if (!key) return c.json({ ok: false, error: { code: 'invalid_request', message: 'A setting key is required.' } }, 400)
  if (body.value === undefined) {
    return c.json({ ok: false, error: { code: 'invalid_request', message: 'A value is required.' } }, 400)
  }
  return asAdmin(c, async (q) => {
    await q.query('select public.admin_set_setting($1, $2::jsonb)', [key, jsonParam(body.value)])
    return { key }
  })
})

adminRoutes.post('/announcements', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
  return asAdmin(c, (q) => scalar(q, 'select public.admin_upsert_announcement($1::jsonb) as r', [jsonParam(body)]))
})

// ── provider credentials ───────────────────────────────────────────────────

/**
 * The state of every provider's credential, without the credential.
 *
 * Alpha's provider keys live in the Function's own environment, pushed by
 * `npm run deploy` from `.env.local`. That is deliberate: a database-held key
 * would need a second secret to encrypt it with, and that secret would itself
 * have to live somewhere. Instead this reports *whether* a key is present and a
 * short hash of it, so rotating a key is visibly confirmed without any part of it
 * ever being sent to a browser.
 */
adminRoutes.get('/providers/credentials', (c) =>
  asAdmin(c, async (q) => {
    const res = await q.query<{
      code: string
      label: string
      kind: string
      base_url: string | null
      api_key_env: string | null
      active: boolean
      spend_limit_usd: string | null
      docs_url: string | null
    }>('select code, label, kind, base_url, api_key_env, active, spend_limit_usd, docs_url from public.ai_providers order by sort, code')

    const gatewayConfigured = Boolean(getEnv('NEON_AI_GATEWAY_BASE_URL') && getEnv('NEON_AI_GATEWAY_TOKEN'))

    return {
      gateway: {
        configured: gatewayConfigured,
        role: 'Routes every provider through one credential when set.'
      },
      storage: {
        kind: 'deployment-secret',
        variable: 'OPENROUTER_API_KEY',
        note:
          'Provider keys are Function environment variables. Put the value in .env.local (never committed) and run `npm run deploy`. The key is then read server-side only and is never returned by this API.'
      },
      // credentialSummary is the only place a secret is read for this view, and
      // the object it returns has no field that can hold one.
      providers: res.rows.map((row) =>
        credentialSummary(row, getEnv(row.api_key_env || `PROVIDER_API_KEY_${row.code.toUpperCase()}`) ?? null, gatewayConfigured)
      )
    }
  })
)

/**
 * Model availability, with an explicit `verified` flag rather than a promise.
 * A model is only presented as usable once a real request has succeeded against
 * it; until then it says so.
 */
adminRoutes.get('/models/availability', (c) =>
  asAdmin(c, async (q) => {
    const res = await q.query<{
      id: string
      provider_code: string
      model_id: string
      label: string
      default_allowed: boolean
      active: boolean
      cost_input_per_mtok: string | null
      cost_output_per_mtok: string | null
      price_source: string | null
      availability_verified_at: string | null
      requests_30d: string
      failed_30d: string
      last_error: string | null
    }>(`
      select m.id, p.code as provider_code, m.model_id, m.label, m.default_allowed, m.active,
             m.cost_input_per_mtok, m.cost_output_per_mtok, m.price_source, m.availability_verified_at,
             coalesce(r.requests, 0)::text as requests_30d,
             coalesce(r.failed, 0)::text as failed_30d,
             r.last_error
        from public.ai_models m
        join public.ai_providers p on p.id = m.provider_id
        left join (
          select model_id, count(*) as requests,
                 count(*) filter (where status <> 'ok') as failed,
                 (array_agg(error_code order by created_at desc) filter (where error_code is not null))[1] as last_error
            from public.ai_requests
           where created_at > now() - interval '30 days'
           group by model_id
        ) r on r.model_id = m.model_id
       where m.active
       order by p.sort, m.sort`)

    return {
      models: res.rows.map((row) => ({
        id: row.id,
        providerCode: row.provider_code,
        modelId: row.model_id,
        label: row.label,
        defaultAllowed: row.default_allowed,
        free:
          row.model_id.endsWith(':free') ||
          (row.cost_input_per_mtok !== null &&
            row.cost_output_per_mtok !== null &&
            Number(row.cost_input_per_mtok) === 0 &&
            Number(row.cost_output_per_mtok) === 0),
        costInputPerMtok: row.cost_input_per_mtok === null ? null : Number(row.cost_input_per_mtok),
        costOutputPerMtok: row.cost_output_per_mtok === null ? null : Number(row.cost_output_per_mtok),
        priceSource: row.price_source,
        requests30d: Number(row.requests_30d),
        failed30d: Number(row.failed_30d),
        lastError: row.last_error,
        // Truthful status: "verified" means a request has actually completed,
        // not that somebody typed the id into the catalog.
        status:
          row.availability_verified_at !== null || Number(row.requests_30d) > 0
            ? (Number(row.failed_30d) > 0 && Number(row.requests_30d) === Number(row.failed_30d) ? 'failing' : 'verified')
            : 'unverified'
      }))
    }
  })
)
