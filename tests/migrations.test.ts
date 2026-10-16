import { describe, expect, it, beforeAll } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { PGlite } from '@electric-sql/pglite'

// The migrations are the security boundary of shared AI: quotas, spending caps
// and administrator authorization are all enforced in SQL. Rewriting them by
// inspection is not verification, and running them against the live Neon branch
// is not something a test may do. Instead this suite executes every migration —
// in order, against real PostgreSQL (compiled to WASM) — and then behaves like
// the API does: claim allowances, settle usage, and try to reach admin RPCs as
// an ordinary account.

const migrationsDir = join(__dirname, '..', 'database', 'migrations')
const migrationFiles = readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort()

let db: PGlite

async function asUser<T>(userId: string | null, fn: () => Promise<T>): Promise<T> {
  await db.query('select set_config($1, $2, false)', ['app.user_id', userId ?? ''])
  return fn()
}

async function one<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T> {
  const res = await db.query<T>(sql, params as never[])
  return res.rows[0]
}

/** A fresh account on the free plan, with no sign-in of any kind. */
async function newUser(email: string): Promise<string> {
  const row = await one<{ id: string }>('select public.provision_user($1) as id', [email])
  return row.id
}

async function grantOwner(userId: string): Promise<void> {
  await db.query(
    'insert into public.admin_users (user_id, role_id) select $1, id from public.admin_roles where code = $2',
    [userId, 'owner']
  )
}

async function setSetting(key: string, value: unknown): Promise<void> {
  await db.query('insert into public.system_settings (key, value) values ($1, $2) on conflict (key) do update set value = excluded.value', [
    key,
    JSON.stringify(value)
  ])
}

async function overrideLimit(userId: string, feature: string, value: number): Promise<void> {
  await db.query('insert into public.entitlement_overrides (user_id, feature, value) values ($1, $2, $3)', [
    userId,
    feature,
    JSON.stringify(value)
  ])
}

async function tokenUsed(userId: string): Promise<number> {
  const row = await one<{ used: string }>(
    "select coalesce((select used from public.usage_counters where user_id = $1 and resource = 'tokens' and period_start = date_trunc('month', now())::date), 0) as used",
    [userId]
  )
  return Number(row.used)
}

async function claim(userId: string, reserve: number, model = 'google/gemma-4-31b-it:free') {
  return one<{ claim_ai_request: Record<string, unknown> }>('select public.claim_ai_request($1, $2, $3, $4) as claim_ai_request', [
    userId,
    'openrouter',
    model,
    reserve
  ]).then((r) => r.claim_ai_request)
}

beforeAll(async () => {
  db = new PGlite()
  for (const file of migrationFiles) {
    try {
      await db.exec(readFileSync(join(migrationsDir, file), 'utf8'))
    } catch (error) {
      throw new Error(`migration ${file} failed: ${(error as Error).message}`)
    }
  }
}, 180_000)

describe('migrations', () => {
  it('applies every migration in order against a real PostgreSQL', () => {
    expect(migrationFiles.length).toBeGreaterThanOrEqual(4)
    expect(migrationFiles).toContain('0004_shared_ai.sql')
  })

  it('creates the shared-AI accounting objects', async () => {
    const row = await one<{ tables: number; functions: number }>(
      `select
         (select count(*) from information_schema.tables
           where table_schema = 'public' and table_name = 'ai_requests')::int as tables,
         (select count(*) from information_schema.routines
           where routine_schema = 'public'
             and routine_name in ('claim_ai_request','finish_ai_request','admin_ai_usage',
                                  'admin_users_page','usage_period','ai_budget_state','ai_shared_state'))::int as functions`
    )
    expect(row.tables).toBe(1)
    expect(row.functions).toBe(7)
  })

  it('adds the cost and availability columns the catalog was missing', async () => {
    const row = await one<{ cols: number }>(
      `select count(*)::int as cols from information_schema.columns
        where table_schema = 'public' and table_name = 'ai_models'
          and column_name in ('cost_input_per_mtok','cost_output_per_mtok','price_source','availability_verified_at')`
    )
    expect(row.cols).toBe(4)
  })
})

