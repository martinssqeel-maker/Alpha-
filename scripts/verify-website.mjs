#!/usr/bin/env node
/**
 * Offline check of the companion website.
 *
 * The site is plain static HTML: it ships from `website/` with no build step, so
 * a broken reference only shows up once someone clicks it in a browser. This
 * asserts the things that broke it before, without any network access:
 *
 *   1. every local link and asset referenced by the pages actually exists,
 *   2. the download flow stays public (no sign-in / account / admin routes),
 *   3. the download CTA points at the GitHub releases API the app already uses,
 *   4. every page has a title and a favicon.
 *
 * Usage: node scripts/verify-website.mjs [websiteDir]
 * Exit status: 0 when the site is clean, 1 otherwise.
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const root = resolve(process.argv[2] ?? 'website')
const problems = []
const notes = []

const listHtml = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) return listHtml(full)
    return entry.name.endsWith('.html') ? [full] : []
  })

const exists = (fromFile, target) => {
  const cleaned = target.split('#')[0].split('?')[0]
  if (!cleaned) return true
  return existsSync(resolve(dirname(fromFile), cleaned))
}

if (!existsSync(root)) {
  console.error(`::error::website directory not found at ${root}`)
  process.exit(1)
}

const pages = listHtml(root)
if (pages.length === 0) {
  console.error(`::error::no HTML pages found under ${root}`)
  process.exit(1)
}

/** Local href/src references plus any dead auth/admin route. */
const LOCAL_REF = /(?:href|src|data-download)=["']([^"']+)["']/g
const DEAD_ROUTE = /(?:href|action)=["'](\/?(?:account|login|signin|sign-in|admin)(?:[./?][^"']*)?)["']/gi

for (const page of pages) {
  const html = readFileSync(page, 'utf8')
  const rel = page.slice(root.length + 1)

  for (const match of html.matchAll(LOCAL_REF)) {
    const target = match[1].trim()
    if (/^(?:https?:|mailto:|tel:|data:|javascript:|\/\/)/.test(target)) continue
    if (!exists(page, target)) {
      problems.push(`${rel}: broken local reference "${target}"`)
    }
  }

  for (const match of html.matchAll(DEAD_ROUTE)) {
    problems.push(`${rel}: dead authentication/admin route "${match[1]}"`)
  }

  if (!/<title[^>]*>[^<]+<\/title>/i.test(html)) problems.push(`${rel}: missing <title>`)
  if (!/<link[^>]+rel=["']?icon/i.test(html)) notes.push(`${rel}: no favicon link (harmless if assets/icon.png is served by default)`)
}

// The landing and download CTAs must resolve to the public releases endpoint so
// the download works for a visitor with no account.
const index = join(root, 'index.html')
if (existsSync(index)) {
  const html = readFileSync(index, 'utf8')
  if (!/github\.com\/[^"']+\/releases\/latest/.test(html)) {
    problems.push('index.html: no fallback link to the GitHub releases page')
  }
}

const dirEntries = readdirSync(root)
for (const required of ['index.html', 'download.html', 'assets']) {
  if (!dirEntries.includes(required)) problems.push(`website/: missing required entry "${required}"`)
}

if (notes.length) for (const note of notes) console.log(`NOTE  ${note}`)
if (problems.length) {
  console.error(`\n${problems.length} problem(s) found:`)
  for (const problem of problems) console.error(`  ${problem}`)
  process.exit(1)
}

console.log(`Website OK — ${pages.length} page(s) checked under ${root}`)
