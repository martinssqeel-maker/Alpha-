#!/usr/bin/env node
/**
 * Minimal static server for the companion website.
 *
 * The site is plain files under `website/`, and the host resolves clean URLs
 * (`/account` -> `account.html`, `/download` -> `download.html`). Neither the
 * Electron preview panel nor `file://` does that, so local checks were previously
 * done with an ad-hoc one-liner. This makes the QA path repeatable.
 *
 * Usage: node scripts/serve-website.mjs [port] [--api <baseUrl>]
 *   (default port 8123)
 *
 * `--api` rewrites the *served* copy of `config.js` to point at that API base, so
 * the sign-in and download surfaces can be rendered locally against
 * `scripts/stub-platform-api.mjs`. The committed `website/config.js` is never
 * touched.
 */
import { createServer } from 'node:http'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { extname, join, normalize, resolve } from 'node:path'

const root = resolve('website')
const port = Number(process.argv[2] ?? 8123)
const apiFlag = process.argv.indexOf('--api')
const apiBase = apiFlag >= 0 ? process.argv[apiFlag + 1] : null
if (apiBase && !/^https?:\/\//.test(apiBase)) {
  console.error('--api needs an http(s) URL')
  process.exit(1)
}

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2'
}

/** Resolve a URL path to a file, honouring `/page` -> `page.html`. */
function resolveFile(urlPath) {
  const clean = normalize(decodeURIComponent(urlPath.split('?')[0])).replace(/^(\.\.[/\\])+/, '')
  const direct = join(root, clean)
  if (!direct.startsWith(root)) return null
  if (existsSync(direct) && statSync(direct).isFile()) return direct
  if (existsSync(`${direct}.html`)) return `${direct}.html`
  if (existsSync(join(direct, 'index.html'))) return join(direct, 'index.html')
  return null
}

createServer((req, res) => {
  const file = resolveFile(req.url ?? '/')
  // Local QA only: never rewrite a real deployment's config. The site reads the
  // API host from this file at runtime, so this is the switch that makes the
  // signed-in surfaces testable against the stub.
  if (apiBase && file && file.endsWith('config.js')) {
    res.writeHead(200, { 'content-type': TYPES['.js'], 'cache-control': 'no-store' })
    res.end(`window.ALPHA_PLATFORM = ${JSON.stringify({ apiBaseUrl: apiBase }, null, 2)}\n`)
    return
  }
  if (!file) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('404 Not Found')
    return
  }
  res.writeHead(200, {
    'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
    'cache-control': 'no-store'
  })
  res.end(readFileSync(file))
}).listen(port, '127.0.0.1', () => {
  console.log(`website served from ${root} at http://127.0.0.1:${port}`)
})