describe('OpenRouter catalog', () => {
  it('registers the provider against a deployment secret, not the database', async () => {
    const row = await one<{ code: string; base_url: string; api_key_env: string; active: boolean }>(
      "select code, base_url, api_key_env, active from public.ai_providers where code = 'openrouter'"
    )
    expect(row.base_url).toBe('https://openrouter.ai/api/v1')
    expect(row.api_key_env).toBe('OPENROUTER_API_KEY')
    expect(row.active).toBe(true)
  })

  it('marks free variants as free and reachable by default, paid ones as not', async () => {
    const rows = await db.query<{ model_id: string; default_allowed: boolean; cost_input_per_mtok: string | null }>(
      "select m.model_id, m.default_allowed, m.cost_input_per_mtok from public.ai_models m join public.ai_providers p on p.id = m.provider_id where p.code = 'openrouter' order by m.sort"
    )
    const free = rows.rows.filter((r) => r.model_id.endsWith(':free'))
    expect(free.length).toBeGreaterThan(0)
    for (const model of free) {
      expect(model.default_allowed, `${model.model_id} should be usable by default`).toBe(true)
      expect(Number(model.cost_input_per_mtok)).toBe(0)
    }
    const paid = rows.rows.filter((r) => !r.model_id.endsWith(':free'))
    expect(paid.length).toBeGreaterThan(0)
    for (const model of paid) {
      expect(model.default_allowed, `${model.model_id} must not be reachable by omission`).toBe(false)
    }
  })

  it('gives the free plan real but bounded shared access', async () => {
    const rows = await db.query<{ feature: string; value: unknown }>(
      "select pf.feature, pf.value from public.plan_features pf join public.plans p on p.id = pf.plan_id where p.code = 'free'"
    )
    const map = new Map(rows.rows.map((r) => [r.feature, r.value]))
    expect(map.get('cloud_models')).toBe(true)
    expect(Number(map.get('limit.tokens'))).toBe(50_000)
    expect(Number(map.get('limit.requests_day'))).toBe(10)
  })

  it('hides paid models from a free account and shows the free variant', async () => {
    const userId = await newUser('free-gating@example.invalid')
    const config = await asUser(userId, () =>
      one<{ cfg: { models: { modelId: string; providerId: string; allowed: boolean }[] } }>(
        'select public.get_my_platform_config() as cfg'
      )
    )
    const models = config.cfg.models.filter((m) => m.providerId === 'openrouter')
    expect(models.length).toBeGreaterThan(0)
    const freeVariant = models.find((m) => m.modelId.endsWith(':free'))
    const paidVariant = models.find((m) => !m.modelId.endsWith(':free'))
    expect(freeVariant?.allowed).toBe(true)
    expect(paidVariant?.allowed).toBe(false)
  })
})

