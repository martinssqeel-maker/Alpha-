# Alpha AI Workspace — website

A dependency-free static site: marketing/landing page plus a public download page.
No accounts, no sign-in — the site is purely public.

- **No framework or build step.** Plain HTML/CSS/JS.
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
  assets/app-skills.png real screenshot of the current Agent Skills screen
  assets/icon.png       app icon (favicon + branding)
  vercel.json           clean URLs + security headers (deliberately no build command)
```

## Configuration

No environment configuration is needed. The pages read public GitHub Releases data
to resolve the current installer and fall back to the public releases page if that
request fails. Legacy `config.js`, `config.example.js`, and `gen-config.mjs` files are
not loaded by either page and do not configure the current website.

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
