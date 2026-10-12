import { Hono } from 'hono'
import type { AppEnv } from './types'
import { withContext } from './db'
import { requireAuth } from './middleware'
import { gatingProblem, normalizeRelease } from './releases'

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
    if (gate) return { gate, release: null }

    const latest = (
      await q.query<{ release: Record<string, unknown> | null }>(
        "select public.latest_release('stable', 'win') as release"
      )
    ).rows[0]?.release ?? null

    return { gate: null, release: latest }
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
