import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { allowedOrigins, getEnv } from './env'
import { authRoutes } from './auth'
import { platformRoutes } from './platform'
import { gatewayRoutes } from './gateway'
import { adminRoutes } from './admin'
import { downloadRoutes } from './downloads'

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

app.route('/auth', authRoutes)
app.route('/platform', platformRoutes)
app.route('/gateway', gatewayRoutes)
app.route('/admin', adminRoutes)
app.route('/downloads', downloadRoutes)

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
