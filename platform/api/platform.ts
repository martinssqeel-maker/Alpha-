import { Hono } from 'hono'
import type { AppEnv } from './types'
import { withContext } from './db'

export const platformRoutes = new Hono<AppEnv>()

/** Load the authoritative platform config for a user (same shape as the desktop app). */
export async function loadPlatformConfig(userId?: string): Promise<Record<string, unknown> | null> {
  try {
    if (!userId) return null
    return await withContext(userId, 'authenticated', async (q) => {
      const res = await q.query<{ cfg: Record<string, unknown> | null }>(
        'select public.get_my_platform_config() as cfg'
      )
      return res.rows[0]?.cfg ?? null
    })
  } catch {
    return null
  }
}

platformRoutes.get('/config', async (c) => {
  const cfg = await loadPlatformConfig(c.get('userId') as string | undefined)
  return c.json(cfg)
})

platformRoutes.post('/device', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { platform?: string; appVersion?: string }
  const userId = c.get('userId') as string | undefined
  if (userId) {
    await withContext(userId, 'authenticated', async (q) => {
      await q.query('select public.upsert_device(, )', [body.platform ?? 'unknown', body.appVersion ?? '0.0.0'])
    })
  }
  return c.json({ ok: true })
})
