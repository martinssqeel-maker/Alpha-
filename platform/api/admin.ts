import { Hono } from 'hono'
import type { AppEnv } from './types'
import { withContext } from './db'
import { requireAuth } from './middleware'

export const adminRoutes = new Hono<AppEnv>()

adminRoutes.use('*', requireAuth)

// Allow-listed admin_* functions and their parameter casts, in order.
// The SECURITY DEFINER functions themselves call public.require_admin(),
// so authorization is enforced in the database as well.
const SIGNATURES: Record<string, string[]> = {
  admin_overview: [],
  admin_list_users: ['text', 'int'],
  admin_set_user_status: ['uuid', 'text'],
  admin_grant_override: ['uuid', 'text', 'jsonb', 'timestamptz', 'text'],
  admin_revoke_override: ['uuid'],
  admin_set_user_plan: ['uuid', 'text', 'text', 'timestamptz'],
  admin_upsert_plan: ['jsonb'],
  admin_set_plan_feature: ['uuid', 'text', 'jsonb'],
  admin_upsert_provider: ['jsonb'],
  admin_upsert_model: ['jsonb'],
  admin_set_model_plan_access: ['uuid', 'uuid', 'boolean'],
  admin_upsert_flag: ['text', 'boolean', 'text', 'int'],
  admin_set_setting: ['text', 'jsonb'],
  admin_upsert_announcement: ['jsonb'],
  admin_audit_log: ['int'],
  admin_list_catalog: []
}

adminRoutes.post('/rpc', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { fn?: string; args?: unknown[] }
  const fn = body.fn ?? ''
  const signature = SIGNATURES[fn]
  if (!signature) {
    return c.json({ ok: false, error: { code: 'unknown_function', message: `Unknown admin function "${fn}".` } }, 400)
  }
  const args = Array.isArray(body.args) ? body.args : []
  if (args.length !== signature.length) {
    return c.json(
      { ok: false, error: { code: 'bad_args', message: `${fn} expects ${signature.length} argument(s).` } },
      400
    )
  }

  const placeholders = signature.map((cast, index) => `$${index + 1}::${cast}`).join(', ')
  try {
    const result = await withContext(c.get('userId'), 'authenticated', async (q) => {
      const res = await q.query<{ result: unknown }>(`select public.${fn}(${placeholders}) as result`, args)
      return res.rows[0]?.result ?? null
    })
    return c.json({ ok: true, result })
  } catch (error) {
    const message = (error as Error).message || 'Admin call failed.'
    const forbidden = /forbidden|not_authorized|permission|require_admin/i.test(message)
    return c.json(
      { ok: false, error: { code: forbidden ? 'forbidden' : 'error', message } },
      forbidden ? 403 : 400
    )
  }
})
