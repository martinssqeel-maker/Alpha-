# Alpha AI Workspace — website rebuild spec

> **How to use this document.** It is written to be pasted verbatim as the task brief for
> an agent working in this repository. It is deliberately specific about what already
> exists, because most of the risk in this job is rebuilding something that works or
> regressing a rule the repository already enforces in CI.

**Mission.** Turn the public website into a premium, professional product surface — neon
glassmorphism, confident typography, clear sections — with a working **email + password**
sign-up and sign-in, GitHub and Google offered as "continue with" alternatives, and the
desktop installer handed out **only to signed-in, active accounts, always as the newest
built version**. The site is the product's front door; it must look like the desktop app
and behave like it too.

**Scope.** `website/` and `platform/api/` only. The desktop application is already built,
versioned and released (`v1.0.6`) — do not rebuild it, do not change its sign-in flow.

---

## 1. Ground truth — read this before planning

Anything in this section exists today. Rebuilding it is wasted work; breaking it is a
regression the CI job will catch.

### 1.1 The site

Static HTML/CSS/JS in `website/`, **no framework and no build step**. Vercel serves
`website/` directly (`website/vercel.json`: `cleanUrls`, `trailingSlash: false`,
security headers, and a rewrite of `/auth/*` to the API host).

| Page | Lines | Role |
| --- | --- | --- |
| `index.html` | 403 | Landing: hero, `#shots`, `#features`, `#workflow`, `#get-started`, `#requirements`, `#faq`, `#plans`, final CTA |
| `account.html` | 240 | Sign-in / sign-up card; also the signed-in summary |
| `download.html` | 120 | Public explainer that **gates**, never links an installer |
| `app.html` | 122 | Signed-in dashboard shell (`/app`) |
| `admin.html` | 407 | Operator control centre (`/admin`) |
| `features.html` `pricing.html` `about.html` | 200–252 | Supporting pages |
| `privacy.html` `terms.html` | 203–265 | Legal; currently describe a passwordless product |

Assets: `assets/styles.css` (603 lines, the shared design system), `assets/app.css`
(483, dashboard), `assets/theme.js` (pre-paint palette), `assets/account.js` (702),
`assets/dashboard.js` (1397), `assets/admin.js` (1303), `assets/app.js` (66),
`assets/download.js` (30), `assets/icon.png`, `config.js` (committed API host, generated
by `website/gen-config.mjs` and verified reproducible in CI).

### 1.2 Authentication today

`platform/api/auth.ts` serves exactly these routes:

```
POST /auth/request              → emails a 6-digit code and a one-tap link
POST /auth/verify               → code or magic token → session
GET  /auth/providers            → { google, github, password: true, otp: true }
POST /auth/password             → email + password, ADMIN ONLY (see §3.6)
GET  /auth/google/start|callback, GET /auth/github/start|callback
POST /auth/oauth/exchange       → single-use code → session (keeps tokens out of URLs)
POST /auth/refresh, POST /auth/signout
GET/PATCH /auth/me, GET /auth/sessions, DELETE /auth/sessions/:id,
POST /auth/sessions/revoke-others, GET /auth/status
```

- **Member accounts are passwordless today**: a one-time code sent to the mailbox, or a
  linked Google/GitHub identity. The site says so in four places (`index.html:202`,
  `download.html:61`, `account.html:106`, and `assets/dashboard.js:738,868`). Those
  claims become false the moment passwords ship — §3.7 lists every one.
- `public.provision_user(email)` (idempotent: creates the user, a `free` subscription and
  entitlements) is what the API calls on a first verified sign-in. `public.link_identity()`
  is the OAuth equivalent.
- `public.password_credentials(user_id, password_hash, algo, created_at, updated_at)`
  exists, and the migration is explicit: *"there is no API endpoint that can write this
  table — it is seeded by scripts/admin-password.mjs running on the operator's machine"*.
  **Making passwords a public feature therefore means adding the first server-side write
  path to that table, and doing it with the same care as the operator script.**