describe('allowance claims', () => {
  it('refuses a second reservation once the monthly allowance is reached', async () => {
    const userId = await newUser('quota@example.invalid')
    await overrideLimit(userId, 'limit.tokens', 100)

    const first = await claim(userId, 60)
    expect(first.allowed).toBe(true)
    expect(await tokenUsed(userId)).toBe(60)

    const second = await claim(userId, 60)
    expect(second.allowed).toBe(false)
    expect(second.code).toBe('quota_exceeded')
    // The refusal must not have moved the counter.
    expect(await tokenUsed(userId)).toBe(60)
  })

  it('settles the reservation down to the tokens actually billed', async () => {
    const userId = await newUser('settle@example.invalid')
    const claimed = await claim(userId, 500)
    expect(claimed.allowed).toBe(true)
    expect(await tokenUsed(userId)).toBe(500)

    await db.query('select public.finish_ai_request($1, $2, $3, $4, $5)', [
      claimed.requestId as number,
      'ok',
      12,
      8,
      20
    ])
    expect(await tokenUsed(userId)).toBe(20)
  })

  it('returns the whole reservation when a run fails', async () => {
    const userId = await newUser('failure@example.invalid')
    const claimed = await claim(userId, 700)
    await db.query('select public.finish_ai_request($1, $2, null, null, null, null, $3)', [
      claimed.requestId as number,
      'error',
      'upstream_error'
    ])
    expect(await tokenUsed(userId)).toBe(0)
  })

  it('keeps the estimate when the provider reports no usage', async () => {
    const userId = await newUser('nousage@example.invalid')
    const claimed = await claim(userId, 250)
    await db.query('select public.finish_ai_request($1, $2)', [claimed.requestId as number, 'ok'])
    expect(await tokenUsed(userId)).toBe(250)
  })

  it('enforces a daily request cap that the schedule resets', async () => {
    const userId = await newUser('daily@example.invalid')
    await overrideLimit(userId, 'limit.requests_day', 2)

    expect((await claim(userId, 1)).allowed).toBe(true)
    expect((await claim(userId, 1)).allowed).toBe(true)
    const third = await claim(userId, 1)
    expect(third.allowed).toBe(false)
    expect(third.code).toBe('daily_limit_reached')
  })

  it('caps concurrent runs per account', async () => {
    const userId = await newUser('concurrent@example.invalid')
    for (let i = 0; i < 4; i += 1) {
      expect((await claim(userId, 1)).allowed, `claim ${i + 1} should fit within the concurrency cap`).toBe(true)
    }
    const overflow = await claim(userId, 1)
    expect(overflow.allowed).toBe(false)
    expect(overflow.code).toBe('too_many_requests')
  })

  it('refuses a suspended account', async () => {
    const userId = await newUser('suspended@example.invalid')
    await db.query("update public.users set status = 'suspended' where id = $1", [userId])
    const result = await claim(userId, 10)
    expect(result.allowed).toBe(false)
    expect(result.code).toBe('account_suspended')
  })

  it('stops shared inference company-wide when the operator turns it off', async () => {
    await setSetting('ai_shared', { enabled: false, message: 'Paused while we rotate the key.' })
    try {
      const userId = await newUser('sharedoff@example.invalid')
      const result = await claim(userId, 10)
      expect(result.allowed).toBe(false)
      expect(result.code).toBe('shared_disabled')
      expect(String(result.message)).toContain('rotate the key')
    } finally {
      await setSetting('ai_shared', { enabled: true, message: null })
    }
  })

  it('stops shared inference when the monthly budget is spent', async () => {
    const userId = await newUser('budget@example.invalid')
    await setSetting('ai_budget', { enabled: true, monthlyUsd: 5 })
    // $4.99 of the $5 cap already recorded against *this* month.
    await db.query(
      "insert into public.ai_requests (user_id, provider_code, model_id, status, cost_usd, cost_basis, reservation_released, finished_at, created_at) values ($1, 'openrouter', 'openai/gpt-5', 'ok', 4.99, 'provider', true, now(), now())",
      [userId]
    )
    try {
      expect((await claim(userId, 10)).allowed).toBe(true)

      await db.query(
        "insert into public.ai_requests (user_id, provider_code, model_id, status, cost_usd, cost_basis, reservation_released, finished_at, created_at) values ($1, 'openrouter', 'openai/gpt-5', 'ok', 0.02, 'provider', true, now(), now())",
        [userId]
      )
      const blocked = await claim(userId, 10)
      expect(blocked.allowed).toBe(false)
      expect(blocked.code).toBe('budget_exhausted')
    } finally {
      await setSetting('ai_budget', { enabled: false, monthlyUsd: null })
      await db.query('delete from public.ai_requests where user_id = $1', [userId])
    }
  })
})

