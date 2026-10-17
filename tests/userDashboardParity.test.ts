import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { authRoutes } from '../platform/api/auth'
import { gatewayRoutes } from '../platform/api/gateway'
import { downloadRoutes } from '../platform/api/downloads'
import { platformRoutes } from '../platform/api/platform'

// The dashboard is static JavaScript calling a fixed set of API paths. A typo or
// a renamed route fails in the browser at the one moment a user is looking at
// their account — not in a build. This asserts the other direction of the same
// contract `adminRouteParity` enforces for the administration portal: every path
// `website/assets/dashboard.js` calls is served by the router it names.

const MOUNTS = [
  { prefix: '/auth', routes: authRoutes.routes },
  { prefix: '/platform', routes: platformRoutes.routes },
  { prefix: '/downloads', routes: downloadRoutes.routes },
  { prefix: '/gateway', routes: gatewayRoutes.routes }
]

const SERVED = new Set(
  MOUNTS.flatMap((mount) => mount.routes.map((route) => `${route.method} ${mount.prefix}${route.path}`))
)
const PATHS = new Set(MOUNTS.flatMap((mount) => mount.routes.map((route) => `${mount.prefix}${route.path}`)))

function dashboardCalls(): string[] {
  const source = fs.readFileSync(path.join(process.cwd(), 'website', 'assets', 'dashboard.js'), 'utf8')
  return [...source.matchAll(/api\(\s*[`'"]([^`'"]+)[`'"]/g)]
    .map((match) => match[1])
    .filter((value) => value.startsWith('/'))
    .map((value) => value.split('?')[0].replace(/\$\{[^}]+\}/g, ':id'))
}

describe('dashboard → API route parity', () => {
  it('finds calls to check', () => {
    expect(dashboardCalls().length).toBeGreaterThan(5)
  })

  it('serves every path the dashboard calls', () => {
    const missing = dashboardCalls().filter((url) => !PATHS.has(url))
    expect(missing, `dashboard calls routes the API does not serve: ${missing.join(', ')}`).toEqual([])
  })

  it('serves the self-service mutations with the methods the dashboard uses', () => {
    for (const route of [
      'GET /auth/me',
      'PATCH /auth/me',
      'GET /auth/sessions',
      'DELETE /auth/sessions/:id',
      'POST /auth/sessions/revoke-others',
      'POST /auth/signout',
      'GET /gateway/activity'
    ]) {
      expect(SERVED.has(route), `${route} must be registered`).toBe(true)
    }
  })
})