- Password hashing helpers already exist in `platform/api/password.ts`: self-describing
  `scrypt$N$r$p$salt$digest` format, `N=16384, r=8, p=1`, `MIN_PASSWORD_LENGTH = 12`,
  a weak-phrase list, constant-time `verifyPassword`, and `passwordNeedsRehash`.
- Throttling primitives exist: `public.auth_attempts` with `tooManyAttempts()` /
  `recordAttempt()`, env-tunable (`AUTH_PASSWORD_MAX_ATTEMPTS`, `AUTH_PASSWORD_WINDOW_MIN`).
- Sessions are bearer access tokens plus refresh rows in `public.sessions`;
  `requireLiveSession` makes revocation take effect on the next request.

### 1.3 Downloads today — already gated, already single-source

- `GET /downloads/latest` (`platform/api/downloads.ts`) requires a bearer session **and** a
  live session row, then checks `status === 'active'` in the database. Anonymous → `401`,
  suspended → `403`, maintenance → `503`, no published release → `404`. It returns the row
  from `public.releases` and records a `public.downloads` row.
- `public.releases` is the single source of truth. Publishing a GitHub release updates
  auto-update only; `npm run release:register` (`scripts/register-release.mjs`) is what
  advances the gated download, and it refuses unless the published asset's byte length
  equals the local installer's. As of this writing it serves **1.0.6**.
- The dashboard already renders a download card with one primary button
  (`assets/dashboard.js:458` `releaseBlock()`, version + size + date + SHA-512), and
  `scripts/verify-website.mjs` **fails the build** if `index.html` or `download.html`
  offers an installer directly.

### 1.4 What CI already proves

`.github/workflows/ci.yml` job **Verify (desktop + backend + website)**, 14 steps, all
green on `main`, including: the desktop build, `npm run typecheck`, the vitest suite,
`node scripts/verify-website.mjs`, and a check that regenerating `website/config.js`
produces no diff. Keep it green; add to it rather than around it.

---

## 2. Definition of done

Each item is checkable, and the check is named. Do not mark one done from a screenshot
alone.

**Authentication**

1. A new visitor can create an account with an email address and a password from
   `/account`, and is signed in afterwards. Verified by a new live check in
   `scripts/verify-auth.mjs --with-write` (create → session → `GET /auth/me` → delete).
2. The same person can sign out and sign back in with that email and password.
3. "Continue with GitHub" and "Continue with Google" sit below the password form, in that
   order, and work (Google and GitHub credentials are configured on the deployment;
   `GET /auth/providers` reports both).
4. A wrong password, an unknown address and a suspended account are indistinguishable in
   the response (`401 invalid_credentials`), and repeated attempts are throttled.
5. A password can be **reset** through an emailed code, and the code is single-use.
6. Registration cannot be used to enumerate accounts (§3.5).
7. `POST /auth/password` reports `admin` from the database, never as a constant (§3.6).
8. The emailed code/link path still works end to end, including the desktop
   `alpha://auth/callback` handoff — the installed app depends on it.

**Download**

9. Every page except the signed-in dashboard still hands out no installer; `verify-website`
   stays the enforcer.
10. The dashboard shows one obvious button whose version equals
    `select public.latest_release('stable','win')->>'version'`, and whose SHA-512 equals the
    digest in both the `public.releases` row and the GitHub release's `latest.yml`.
11. Signed-out `/app` redirects to `/account?next=app`; a suspended account sees a real
    explanation rather than an empty card.

**Design**

12. Landing page and shared shell use the neon-glass language of §5 within the existing
    token system, in **both** palettes, with no hardcoded colours outside `styles.css`.
13. Keyboard-only pass and contrast ratios of §7 hold at 390 / 768 / 1440 px.
14. No framework, no bundler, no webfont, no new runtime dependency — the site keeps
    shipping from `website/` with no build step (CI checks `config.js` reproducibility).

**Delivery**

