# Alpha AI Workspace — website

A dependency-free static site: marketing/landing page, a public download page, and
the account page that signs users in.

- **No framework or build step.** Plain HTML/CSS/JS.
- **Never-stale download.** `assets/app.js` reads the latest GitHub Release from
  `martinssqeel-maker/Alpha-` and points every download button at the newest `.exe`
  (falling back to the releases page if the API is unavailable).
- **Public download page.** `download.html` + `assets/download.js` show the current
  version, size and release notes from the same GitHub API — no session required.
- **Account page.** `account.html` + `assets/account.js` offer every sign-in method
  the deployment actually reports (`/auth/providers`), plus the emailed link/code
  path, and render the signed-in account's plan and usage. Every page links to it:
  a `Sign in` action in the header (hidden below 620px, like the GitHub link) and an
  `Account` entry in the footer, so it stays reachable on phones.

## Files

```
website/
  index.html            landing page
  download.html         public download page (no sign-in)
  account.html          sign-in and account page
  assets/styles.css     design system
  assets/app.js         direct-download resolution + version/size hints + reveal animations
  assets/theme.js       applies the stored palette before first paint
  assets/download.js    fills the download page from the public GitHub Releases API
  assets/account.js     sign-in flows, session handling and the account view
  assets/app-skills.png real screenshot of the current Agent Skills screen
  assets/icon.png       app icon (favicon + branding)
  config.js             committed API base URL (generated; read by the account page)
  vercel.json           clean URLs + security headers (deliberately no build command)
```

## Configuration

Only the account page needs configuration: it reads the Alpha Cloud API host from the
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
