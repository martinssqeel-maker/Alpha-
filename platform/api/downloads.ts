import { Hono } from 'hono'
import type { AppEnv } from './types'
import { withContext } from './db'
import { requireAuth } from './middleware'
import { gatingProblem, normalizeRelease } from './releases'
import { maintenanceProblem, maintenanceState } from './maintenance'

function requestIp(c: { req: { header: (n: string) => string | undefined } }): string | null {
  return c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || c.req.header('x-real-ip') || null
}

export const downloadRoutes = new Hono<AppEnv>()

// Every download endpoint requires a session; the account status is then checked
// in the database, so suspending an account takes effect immediately.
downloadRoutes.use('*', requireAuth)

downloadRoutes.get('/latest', async (c) => {
  const result = await withContext(c.get('userId'), 'authenticated', async (q) => {
    const user = (
      await q.query<{ id: string; email: string; status: string }>(
        'select id, email, status from public.users where id = $1',
        [c.get('userId')]
      )
    ).rows[0] ?? null

    const gate = gatingProblem(user)
    if (gate) return { gate, release: null, downloads: 0 }

    if (user) {
      const isAdmin = (
        await q.query<{ is_admin: boolean }>('select public.is_admin($1) as is_admin', [user.id])
      ).rows[0]?.is_admin
      const maintenance = await maintenanceProblem(
        await maintenanceState(),
        Boolean(isAdmin)
      )
      if (maintenance) return { gate: maintenance, release: null, downloads: 0 }
    }

    const latest = (
      await q.query<{ release: Record<string, unknown> | null }>(
        "select public.latest_release('stable', 'win') as release"
      )
    ).rows[0]?.release ?? null

    // A download here means an account was handed the current installer link, so
    // the Downloads page counts something real.
    let downloads = 0
    if (latest) {
      const recorded = await q.query(
        `insert into public.downloads (user_id, release_id, version, platform, ip, user_agent)
         select $1, r.id, r.version, r.platform, $2, $3
           from public.releases r
          where r.channel = 'stable' and r.platform = 'win' and r.published
          order by r.released_at desc limit 1`,
        [c.get('userId'), requestIp(c), c.req.header('user-agent') ?? null]
      )
      downloads = recorded.rowCount ?? 0
    }

    return { gate: null, release: latest, downloads }
  })

  if (result.gate) {
    return c.json(
      { ok: false, error: { code: result.gate.code, message: result.gate.message } },
      result.gate.status as 401
    )
  }

  const release = normalizeRelease(result.release)
  if (!release) {
    return c.json(
      {
        ok: false,
        error: { code: 'no_release', message: 'No desktop release is published yet.' }
      },
      404
    )
  }

  return c.json({ ok: true, release })
})
