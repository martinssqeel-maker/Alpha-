import { Hono } from 'hono'
import type { AppEnv } from './types'
import { withContext } from './db'
import { buildAdminCall } from './adminSignatures'
import { requireAuth } from './middleware'

export const adminRoutes = new Hono<AppEnv>()

adminRoutes.use('*', requireAuth)

// The allow-list of callable functions, their parameter names and casts lives in
// ./adminSignatures. The SECURITY DEFINER functions themselves call
// public.require_admin(), so authorization is enforced in the database as well.
adminRoutes.post('/rpc', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    fn?: string
    params?: Record<string, unknown>
    args?: unknown[]
  }

  const call = buildAdminCall(body.fn ?? '', { params: body.params, args: body.args })
  if (!call.ok) {
    return c.json({ ok: false, error: { code: call.code, message: call.message } }, 400)
  }

  try {
    const result = await withContext(c.get('userId'), 'authenticated', async (q) => {
      const res = await q.query<{ result: unknown }>(call.sql, call.values)
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
