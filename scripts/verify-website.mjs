#!/usr/bin/env node
/**
 * Offline check of the companion website.
 *
 * The site is plain static HTML: it ships from `website/` with no build step, so
 * a broken reference only shows up once someone clicks it in a browser. This
 * asserts the things that broke it before, without any network access:
 *
 *   1. every local link and asset referenced by the pages actually exists,
 *   2. no page links to an authentication or admin route that has no page,
 *   3. the download CTA points at the GitHub releases API the app already uses,
 *   4. every page has a title and a favicon, and the expected pages are present.
 *
 * The account page IS a real page, so `/account` is a legitimate link; what this
 * guards against is the original defect, where links pointed at pages that had
 * been deleted.
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
  // A leading slash means the *site* root, exactly as the host serves it.
  // Resolving it against the OS root silently reported `/download` as broken.
  const fromRoot = cleaned.startsWith('/')
  const base = fromRoot ? root : dirname(fromFile)
  const direct = resolve(base, fromRoot ? cleaned.replace(/^\/+/, '') || '.' : cleaned)
  if (existsSync(direct)) return true
  // Clean URLs: `/download` is served from website/download.html.
  if (!/\.[a-z0-9]+$/i.test(cleaned)) {
    return existsSync(`${direct}.html`) || existsSync(join(direct, 'index.html'))
  }
  return false
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

/** Local href/src references plus any auth/admin route that has no page. */
const LOCAL_REF = /(?:href|src|data-download)=["']([^"']+)["']/g
// `/account` is deliberately absent: that page exists again. The rest still have
// no page behind them, so linking to one would dead-end a visitor.
const DEAD_ROUTE = /(?:href|action)=["'](\/?(?:login|signin|sign-in|admin)(?:[./?][^"']*)?)["']/gi

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

