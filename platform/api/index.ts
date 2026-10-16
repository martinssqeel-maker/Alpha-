import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { allowedOrigins, getEnv } from './env'
import { authRoutes } from './auth'
import { platformRoutes } from './platform'
import { gatewayRoutes } from './gateway'
import { downloadRoutes } from './downloads'
import { adminRoutes } from './admin'

const app = new Hono()

app.use('*', cors({
  origin: (origin) => {
    const allowed = allowedOrigins()
    if (allowed === '*') return origin || '*'
    return allowed.includes(origin) ? origin : (allowed[0] ?? null)
  },
  allowHeaders: ['Authorization', 'Content-Type'],
  allowMethods: ['GET', 'POST', 'OPTIONS'],
  exposeHeaders: ['Content-Type'],
  maxAge: 86400
}))

app.get('/', (c) =>
  c.json({ ok: true, service: 'alpha-platform-api', branch: getEnv('NEON_BRANCH') ?? null })
)

app.get('/health', (c) =>
  c.json({
    ok: true,
    service: 'alpha-platform-api',
    branch: getEnv('NEON_BRANCH') ?? null,
    serverTime: new Date().toISOString()
  })
)

// Every mount below except /auth carries `requireAuth` internally, so a route
// added to one of those routers is authenticated by default rather than by
// remembering to say so.
app.route('/auth', authRoutes)
app.route('/platform', platformRoutes)
app.route('/gateway', gatewayRoutes)
app.route('/downloads', downloadRoutes)
// Authorization for everything under /admin is enforced by the admin_* RPCs
// themselves (public.require_admin), not by this mount.
app.route('/admin', adminRoutes)

app.notFound((c) => c.json({ ok: false, error: { code: 'not_found', message: 'Not found.' } }, 404))

app.onError((error, c) => {
  console.error('[api:error]', error)
  const message = error instanceof Error ? error.message : 'Internal error.'
  const notAuthenticated = /not_authenticated/i.test(message)
  return c.json(
    {
      ok: false,
      error: {
        code: notAuthenticated ? 'unauthorized' : 'internal',
        message: notAuthenticated ? 'Not signed in.' : 'Internal server error.'
      }
    },
    notAuthenticated ? 401 : 500
  )
})

export default app