describe('administrator authorization', () => {
  it('refuses every admin RPC to an ordinary signed-in account', async () => {
    const userId = await newUser('notadmin@example.invalid')
    const calls = [
      'select public.admin_metrics()',
      'select public.admin_list_users()',
      'select public.admin_users_page()',
      'select public.admin_ai_usage(30)',
      'select public.admin_security_overview(24)',
      'select public.admin_system_status()',
      'select public.admin_list_catalog()',
      'select public.admin_audit_log(10)'
    ]
    for (const sql of calls) {
      await asUser(userId, async () => {
        await expect(db.query(sql), `${sql} must be refused`).rejects.toThrow(/forbidden/i)
      })
    }
  })

  it('refuses admin RPCs when nobody is signed in at all', async () => {
    await asUser(null, async () => {
      await expect(db.query('select public.admin_metrics()')).rejects.toThrow(/not_authenticated/i)
    })
  })

  it('serves metrics, paginated users and AI usage to an owner', async () => {
    const owner = await newUser('owner@example.invalid')
    await grantOwner(owner)
    await asUser(owner, async () => {
      const metrics = await one<{ m: { users: { total: number } } }>('select public.admin_metrics() as m')
      expect(metrics.m.users.total).toBeGreaterThan(0)

      const page = await one<{ p: { total: number; limit: number; offset: number; rows: unknown[] } }>(
        'select public.admin_users_page(null, 2, 0) as p'
      )
      expect(page.p.limit).toBe(2)
      expect(page.p.rows.length).toBeLessThanOrEqual(2)
      expect(page.p.total).toBeGreaterThanOrEqual(page.p.rows.length)

      const usage = await one<{ u: { totals: { requests: number }; byDay: unknown[]; budget: unknown } }>(
        'select public.admin_ai_usage(30) as u'
      )
      expect(typeof usage.u.totals.requests).toBe('number')
      expect(Array.isArray(usage.u.byDay)).toBe(true)
      expect(usage.u.budget).toBeTruthy()
    })
  })

  it('does not let an administrator edit a profile request into admin rights', async () => {
    const userId = await newUser('climber@example.invalid')
    // There is no "set my own role" surface: the only path is admin_set_user_admin,
    // which itself requires users.write.
    await asUser(userId, async () => {
      await expect(
        db.query('select public.admin_set_user_admin($1, true)', [userId])
      ).rejects.toThrow(/forbidden/i)
    })
    const row = await one<{ is_admin: boolean }>('select public.is_admin($1) as is_admin', [userId])
    expect(row.is_admin).toBe(false)
  })

  it('refuses to let the last owner demote themselves', async () => {
    const owner = await newUser('lastowner@example.invalid')
    await grantOwner(owner)
    await asUser(owner, async () => {
      await expect(
        db.query('select public.admin_set_user_admin($1, false)', [owner])
      ).rejects.toThrow(/cannot_remove_own_admin/i)
    })
  })
})

describe('provider policy', () => {
  it('is a protected control, not a settings row anyone can write', async () => {
    const userId = await newUser('policy-climber@example.invalid')
    await asUser(userId, async () => {
      await expect(
        db.query("select public.admin_set_provider_policy('openrouter', false, null, null)")
      ).rejects.toThrow(/forbidden/i)
    })
    const row = await one<{ active: boolean }>("select active from public.ai_providers where code = 'openrouter'")
    expect(row.active).toBe(true)
  })

  it('lets an owner disable a provider and cap its monthly spend', async () => {
    const owner = await newUser('policy-owner@example.invalid')
    await grantOwner(owner)
    const policy = await asUser(owner, async () =>
      one<{ r: { active: boolean; spendLimitUsd: string | null } }>(
        "select public.admin_set_provider_policy('openrouter', null, 12.5, null) as r"
      )
    )
    expect(Number(policy.r.spendLimitUsd)).toBe(12.5)

    // The cap is enforced, not merely stored: a spent provider is refused even
    // while the account still has allowance left.
    const userId = await newUser('providercap@example.invalid')
    await db.query(
      "insert into public.ai_requests (user_id, provider_code, model_id, status, cost_usd, cost_basis, reservation_released, finished_at) values ($1, 'openrouter', 'openai/gpt-5', 'ok', 12.6, 'provider', true, now())",
      [userId]
    )
    try {
      const blocked = await claim(userId, 10)
      expect(blocked.allowed).toBe(false)
      expect(blocked.code).toBe('provider_budget_exhausted')
    } finally {
      await db.query("delete from public.ai_requests where user_id = $1", [userId])
      await asUser(owner, async () => {
        await db.query("select public.admin_set_provider_policy('openrouter', true, 0, null)")
      })
    }
  })
})

describe('brand-new account', () => {
  it('starts on the free plan with nothing to migrate', async () => {
    const userId = await newUser('brandnew@example.invalid')
    const row = await one<{ code: string; status: string }>(
      'select p.code, s.status from public.subscriptions s join public.plans p on p.id = s.plan_id where s.user_id = $1',
      [userId]
    )
    expect(row.code).toBe('free')
    expect(row.status).toBe('active')
    expect(await tokenUsed(userId)).toBe(0)
  })
})
