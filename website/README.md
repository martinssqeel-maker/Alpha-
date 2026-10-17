# Alpha AI Workspace — website

A dependency-free static site: marketing/landing page, a public download page, the
account page that signs users in, and the authenticated account dashboard at `/app`.

- **No framework or build step.** Plain HTML/CSS/JS.
- **Never-stale download.** `assets/app.js` reads the latest GitHub Release from
  `martinssqeel-maker/Alpha-` and points every download button at the newest `.exe`
  (falling back to the releases page if the API is unavailable).
- **Public download page.** `download.html` + `assets/download.js` show the current
  version, size and release notes from the same GitHub API — no session required.
- **Legal pages.** `privacy.html` and `terms.html` are plain, dependency-free
  documents served at `/privacy` and `/terms` (clean URLs). Both are linked from
  every page's footer, and each links to the other. They read the account service's
  actual behaviour from the code rather than describing a generic policy, so keep
  them in step when what the API stores changes.
- **Account page.** `account.html` + `assets/account.js` offer every sign-in method
  the deployment actually reports (`/auth/providers`), plus the emailed link/code
  path, and render the signed-in account's plan and usage. Member accounts are
  passwordless today; adding an email + password path is specified in
  `docs/website/premium-rebuild-spec.md`, together with every claim in this site that
  would become false with it. Signing in *is* signing
  up: the API provisions the account on the first verified sign-in, so
  `/account?mode=signup` only reframes the same card (title, lede and email button)
  instead of pretending there is a second endpoint. Every page links to it —
  `Sign in` and `Sign up` actions in the header (both hidden below 620px, like the
  GitHub link) and `Sign in` / `Sign up` entries in the footer, so both stay
  reachable on phones. Finishing a sign-in hands the browser to `/app`.
- **Account dashboard.** `app.html` + `assets/dashboard.js` are the signed-in
  product surface: overview, profile, security and sessions, usage, models,
  downloads and help. Every figure is read from the API — `/platform/config`,
  `/auth/me`, `/auth/sessions`, `/gateway/status`, `/gateway/activity` and
  `/downloads/latest` — and a figure the API could not answer is shown as
  unavailable, never as a zero. Without a session the page redirects to
  `/account?next=app`; the API still enforces every call, so the redirect is
  convenience rather than protection. Profile edits (`PATCH /auth/me`) and session
  revocation (`DELETE /auth/sessions/:id`) go through the real endpoints, and a
  revoked session stops opening the API on its next request.

## Files

```
website/
  index.html            landing page
  download.html         public download page (no sign-in)
  account.html          sign-in / sign-up and account page
  app.html              authenticated dashboard (/app)
  assets/dashboard.js   dashboard data loading, views and session controls
  assets/app.css        dashboard shell, tiles, tables and chart
  privacy.html          public privacy policy (/privacy)
  terms.html            public terms of service (/terms)
  assets/styles.css     design system
  assets/app.js         landing-page behaviour (deliberately does not serve installers)
  assets/theme.js       applies the stored palette before first paint
  assets/download.js    fills the download page from the public GitHub Releases API
  assets/account.js     sign-in flows, session handling and the account view
  assets/app-skills.png real screenshot of the current Agent Skills screen
  assets/icon.png       app icon (favicon + branding)
  config.js             committed API base URL (generated; read by the account page)
  vercel.json           clean URLs + security headers (deliberately no build command)
```

## Configuration

The account page and the dashboard both read the Alpha Cloud API host from the
committed `config.js` (`window.ALPHA_PLATFORM.apiBaseUrl`). Regenerate it when the API
host changes:

```powershell
API_BASE_URL=https://<host> node website/gen-config.mjs
```

If `config.js` has no `apiBaseUrl`, the account page says so plainly instead of
half-working. The landing and download pages need no configuration at all — they read
public GitHub Releases data and fall back to the public releases page if that request
fails.

### Sign-in needs three things on the API side

1. `ALLOWED_ORIGINS` must include this site's origin (and `http://localhost:3000` for
   local preview), or the browser blocks every call.
2. `WEB_ACCOUNT_URL` must be this site's origin, so emailed sign-in links come back here.
3. `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` (or the GitHub pair) are needed before that
   provider's button appears at all; without them the page shows only the email path.
4. The API's CORS `allowMethods` must include `PATCH` and `DELETE`: the dashboard uses
   both (profile updates, session revocation), and a browser preflight rejects them
   before the request reaches a handler.

## Deploy to Vercel

1. **https://vercel.com/new** → import the `martinssqeel-maker/Alpha-` repo.
2. **Root Directory:** `website`. Framework Preset: **Other**, Build Command: leave
   empty, Output Directory: leave empty. Do **not** add a build command to
   `vercel.json` either — see the note below.
3. No environment variables or build command are required.

The deployed project's current connection and status were not checked during this work.

### Custom domain (later)

Add it under **Project → Settings → Domains** and point your DNS as Vercel instructs.

## Local preview

Any static server works:

```powershell
npx serve website             # then open the printed http://localhost:3000
```

Open through a server (not `file://`) so the public GitHub Releases API behaves like
production.
