import fs from 'node:fs'
import path from 'node:path'
import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'

// `scripts/verify-admin.mjs` drives the real admin controls against a live
// deployment. It once kept calling `POST /admin/rpc` after that endpoint was
// replaced by REST routes, so fifteen checks failed for a reason that had
// nothing to do with the deployment. This test is the early warning: any route
// the script names must exist on the router and must refuse an anonymous caller.
process.env.AUTH_JWT_SECRET = 'test-only-secret-please-never-deploy-this-value'
process.env.AUTH_ACCESS_TTL_MIN = '60'

const SCRIPT_PATHS = ['scripts/verify-admin.mjs', 'scripts/verify-auth.mjs']
const SCRIPTS = SCRIPT_PATHS.map((relative) => ({
  relative,
  source: fs.readFileSync(path.join(process.cwd(), relative), 'utf8')
}))
const SCRIPT = SCRIPTS[0].source

/** `metrics: ['GET', '/admin/metrics'],` → { method: 'GET', path: '/admin/metrics' } */
function routesInScript(): Array<{ method: string; path: string }> {
  const found: Array<{ method: string; path: string }> = []
  for (const { source } of SCRIPTS) {
    for (const match of source.matchAll(/\[\s*'(GET|POST)',\s*'(\/admin\/[^']+)'\s*\]/g)) {
      found.push({ method: match[1], path: match[2] })
    }
  }
  return found
}

/** `:id` on either side becomes a concrete segment, so comparisons are about shape. */
function concrete(pathname: string): string {
  return pathname.replace(/:id\b/g, '00000000-0000-0000-0000-000000000000')
}

// Imported once, at collection time: importing the admin router inside the tests
// charged whichever test ran first for compiling the whole API module graph, which
// takes seconds under parallel load and used to time out a passing test.
const { adminRoutes } = await import('../platform/api/admin')

function adminApp() {
  const app = new Hono()
  app.route('/admin', adminRoutes)
  return app
}

describe('verify:admin drives routes the admin API really serves', () => {
  it('names routes in both scripts, so the extraction cannot pass vacuously', () => {
    const routes = routesInScript()
    expect(routes.length).toBeGreaterThanOrEqual(12)
    expect(routes.every((route) => route.path.startsWith('/admin/'))).toBe(true)
    for (const { relative, source } of SCRIPTS) {
      expect(source.match(/\[\s*'(?:GET|POST)',\s*'\/admin\//g)?.length ?? 0, `${relative} names no admin routes`)
        .toBeGreaterThanOrEqual(4)
    }
  })

  it('every route the script names is mounted on the admin router', () => {
    const app = adminApp()
    const mounted = new Set(
      app.routes.map((route) => `${route.method} ${route.path.replace(/:id\b/g, ':param')}`)
    )
    for (const route of routesInScript()) {
      const key = `${route.method} ${route.path.replace(/:id\b/g, ':param')}`
      expect(mounted.has(key), `${route.method} ${route.path} is no longer served by /admin`).toBe(true)
    }
  })

  it('every route the script names refuses an anonymous caller', async () => {
    const app = adminApp()
    for (const route of routesInScript()) {
      const res = await app.request(concrete(route.path), {
        method: route.method,
        ...(route.method === 'POST' ? { headers: { 'content-type': 'application/json' }, body: '{}' } : {})
      })
      expect(res.status, `${route.method} ${route.path} must require a session`).toBe(401)
      expect((await res.json()).error.code).toBe('unauthorized')
    }
  })

  it('the retired RPC endpoint is not mounted at all', () => {
    const app = adminApp()
    const paths = app.routes.map((route) => route.path)
    expect(paths).not.toContain('/admin/rpc')
  })

  it('no verification script names the retired /admin/rpc endpoint', () => {
    for (const { relative, source } of SCRIPTS) {
      const calls = source.match(/\/admin\/rpc/g) ?? []
      expect(calls, `${relative} still references /admin/rpc`).toHaveLength(0)
    }
  })
})