15. `npm run typecheck`, the vitest suite, `node scripts/verify-website.mjs` and the
    extended `verify-auth` all pass; the CI job is green on the branch.
16. Docs updated in the same commits: `website/README.md`, `docs/platform/verification.md`,
    `docs/platform/MANUAL-TODO.md`, and the legal pages where they describe passwords.

---

## 3. Authentication workstream (the substantial new work)

### 3.1 The sign-up card, in order

`/account` replaces the current single card with three stacked blocks, strongest first:

```
┌ Create your account ──────────────────────────────────────────┐
│  [ you@example.com            ] [ ●●●●●●●●●●●●          ]     │   ← the bar
│  [              Create account                               ] │
│  12+ characters. Shown once — use a password manager.          │
│                                                                │
│  ─────── or continue with ───────                              │
│  [ 🐙 Continue with GitHub ]   [ G  Continue with Google ]     │
│                                                                │
│  Prefer no password? Email me a sign-in link                   │  ← tertiary
└────────────────────────────────────────────────────────────────┘
```

- The bar is **email + password in one row** on wide screens (`.field-row` already exists
  in `account.html:91`), stacked under ~520 px.
- Show/hide toggle inside the password field; `autocomplete="new-password"` on sign-up and
  `"current-password"` on sign-in; `inputmode`/`type` correct for mobile keyboards; never
  block paste; no client-only validation — the server's message is the truth.
- `/account?mode=signup` keeps working and reframes this card; `/account?mode=signin` shows
  the same card with "Create account" swapped for "Sign in" and the tertiary link dropped.
- Keep `?next=` honoured after sign-in (the dashboard uses `/account?next=app`).
- The card must never be blank: keep the `loading` / `unconfigured` views that
  `account.js` already renders while `/auth/providers` is in flight.

### 3.2 API contract to add

Follow the existing file's conventions (`withContext`, `AppEnv`, `{ ok, error: { code, message } }`,
rate-limit helpers, `mintSession`). Proposed surface:

| Route | Body | Success | Failure |
| --- | --- | --- | --- |
| `POST /auth/register` | `{ email, password, fullName, phone }` | `202` `{ ok, needsVerification: true, delivered, message }` — the address is unproved, so no session yet | `400 invalid_email`, `400 weak_password` (message from `passwordProblem`), `400 invalid_name` / `400 invalid_phone` (message from `platform/api/profile.ts`), `429 too_many_attempts` |
| `POST /auth/password/forgot` | `{ email }` | `202` `{ ok: true }` **always** | `429` |
| `POST /auth/password/reset` | `{ email, code, password }` | `200` `{ ok: true }` (then sign in) | `400 invalid_code`, `400 invalid_request`, `429` |
| `POST /auth/password` (existing) | `{ email, password }` | `200` session, `admin` computed | unchanged `401 invalid_credentials` |

Implementation notes that are not optional:

- **Write path for the credential.** Add a `SECURITY DEFINER` SQL function in a new
  migration — e.g. `public.set_password_credential(p_user uuid, p_hash text, p_algo text)`
  — rather than hand-writing SQL into `password_credentials` from the route, so the
  authorization story matches the rest of the platform. Reuse `public.provision_user()`
  for account creation, exactly as the verified-sign-in path does.
- **Hash on the server, always.** `hashPassword()` from `platform/api/password.ts`; store
  only the digest; re-hash on sign-in when `passwordNeedsRehash()` says the parameters
  moved. Never log, echo, audit or email a password.
- **Sessions** come from the existing `mintSession(userId, email, userAgent, ip)`; the
  refresh row, `/auth/sessions` listing and revocation must all behave as they already do.
- **Audit** `auth.password_set` and `auth.password_reset` into `public.audit_logs` with the
  actor, never the secret.
- **Throttle** with new keys (`register`, `password_reset`) at per-email and per-IP scope,
  mirroring the existing `password` route.

### 3.3 Verification before the download gate opens

