import { Hono } from 'hono'
import type { AppEnv } from './types'
import { withContext } from './db'
import { requireAuth } from './middleware'
import { requireLiveSession } from './sessions'

export const platformRoutes = new Hono<AppEnv>()

// Every platform route is per-account data, so none of them are reachable
// without a verified session. This used to be missing: the handlers ran anyway,
// `get_my_platform_config()` raised `not_authenticated` inside a transaction the
// route never checked, and `/config` answered `null` — a signed-out caller could
// not tell "no config" from "not signed in".
platformRoutes.use('*', requireAuth, requireLiveSession)

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
  const userId = c.get('userId') as string
  const platform = typeof body.platform === 'string' && body.platform.trim() ? body.platform.trim() : 'unknown'
  const appVersion =
    typeof body.appVersion === 'string' && body.appVersion.trim() ? body.appVersion.trim() : '0.0.0'
  // The placeholders were missing here, so this statement could never parse and
  // device telemetry quietly never happened.
  await withContext(userId, 'authenticated', async (q) => {
    await q.query('select public.upsert_device($1, $2)', [platform, appVersion])
  })
  return c.json({ ok: true })
})
