import { Hono } from 'hono'
import type { AppEnv } from './types'
import { withContext } from './db'
import { requireAuth } from './middleware'

export const platformRoutes = new Hono<AppEnv>()

platformRoutes.use('*', requireAuth)

/** Load the authoritative platform config for a user (same shape as the desktop app). */
export async function loadPlatformConfig(userId: string): Promise<Record<string, unknown> | null> {
  return withContext(userId, 'authenticated', async (q) => {
    const res = await q.query<{ cfg: Record<string, unknown> | null }>(
      'select public.get_my_platform_config() as cfg'
    )
    return res.rows[0]?.cfg ?? null
  })
}

platformRoutes.get('/config', async (c) => {
  const cfg = await loadPlatformConfig(c.get('userId'))
  return c.json(cfg)
})

platformRoutes.post('/device', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { platform?: string; appVersion?: string }
  await withContext(c.get('userId'), 'authenticated', async (q) => {
    await q.query('select public.upsert_device($1, $2)', [body.platform ?? 'unknown', body.appVersion ?? '0.0.0'])
  })
  return c.json({ ok: true })
})
