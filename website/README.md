# Alpha AI Workspace — website

A single-page, dependency-free landing/download site for the desktop app.

- **No build step.** Plain HTML/CSS/JS in this folder.
- **Never-stale download.** `assets/app.js` reads the latest GitHub Release from
  `martinssqeel-maker/Alpha-` and points every download button at the newest
  `.exe` (falling back to the releases page if the API is unavailable).

## Files

```
website/
  index.html          page markup
  assets/styles.css   design system
  assets/app.js       latest-release resolver + reveal animations
  assets/icon.png     app icon (favicon + branding)
  vercel.json         clean URLs + security headers
```

## Deploy to Vercel

1. Go to **https://vercel.com/new** and import the `martinssqeel-maker/Alpha-` repo.
2. **Important:** set **Root Directory** to `website` (Framework Preset: **Other**,
   Build Command: leave empty, Output Directory: leave empty).
3. Deploy. Every push to `main` that touches `website/` redeploys automatically.

### Custom domain (later)

Add it under **Project → Settings → Domains** and point your DNS as Vercel instructs.

## Local preview

Any static server works, e.g.:

```powershell
npx serve website
# then open the printed http://localhost:3000
```

> Open via a server (not `file://`) so the GitHub API fetch behaves like production.
