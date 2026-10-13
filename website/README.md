# Alpha AI Workspace — website

A dependency-free static site: marketing/landing page plus a public download page.
No accounts, no sign-in — the site is purely public.

- **No framework, no build step** beyond one config generator. Plain HTML/CSS/JS.
- **Never-stale download.** `assets/app.js` reads the latest GitHub Release from
  `martinssqeel-maker/Alpha-` and points every download button at the newest `.exe`
  (falling back to the releases page if the API is unavailable).
- **Public download page.** `download.html` + `assets/download.js` show the current
  version, size and release notes from the same GitHub API — no session required.

## Files

```
website/
  index.html            landing page
  download.html         public download page (no sign-in)
  assets/styles.css     design system
  assets/app.js         direct-download resolution + version/size hints + reveal animations
  assets/theme.js       applies the stored palette before first paint
  assets/download.js    fills the download page from the public GitHub Releases API
  assets/icon.png       app icon (favicon + branding)
  config.example.js     shape of the generated config
  config.js             COMMITTED platform config — this is what ships
  gen-config.mjs        regenerates config.js from the environment
  vercel.json           clean URLs + security headers (deliberately no build command)
```

## Configuration

The page reads `window.ALPHA_PLATFORM.apiBaseUrl` from the **committed** `config.js`, so a
deployment serves it as a plain static file — no build step, no environment variables.

Regenerate it when the API host changes:

```powershell
$env:API_BASE_URL = "https://<function-host>"   # VITE_API_BASE_URL also accepted
node website/gen-config.mjs
```

With no `API_BASE_URL` the generator still succeeds and writes an *unconfigured*
`config.js`; the pages then simply skip anything platform-backed instead of failing.
Verify a deployed site with:

```powershell
npm run smoke -- --website https://your-site.vercel.app
```

## Deploy to Vercel

1. **https://vercel.com/new** → import the `martinssqeel-maker/Alpha-` repo.
2. **Root Directory:** `website`. Framework Preset: **Other**, Build Command: leave
   empty, Output Directory: leave empty. Do **not** add a build command to
   `vercel.json` either — see the note below.
3. Nothing else to configure: the committed `config.js` supplies the API host.

> **Why there is no build command.** The migration added
> `"buildCommand": "node gen-config.mjs"` and every deployment failed from that commit
> on, leaving the site stuck on an older build. The generated file only ever contained a
> public API URL, so it is committed instead and `vercel.json` keeps the shape that last
> deployed successfully.

Every push to `main` that touches `website/` redeploys automatically.

### Custom domain (later)

Add it under **Project → Settings → Domains** and point your DNS as Vercel instructs.
If you do, remember the Function's `ALLOWED_ORIGINS` must list the final origin.

## Local preview

Any static server works:

```powershell
node website/gen-config.mjs   # optional: rewrite config.js for a different API host
npx serve website             # then open the printed http://localhost:3000
```

> Open via a server (not `file://`) so the GitHub API and the platform API fetch behave
> like production.