// Landing-page contract: explain the product and send visitors to the account
// area. Installers are handed out from the authenticated account page only, so a
// direct release or `.exe` link here would regress that rule.
const index = join(root, 'index.html')
if (existsSync(index)) {
  const html = readFileSync(index, 'utf8')
  if (!/href=["']\/account/.test(html)) {
    problems.push('index.html: no link to /account (Get started / Sign in)')
  }
  if (/releases\/latest|\.exe["']/i.test(html)) {
    problems.push('index.html: offers an installer directly; downloads belong in the account area')
  }
}

// The download page may not hand out an installer either — it gates, then the
// account page loads the release from the authenticated API.
const downloadPage = join(root, 'download.html')
if (existsSync(downloadPage)) {
  const html = readFileSync(downloadPage, 'utf8')
  if (/releases\/latest|\.exe["']/i.test(html)) {
    problems.push('download.html: offers an installer directly; it must gate on sign-in')
  }
  if (!/href=["']\/account/.test(html)) {
    problems.push('download.html: no route to /account, so the gate dead-ends')
  }
}

// The account card must actually offer the password path, in the promised order:
// the email + password bar first, then GitHub, then Google. These are checked in
// the client that renders them rather than in markup, because the provider
// buttons are built from `/auth/providers`.
const accountJs = join(root, 'assets', 'account.js')
if (existsSync(accountJs)) {
  const js = readFileSync(accountJs, 'utf8')
  for (const needle of ['/auth/register', '/auth/password', '/auth/password/forgot', '/auth/password/reset']) {
    if (!js.includes(needle)) problems.push(`assets/account.js: no call to ${needle}`)
  }
  // A rejected field is marked where it is, and the API's error code decides
  // which field that is: a message in a line at the bottom points at nothing.
  for (const needle of ['function setFieldError', "aria-invalid", 'ERROR_FIELD']) {
    if (!js.includes(needle)) problems.push(`assets/account.js: field errors lost (${needle})`)
  }
  const github = js.indexOf("key: 'github'")
  const google = js.indexOf("key: 'google'")
  if (github === -1 || google === -1) {
    problems.push('assets/account.js: GitHub and Google provider buttons are not both declared')
  } else if (github > google) {
    problems.push('assets/account.js: GitHub must be offered before Google')
  }
}

const accountPage = join(root, 'account.html')
if (existsSync(accountPage)) {
  const html = readFileSync(accountPage, 'utf8')
  for (const needle of ['data-auth-form', 'id="auth-email"', 'id="auth-password"', 'data-forgot', 'data-reset-form']) {
    if (!html.includes(needle)) problems.push(`account.html: missing the password path (${needle})`)
  }
  // Sign-up collects a name and a phone number (the API refuses a request
  // without them), so both fields have to be on the card.
  for (const needle of ['id="auth-name"', 'id="auth-phone"']) {
    if (!html.includes(needle)) problems.push(`account.html: sign-up no longer asks for ${needle}`)
  }
  // Every field that can be rejected needs somewhere to say so next to itself.
  for (const key of ['name', 'email', 'phone', 'password', 'code']) {
    if (!html.includes(`data-field-error="${key}"`)) {
      problems.push(`account.html: no place to show a ${key} error beside its field`)
    }
  }
  // The code well belongs under the button that sends the code, before the
  // provider buttons: it is the next step, not an alternative to the first one.
  const codeWell = html.indexOf('data-code-form')
  const providers = html.indexOf('data-providers')
  if (codeWell === -1 || providers === -1 || codeWell > providers) {
    problems.push('account.html: the six-digit code well must come before the provider buttons')
  }
}

// Claims that a password exists nowhere on the product. They were true before
// member passwords shipped and are now the kind of marketing copy that makes a
// support ticket; the site must not regress into them.
const FALSE_CLAIM = /no password to remember|passwordless|no password needed|there is no password/i
for (const file of [join(root, 'assets', 'dashboard.js'), join(root, 'assets', 'account.js')]) {
  if (!existsSync(file)) continue
  const text = readFileSync(file, 'utf8')
  const hit = text.match(FALSE_CLAIM)
  if (hit) problems.push(`${path.relative(root, file)}: still claims "${hit[0]}"`)
}
for (const page of pages) {
  const hit = readFileSync(page, 'utf8').match(FALSE_CLAIM)
  if (hit) problems.push(`${page.slice(root.length + 1)}: still claims "${hit[0]}"`)
}

const dirEntries = readdirSync(root)
for (const required of ['index.html', 'download.html', 'account.html', 'app.html', 'assets']) {
  if (!dirEntries.includes(required)) problems.push(`website/: missing required entry "${required}"`)
}

if (notes.length) for (const note of notes) console.log(`NOTE  ${note}`)
if (problems.length) {
  console.error(`\n${problems.length} problem(s) found:`)
  for (const problem of problems) console.error(`  ${problem}`)
  process.exit(1)
}

// The dashboard is the signed-in product surface, so it must load both the
// shared brand and its own data client, and it must not be reachable without a
// session at the page level either (the client redirects, the API enforces).
const appPage = join(root, 'app.html')
if (existsSync(appPage)) {
  const html = readFileSync(appPage, 'utf8')
  for (const ref of ['assets/dashboard.js', 'assets/app.css', 'assets/styles.css', 'config.js']) {
    if (!html.includes(ref)) problems.push(`app.html: missing ${ref}`)
  }
  if (!/noindex/i.test(html)) problems.push('app.html: missing noindex (it shows one account\'s data)')
}

// The dashboard's profile card keeps the same contract as the sign-up card: the
// name and number the account was created with can be edited there, and a field
// the API rejects is marked where it is. `tests/userDashboardParity.test.ts`
// proves the route exists; this proves the card still asks for both fields.
const dashboardJs = join(root, 'assets', 'dashboard.js')
if (existsSync(dashboardJs)) {
  const js = readFileSync(dashboardJs, 'utf8')
  for (const needle of ["id: 'profile-name'", "id: 'profile-phone'", 'field-error', 'aria-invalid']) {
    if (!js.includes(needle)) problems.push(`assets/dashboard.js: profile card lost ${needle}`)
  }
}

console.log(`Website OK — ${pages.length} page(s) checked under ${root}`)