A password sign-up proves nothing about the mailbox. Require the emailed 6-digit code
before the account can download: register → `provision_user()` → send the same code
`/auth/request` sends → the account is usable for sign-in immediately, but
`GET /downloads/latest` refuses until the code is confirmed (return `403 email_unverified`
with a message that names the fix, and let the dashboard render an honest state with a
"Resend code" action). Record the decision in `docs/platform/verification.md`. If you
choose a different policy, state it there too — silence is what makes this class of
decision expensive later.

### 3.4 Password reset is part of the feature, not a follow-up

Shipping passwords without a reset path strands every user who forgets one, so §2.5 is a
blocking requirement. Reuse `public.auth_otps` (store hashes only — the migration notes
this explicitly), single-use, short expiry, and the same "resend" affordances as sign-in.

### 3.5 Enumeration

- **Sign-in** stays uniform: one message, one status, for unknown address, wrong password,
  non-admin and inactive account. This is existing behaviour; keep it and keep its test.
- **Registration** leaks by design if it answers "that email is taken". Answer
  `202 { ok: true }` with the same copy for every registered address and send a real email
  either way ("Someone tried to create an account with this address. Sign in, or reset your
  password."), so the response carries no information.
- **Forgot** answers `202` unconditionally, for the same reason.

### 3.6 The existing `/auth/password` route

Today it succeeds only for an account that is `is_admin`, active, and has a credential, and
it returns `admin: true` as a **constant** (`auth.ts`, end of the handler). The moment
members can use this route — and §3.1 requires that — that constant becomes a lie the client
may trust. Compute it (`public.is_admin(user_id)`) and add a test asserting a member session
comes back with `admin: false`, while an administrator's comes back `true`.

Decide deliberately whether members sign in on this route or a sibling one, and write the
reasoning next to the chosen code. The uniform-failure property and the admin-only
enumeration defence in the current comment must survive either way.

### 3.7 Copy that must change

Passwords make these false. Find and rewrite them all; add a guard to
`scripts/verify-website.mjs` that fails if "no password to remember" style claims return:

| File | Line | Now says |
| --- | --- | --- |
| `website/index.html` | 202 | "Sign up with Google, GitHub, or just an email address — there is no password to remember." |
| `website/download.html` | 61 | "(Google, GitHub or an email link — no password)" |
| `website/account.html` | 106 | "No password to remember." |
| `website/assets/account.js` | 51, 60, 74, 87 | sign-up/sign-in ledes promising passwordlessness |
| `website/assets/dashboard.js` | 738, 868 | "passwords are only used by administrators" / "There is no password on this account to change here" |
| `website/privacy.html`, `website/terms.html` | — | describe what is stored; now include a scrypt digest and the reset flow |

Also add the password section to the dashboard's **Security** panel: change password (current
+ new, for accounts that have one), and "set a password" for accounts that signed up through
a provider only — which is what `dashboard.js:868` says is impossible today.

### 3.8 Do not break the desktop app

The installed app signs in with the emailed code/link and the `alpha://auth/callback`
handoff, and `AUTH_APP_SCHEME` stays authoritative. `/auth/request`, `/auth/verify` and
`/auth/oauth/exchange` must keep their current shapes; adding a password path must not
remove or rename anything they use. Desktop sign-in is the one flow you cannot test from
here — say so rather than assuming it.

---

## 4. Download page and installer integrity

The plumbing is right; the job is to make it *obvious* and *provable*.

1. **Landing and `/download`** explain that the installer is behind an account, then route
   to `/account?mode=signup` or `/app`. They must not link a `.exe` or `releases/latest`
   (CI enforces this — keep it passing).
2. **The dashboard card** (`releaseBlock()`) is the only place an installer is handed out.
   It must show: product version, "Windows installer", size, released date, the one primary
   button, the SHA-512 with a copy control, and release notes when the row has them.
3. **Honest states, no fake zeros**: signed out → redirect to the gate; `403` → the real
   reason (suspended vs `email_unverified`); `404 no_release` → "no release is published
   yet"; `503 maintenance` → the maintenance message and nothing else.
