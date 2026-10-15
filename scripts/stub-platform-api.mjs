#!/usr/bin/env node
/**
 * QA-only stub of the Alpha platform API.
 *
 * The deployed API narrows CORS to the production site origin, so the signed-in
 * surfaces of `website/` cannot be exercised from `http://127.0.0.1`. This serves
 * the documented response shapes instead — nothing else. It is never used by the
 * site, the desktop app or a deployment; it exists so a browser check can render
 * the authenticated account area locally.
 *
 * Usage: node scripts/stub-platform-api.mjs [port]   (default 8199)
 *   --no-release   answer /downloads/latest with the "no release" error shape
 *   --unauthorized answer /downloads/latest with 401 (expired session)
 */
import { createServer } from 'node:http'

const port = Number(process.argv.find((a) => /^\d+$/.test(a)) ?? 8199)
const noRelease = process.argv.includes('--no-release')
const unauthorized = process.argv.includes('--unauthorized')

const RELEASE = {
  version: '1.0.6',
  channel: 'stable',
  platform: 'win',
  notes: 'Stub release body — proves the account page renders real release notes.',
  url: 'https://github.com/martinssqeel-maker/Alpha-/releases/latest',
  size: 125492796,
  sha512: 'stub-checksum-not-a-real-digest',
  minimumSupportedVersion: '1.0.0',
  releasedAt: new Date('2026-10-13T09:00:00Z').toISOString()
}

const json = (res, status, body) => {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'authorization,content-type',
    'access-control-allow-methods': 'GET,POST,OPTIONS'
  })
  res.end(JSON.stringify(body))
}

createServer((req, res) => {
  const path = (req.url ?? '/').split('?')[0]
  if (req.method === 'OPTIONS') return json(res, 204, {})

  if (path === '/auth/providers') {
    return json(res, 200, { ok: true, google: true, github: true, password: true, otp: true })
  }
  if (path === '/auth/refresh') {
    return json(res, 200, {
      ok: true,
      accessToken: 'stub-access-token',
      refreshToken: 'stub-refresh-token',
      expiresAt: Date.now() + 3_600_000,
      email: 'qa@example.com'
    })
  }
  if (path === '/platform/config') {
    return json(res, 200, {
      account: { email: 'qa@example.com' },
      plan: { name: 'Free' },
      subscription: { status: 'active' },
      usage: [{ resource: 'messages', used: 12, limit: 100 }],
      models: [{ id: 'stub-model', allowed: true }]
    })
  }
  if (path === '/downloads/latest') {
    if (unauthorized) {
      return json(res, 401, { ok: false, error: { code: 'unauthorized', message: 'Invalid or expired session.' } })
    }
    if (noRelease) {
      return json(res, 404, { ok: false, error: { code: 'no_release', message: 'No desktop release is published yet.' } })
    }
    return json(res, 200, { ok: true, release: RELEASE })
  }
  json(res, 404, { ok: false, error: { code: 'not_found', message: `No stub route for ${path}` } })
}).listen(port, '127.0.0.1', () => {
  console.log(`stub platform API on http://127.0.0.1:${port}${noRelease ? ' (no-release mode)' : ''}${unauthorized ? ' (unauthorized mode)' : ''}`)
})
