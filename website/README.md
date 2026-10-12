# Alpha AI Workspace — website

A dependency-free static site: marketing/landing page, plus a passwordless account
portal that reads plans, usage and models from the Neon Function API.

- **No framework, no build step** beyond one config generator. Plain HTML/CSS/JS.
- **Never-stale download.** `assets/app.js` reads the latest GitHub Release from
  `martinssqeel-maker/Alpha-` and points every download button at the newest `.exe`
  (falling back to the releases page if the API is unavailable).
- **Account portal.** `account.html` + `assets/account.js` request an emailed code /
  magic link and then render the signed-in user's plan, usage and available models.

## Files

```
website/
  index.html            landing page
  account.html          account / sign-in portal
  assets/styles.css     design system
  assets/app.js         latest-release resolver + reveal animations
  assets/account.js     sign-in + plan/usage rendering against the API
  assets/icon.png       app icon (favicon + branding)
  config.example.js     shape of the generated config
  config.js             GENERATED at build time — gitignored, never edit
  gen-config.mjs        writes config.js from the environment
  vercel.json           clean URLs, security headers, build command
```

## Configuration

The page reads `window.ALPHA_PLATFORM.apiBaseUrl`, which `gen-config.mjs` writes from:

| Variable | Notes |
| --- | --- |
| `API_BASE_URL` | The Neon Function base URL. `VITE_API_BASE_URL` also accepted. |

With nothing set, the build **still succeeds** and writes an unconfigured `config.js`;
`/account` then shows an honest "not configured" notice instead of a form that cannot
work. Verify a deployed site with:

```powershell
npm run smoke -- --website https://your-site.vercel.app
```

## Deploy to Vercel

1. **https://vercel.com/new** → import the `martinssqeel-maker/Alpha-` repo.
2. **Root Directory:** `website`. Framework Preset: **Other**, Build Command: leave
   empty (`vercel.json` supplies `node gen-config.mjs`), Output Directory: leave empty.
3. Add `API_BASE_URL` under **Settings → Environment Variables** for Production *and*
   Preview, then redeploy — Vite is not involved, but the config is generated at build
   time, so an env change needs a new deployment.

Every push to `main` that touches `website/` redeploys automatically.

### Custom domain (later)

Add it under **Project → Settings → Domains** and point your DNS as Vercel instructs.
If you do, remember the Function's `ALLOWED_ORIGINS` must list the final origin.

## Local preview

Any static server works:

```powershell
node gen-config.mjs           # optional: writes config.js for your API
npx serve website             # then open the printed http://localhost:3000
```

> Open via a server (not `file://`) so the GitHub API and the platform API fetch behave
> like production.