4. **Prove the installer is the newest built one** (§2.10). Add the equality check as a
   script — `npm run verify:download` — that compares, and fails loudly when they diverge:
   the local `release/latest.yml`, the GitHub release `v<version>` asset size and digest,
   the `public.releases` row, and the version `GET /downloads/latest` returns for a real
   session. `scripts/ensure-release.mjs --check` and `scripts/register-release.mjs --check`
   already cover two of the four legs; compose them rather than duplicating their logic.
5. **Version bump rule**: any change that alters what users install bumps `package.json`
   version, rebuilds, `node scripts/ensure-release.mjs`, then
   `npm run release:register`. Three steps, in that order, and the docs already say why.

---

## 5. Design language — "neon glass", inside the existing system

`assets/styles.css` already defines the vocabulary. Neon glass in this codebase means
**discipline with those tokens**, not a pile of purple blur.

- **Planes**: `--ink` page, `--panel`/`--panel-2`/`--panel-3` for stacked surfaces.
  Glass = a translucent `--panel` + `backdrop-filter: blur(12px) saturate(140%)`, a 1 px
  `--line-2` hairline and the `--lift-1` inner highlight. One blur per layer; never nest
  more than two glass layers.
- **Accent**: `--brand` is for selection, focus and the primary action — never decoration.
  `--brand-edge`/`--brand-tint` may glow around the active element only.
- **Glow budget**: at most two glowing sources visible at once per viewport (the hero and
  the primary CTA, say). A gradient wash belongs behind a section, not on top of text.
- **Type**: `--plate` serif for headings, `--ui` for body and controls, `--data` for
  identifiers — already wired. Keep the scale deliberate: one display size per page.
- **Radii** `--r-xs…--r-lg`, spacing and `--maxw` unchanged; do not introduce a parallel
  scale, and do not hardcode hex outside the two palette blocks.
- **Light palette parity**: every new component must read correctly with
  `html[data-theme='light']` — check it, don't assume it.
- **Depth over noise**: replace any decorative dot/line clutter with one confident hero
  image (`assets/app-skills.png` is a real screenshot — prefer a real capture over a
  mock), framed in glass with reserved dimensions so nothing shifts on load.
- **Restraint on mobile**: glass and glow are expensive; on narrow screens reduce to
  hairlines and solid planes, keep the 60 fps scrolling impression, respect
  `prefers-reduced-motion` (no parallax, transitions ≤ 200 ms).

---

## 6. Page-by-page brief

**`/` (index).** Keep the section ids `#features #workflow #get-started #requirements #faq
#plans`; rebuild what is inside them. Hero: one promise sentence, one primary CTA
("Create your account"), one secondary ("See what's inside"), one real screenshot. Feature
grid: six capabilities, each a concrete noun ("Local models, zero setup") not an adjective
("Blazing fast"). Workflow: install → connect → ship, in three steps. "Get started" reframes
the gate honestly. FAQ answers the awkward ones (price, offline, where data goes, why an
account is needed to download).

**`/account`.** §3.1. Signed-in state: plan, usage summary, "Open your dashboard" to `/app`,
sign-out. Keep `noindex`.

**`/download`.** Public, gated explainer: what the installer is, that it is unsigned and may
show a SmartScreen prompt, what Windows version is required, how to verify the SHA-512, then
the gate. No direct links.

**`/app` (dashboard).** Keep the panels; make the **downloads** panel the §4 card, and the
**security** panel list live sessions (existing) plus the password controls of §3.7. Every
panel keeps its "unavailable" state for an endpoint that cannot answer — a zero that means
"we could not ask" is worse than nothing.

**`/admin`.** Unchanged in layout. If the release/password columns exist, make them truthful
for member accounts (they already carry a `hasPassword` flag).

**`features` / `pricing` / `about`.** Consistency pass to the new shell — same nav, footer,
tokens, one clear CTA each, no invented capabilities and no pricing the platform cannot
enforce.

**Legal.** `privacy.html`/`terms.html` must accurately describe the new storage (scrypt
digest, reset emails, session records, download logging). They are written from the code, so
change them in the same commit as the code.

---

## 7. Accessibility and performance budgets

- Contrast ≥ 4.5:1 body text, ≥ 3:1 for large text and UI borders, in **both** palettes —
  glass over a gradient is the usual failure, so measure it.
- Visible `:focus-visible` ring on every control; the password toggle included.
- Keyboard-only pass for the whole sign-up, sign-in and reset flow; no keyboard trap in the
  card; `aria-live` for "code sent", errors announced once, `aria-describedby` linking the
  password hint to its field.
- One `h1` per page, landmark regions, labelled inputs, no placeholder-as-label.
- Budgets, because the site is dependency-free: no framework, no bundler, no webfont;
  ≤ 60 KB of site JavaScript total, CSS growth justified per component, images compressed
  and dimensioned, no blocking third-party request. Target LCP < 2.5 s on a mid-range phone
  profile and CLS ≈ 0.

---

## 8. Verification plan

**Offline, must run in CI (`node scripts/verify-website.mjs` — extend it):** every local
link resolves; no dead auth/admin routes; no installer link on public pages (exists);
`account.html` contains the email+password bar **and** the GitHub/Google buttons in order;
no page still claims the product is passwordless; every page has a title, favicon, and an
`og:` preview; `/app` keeps its `noindex` and its four required assets.

**Unit (`vitest`, no network):** password rules and weak-phrase refusal; `passwordProblem`
messages surfaced verbatim; register→verify gate ordering; uniform failure responses;
`admin` computed rather than constant (§3.6); reset code single-use and expiring;
`tests/authSurfaceParity.test.ts` — every `api(...)` path referenced by `account.js` and
`dashboard.js` is served by the auth/platform/downloads/gateway routers, mirroring
`tests/userDashboardParity.test.ts`.

**Live (`--with-write`), against the deployment:** extend `scripts/verify-auth.mjs` so the
run covers register → session → `/auth/me` → sign-in → wrong password → throttling →
forgot → reset → old password rejected → new password accepted → session revoked → account
deleted. Keep its discipline: create throwaway `@example.invalid` accounts, delete them in a
`finally`, and print the cleanup counts. Update the check count in
`docs/platform/MANUAL-TODO.md` in the same commit.

**Browser (visible, recorded for the user):** the flow at 390 / 768 / 1440 px in both
palettes, against `scripts/stub-platform-api.mjs` for the states production cannot show you
(suspended, unverified, no release, maintenance) and against production for the states it
can. Any page-level assertion you make in prose should have a screenshot or a status code
behind it.

**Exit-status discipline:** filter output with `set -o pipefail` and read the captured
status; a green tail through a pipe is not a passing step. A check that cannot run (no
mailbox, no provider key) is reported as *not run*, never as passed.

---

## 9. Delivery and deployment

- One commit per concern (API, account UI, design pass, dashboard, copy/legal, docs), each
  with a message that says *why* the change exists. Do not mix a design pass into an API
  commit.
- Update in-commit: `website/README.md` (page inventory, new routes, config), and
  `docs/platform/verification.md` with exactly what was verified and what could not be.
- Site deployment happens on push (Vercel). The **API is not deployed by pushing** —
  `platform/api` ships only via `npm run deploy`; a green CI run does not mean the route
  exists in production. Check `curl -o /dev/null -w '%{http_code}' <api>/auth/me` and treat
  `404` as "not deployed".
- After deploying: re-run `npm run verify:auth -- --with-write`, then report the pass/fail
  counts and the version the gated download serves.
- The installer file itself is public on GitHub — a decision recorded in
  `docs/platform/MANUAL-TODO.md` step 9b. Do not silently change that; if this work revisits
  it, revisit the recorded decision explicitly.

---

## 10. Non-goals

- No desktop app changes beyond keeping its sign-in flow working.
- No new auth providers, no magic-link redesign, no session storage in `localStorage`
  beyond the existing refresh handling, no third-party auth SDK.
- No framework, bundler, CSS preprocessor, webfont or CDN.
- No redesign of `/admin`.
- No change to how installers are hosted or signed (that is MANUAL-TODO 9b).
- No new pricing promises: `pricing.html` may only say what `public.plans` enforces.

---

## 11. Traps that have already bitten this repository

1. **`/auth/password` returning `admin: true` unconditionally** — harmless while it is
   admin-only, an authorization bug the moment members use it (§3.6).
2. **Believing a push deployed the API.** The website deploys on push; the Function does
   not. Four production checks failed for exactly this reason and looked like broken
   features.
3. **Adding passwords without a reset flow** — §3.4, non-negotiable.
4. **Turning the registration response into an account oracle** — §3.5.
5. **Serving a stale installer because GitHub was updated but `public.releases` was not.**
   That is what `npm run release:register` exists for; the gated download served `1.0.4`
   while `1.0.6` was public.
6. **Adding a build step to `website/`.** Vercel's `vercel.json` must keep no build command;
   CI checks `config.js` reproducibility and would break.
7. **Linking an installer from a public page.** `verify-website.mjs` fails the build for it.
8. **Testing "it looks premium" from one screenshot.** Light palette, 390 px and a
   keyboard-only pass are where glassmorphism breaks.

---

## 12. Execution order (each phase ends with its own gate)

| Phase | Work | Gate |
| --- | --- | --- |
| 1 | Migration + credential write path + `register`/`forgot`/`reset` + `admin` flag fix | Unit tests green; `verify-auth --with-write` extended and passing locally against the deployed API after `npm run deploy` |
| 2 | `/account` card: password bar, provider order, reset UI, `?mode=`/`?next=` behaviour | Browser pass at 390/1440, both palettes; parity test green |
| 3 | Design pass on the shared shell + landing | `verify-website` green; contrast measured; no new dependencies |
| 4 | Dashboard download card + security/password panel + honest error states | `/downloads/latest` equality chain proven by `npm run verify:download` |
| 5 | Copy + legal + docs, then the guard tests that keep them true | Full suite, typecheck, CI job green |
| 6 | Deploy (site on push, API via `npm run deploy`), verify live, report | `verify:auth --with-write` and `verify:admin` counts reported honestly |

---

## Appendix A — files this work touches

```
website/index.html, account.html, download.html, app.html, features.html,
        pricing.html, about.html, privacy.html, terms.html, README.md
website/assets/styles.css, app.css, account.js, dashboard.js, theme.js
website/config.js (regenerated, never hand-edited)
platform/api/auth.ts, password.ts, index.ts (CORS allowMethods already lists PATCH/DELETE)
platform/api/downloads.ts (only if the unverified gate needs a new code)
database/migrations/0005_*.sql (credential write path, any new columns)
scripts/verify-website.mjs, verify-auth.mjs, register-release.mjs (compose, don't duplicate)
tests/authSurfaceParity.test.ts, tests/auth.test.ts, tests/password*.test.ts
docs/platform/verification.md, docs/platform/MANUAL-TODO.md, docs/website/premium-rebuild-spec.md
```

## Appendix B — commands

```powershell
npm run dev                              # electron-vite, if the app matters to the change
npx vitest run                           # unit suite
npm run typecheck
node scripts/verify-website.mjs           # offline site check (CI step)
node scripts/stub-platform-api.mjs        # fixture API for the states production cannot show
npx serve website                         # local site on http://localhost:3000
npm run deploy -- --plan                  # what a deploy would change (read-only)
npm run deploy                            # ships platform/api to the Neon Function
npm run verify:auth -- --with-write       # live auth checks, throwaway accounts
npm run verify:admin                      # live control-centre checks
npm run release:register -- --check       # which installer version accounts are handed
```
