# HANDOVER — Alpha AI Workspace

> **This is the continuation file. Read it before changing any code.**
> It is written for an agent with no access to the previous conversation.
> Every claim carries one of these statuses:
>
> **VERIFIED** (implemented and actually tested) · **IMPLEMENTED — NOT VERIFIED** ·
> **PARTIAL** · **NOT STARTED** · **FAILED** · **BLOCKED** (with the reason) ·
> **DEFERRED** (intentionally postponed) · **UNKNOWN — NEEDS VERIFICATION**
>
> Older notes in this repository are superseded where they disagree:
> [HANDOVER_NOTE.md](HANDOVER_NOTE.md) and
> [docs/handover/HANDOVER_SUMMARY.md](docs/handover/HANDOVER_SUMMARY.md) both describe
> the pre-recovery state (they claim commit `4c4321a`, 43 tests, a clean tree). They
> are wrong now. [docs/handover/RECOVERY_REPORT.md](docs/handover/RECOVERY_REPORT.md)
> holds the detailed history of every fix; this file is the current state and the next
> steps.

---

## 1. Project overview and architecture

| Part | Where | Stack | Status |
|---|---|---|---|
| Desktop app | `src/main`, `src/preload`, `src/renderer` | Electron 44 + React 19 + TS, electron-vite | **VERIFIED** working (v1.0.4) |
| Website | `website/` | Static HTML/CSS/ES modules, served by Vercel | **VERIFIED** live |
| Admin portal | `admin/` | Vite + React 19 + TS, static build | **VERIFIED** (control center, see §5) |
| Backend | `platform/api/` | Hono on a **Neon Function** (Node), `pg` pool | **VERIFIED** deployed |
| Database | `database/migrations/` | Neon Postgres, 3 migrations | **VERIFIED** applied |
| Tests | `tests/` | Vitest (72 tests) | **VERIFIED** green |

**Production endpoints**

- API: `https://br-flat-morning-b41hcfhc-api.compute.c-6.us-east-2.aws.neon.tech`
- Website: `https://alpha-website-lime.vercel.app` (Vercel project `alpha--website`, root
  `website`, **no build command** — see §7 "Trap 1")
- Repository: `https://github.com/martinssqeel-maker/Alpha-`, branch `main`
- Neon project `alpha-platform` (`billowing-brook-66269785`), branch `production`

**Identity model.** One `public.users` row per email, three ways to authenticate (Google,
administrator password, emailed one-time link). All three mint the *same* session shape
through one helper in `platform/api/auth.ts`, which is what lets the website and the
desktop app share an account.

**Authorization.** `public.require_admin(perm)` raises unless the caller holds the
permission, and every `admin_*` function calls it. The API never trusts a client-supplied
role; `POST /admin/rpc` builds SQL from the allow-list in `platform/api/adminSignatures.ts`.

---

## 2. Completed and verified (this session)

| # | Change | Status | Evidence |
|---|---|---|---|
| 1 | Website deployments fixed (had failed on **every** push since `4c4321a`) | **VERIFIED** | Vercel `success`; `/account`, `/config.js` went `404 → 200` |
| 2 | Google sign-in, server-side (state signing, code exchange, id_token verification, identity linking) | **IMPLEMENTED — NOT VERIFIED** (see §10, BLOCKED on OAuth client) | everything either side of Google is verified; the Google round trip is not |
| 3 | Administrator email + password sign-in | **VERIFIED** | live login, `/admin/rpc` authorized, non-admin refused, throttled |
| 4 | Administrator password bootstrap script | **VERIFIED** | digest format accepted by the live API |
| 5 | Gated desktop download + `releases` table | **VERIFIED** | `401` anonymous, `403` suspended, `1.0.4` when signed in |
| 6 | CORS wildcard closed (`ALLOWED_ORIGINS=*` → pinned) | **VERIFIED** | smoke went 1 warning → 0 |
| 7 | Maintenance mode, enforced by the API | **VERIFIED** | UI toggle → API answers `503 maintenance` to ordinary sign-ins |
| 8 | Admin Control Center (12 panels, all wired to real RPCs) | **VERIFIED** | driven in a browser against production (see §5) |
| 9 | Download telemetry (`public.downloads`) | **VERIFIED** | one row per signed-in download, shown on the Downloads panel |
| 10 | Session revocation (one session / all sessions) | **VERIFIED** | revoked from the portal, audit row written |
| 11 | Role grant/removal from the portal, with lockout guards | **VERIFIED** | `admin_set_user_admin`, refuses self-removal and last-owner removal |
| 12 | `npm run verify:auth` live verifier | **VERIFIED** | 27/27 with `--with-write`, 8/8 read-only |
| 13 | **Authorization cannot be faked by a client** — a genuine non-admin session gets `403` from `/admin/rpc` and `/admin/system`, and a *correctly signed* token that merely claims `role:admin` is refused too | **VERIFIED** | `verify-auth.mjs` checks 9–10, against production |
| 14 | **Role changes take effect live from the database** — the same session is refused, then allowed after `admin_set_user_admin`, then refused again after revocation | **VERIFIED** | `verify-auth.mjs` checks 11–12 |
| 15 | **Every control in the portal changes real product behaviour** — flag, announcement, app-version setting, maintenance, account status and release are each changed through the portal's own RPC and then read back through the *user-facing* surface (`/platform/config`, `/downloads/latest`, `/auth/request`) | **VERIFIED** | `npm run verify:admin` → 15 passed, 0 failed |
| 16 | `/admin/rpc` status mapping: authorization refusals (`cannot_remove_own_admin`, `cannot_remove_last_owner`) answered `400`; now `403` | **VERIFIED** | `verify-auth.mjs` check 12 went `400 → 403` after the fix and redeploy |
| 17 | Website no longer routes visitors around the gated download: the landing page's "All releases on GitHub Releases" link and the footer "Releases" link were removed, and `download.html` no longer links to the public release page | **VERIFIED** in source; **IMPLEMENTED — NOT VERIFIED** on the live site (needs the commit pushed — see §10.6) | `curl` of the deployed pages still shows 2 GitHub-release links |

| 18 | **Admin visual system rebuilt** — one instrument panel instead of twelve boxed cards, serif plate titles, tabular numerals for every reading, hairlines instead of borders, sticky row actions, a real light palette with a persisted toggle | **VERIFIED** | measured in the live browser: 0 contrast failures in either palette, no horizontal page scroll at 430/820/1440 px, `admin` build exit 0 |

## 3. In progress / partial

- **Cloud AI is not usable.** `507`-style failures are expected: no Neon AI Gateway and no
  provider key is configured, so `/gateway/chat/completions` returns `502
  provider_unavailable`. **VERIFIED** as configured this way; **BLOCKED** on credentials.
- **Email delivery is off.** `EMAIL_PROVIDER=log` writes the sign-in code to the Function
  log and sends no mail while the API still replies "we sent a code". **VERIFIED**
  (deliberate), **DEFERRED** until a domain + provider exist.
- **Desktop Google sign-in.** The API already returns the browser to
  `alpha://auth/callback`, so no desktop change is needed; **IMPLEMENTED — NOT VERIFIED**
  because the Google client is missing.
- **Plans panel** edits entitlements (verified) but has no plan *creation* form. **PARTIAL**.
- **The installer file itself is public. `PARTIAL` — the one real gap in download gating.**
  Our API and our pages are gated (anonymous `401`, suspended `403`, URL only revealed to a
  signed-in active account). But the artifact is a GitHub release asset, and the repository
  is public, so an unregistered visitor can still fetch it directly. Measured anonymously
  on 2026-10-13: GitHub API for the repo `200`, release page `200`, installer asset
  `206` (range request). Nothing in the repo can change this — it is a hosting decision.
  Options: (a) private bucket + short-lived signed URLs served through the API, keeping
  `latest.yml` public for auto-update; (b) make the repo private, which **breaks
  electron-updater** for existing installs unless the updater carries a token; (c) accept
  it and treat the installer as public, gating only the product surface. Recommend (a).
- **No administrator account exists right now.** `select count(*) from public.admin_users`
  = **0**, and `system_settings.bootstrap_admin_email` is `""`. The portal is fully built
  and verified but nobody can sign into it until §10.1 is done. **BLOCKED** (operator).
- **Ordinary users cannot sign in yet.** The only non-admin paths are the emailed one-time
  link (`EMAIL_PROVIDER=log` → no mail is sent) and Google (`google:false`). So today the
  product is usable by *nobody* except an administrator with a password. Both are
  **BLOCKED** on credentials, not on code.

## 4. Not started

- Private installer hosting (R2 + signed URLs) so the GitHub asset stops being publicly
  fetchable — see §3 for the measurements and the three options.
- Per-account usage dashboards, subscription/billing provider integration.
- Desktop-side surfaces for announcements/maintenance banners (the data is delivered in
  `get_my_platform_config`; the UI does not render a dedicated banner yet).
- Admin portal: role *editing* (grant/remove works; choosing between owner/admin/support
  per user is not exposed beyond the role code argument).
- **Website legal + support pages.** `website/` has `index.html`, `account.html` and
  `download.html` and nothing else — no privacy, terms or support/contact page, and the FAQ
  is a section on the landing page. App-store-grade sign-off will want them; nothing in the
  product depends on them today. **NOT STARTED.**

## 5. Admin Control Center (this is the part that replaced the old single-file page)

`admin/src/App.tsx` + `admin/src/styles.css` were rebuilt. Sidebar navigation, sticky
header, stat grids, real tables with search/filter/sort, drawers, modals, confirmation
dialogs, toasts, loading/empty/error states, responsive under 900 px.

| Panel | Backed by | Verified |
|---|---|---|
| Dashboard | `admin_metrics`, `admin_audit_log` | **VERIFIED** (users=6, providers 3/3, models, sessions, downloads) |
| Users | `admin_list_users`, `admin_get_user` | **VERIFIED** (search/filter/sort, drawer loads full account) |
| Downloads | `admin_list_downloads` | **VERIFIED** (rows appear from real downloads) |
| Releases | `admin_list_releases`, `admin_upsert_release` | **VERIFIED** (publish/unpublish, edit modal) |
| AI models | `admin_list_catalog`, `admin_upsert_provider`, `admin_upsert_model` | **VERIFIED** (panel data; enable/disable calls the RPC) |
| Features | `admin_upsert_flag` | **VERIFIED** (toggle writes to the DB) |
| Announcements | `admin_upsert_announcement` | **VERIFIED** (list + editor) |
| Plans | `admin_list_catalog`, `admin_set_plan_feature` | **VERIFIED** (feature edit) |
| System health | `GET /admin/system` (real endpoint) | **VERIFIED** (db latency/size/migration, env presence, auth config) |
| Security | `admin_security_overview`, `GET /admin/system` | **VERIFIED** (admins, refused attempts, live sessions, revoke) |
| Activity log | `admin_audit_log` | **VERIFIED** (filterable) |
| Settings | `admin_set_setting` | **VERIFIED** (JSON editor + maintenance banner text) |

`GET /admin/system` exists because some facts (which env vars are configured) are only
visible to the Function. It sends **names and booleans, never values**.

## 6. Files created / modified this session

**Backend:** `platform/api/{oauth,password,releases,downloads,maintenance}.ts` (new),
`platform/api/{auth,admin,index,adminSignatures}.ts`, `neon.ts`
**Database:** `database/migrations/0002_auth.sql`, `0003_control_center.sql` (new)
**Website:** `website/download.html`, `assets/{session,download}.js` (new),
`account.html`, `assets/{account,app}.js`, `assets/styles.css`, `index.html`,
`config.js` (now committed), `vercel.json` (build command removed)
**Admin:** `admin/src/App.tsx`, `admin/src/styles.css`, `admin/src/supabase.ts`
**Tooling:** `scripts/{admin-password,verify-auth}.mjs` (new), `scripts/verify-admin.mjs`
(new, session 2), `package.json` (+ `verify:admin`)
**Tests:** `tests/auth.test.ts` (new, 16 tests); `tests/adminRpc.test.ts` (10 tests)
**Session 2 (2026-10-13):** `platform/api/admin.ts` (403 mapping), `scripts/verify-auth.mjs`
(checks 9–12 added), `scripts/verify-admin.mjs` (new), `website/index.html`,
`website/download.html` (public release links removed), `package.json`
**Session 2, design pass:** `admin/src/styles.css` (rewritten — tokens, both palettes,
components), `admin/src/App.tsx` (theme state + toggle, environment chip, `th.actions`),
`admin/src/supabase.ts` (exports `apiHost`)
**Docs:** `docs/platform/{environment,MANUAL-TODO,verification}.md`, `website/README.md`,
`docs/handover/RECOVERY_REPORT.md`, this file
**Untouched:** the two document deletions at the repo root (`Ai agent upgrade.docx`,
`premium-ai-workspace-master-prompt.md`) are **not mine** — left uncommitted.

## 7. Traps and root causes worth knowing

1. **A Vercel `buildCommand` broke every deployment for days.** The only diff at the
   failure boundary was `"buildCommand": "node gen-config.mjs"` in `website/vercel.json`.
   The generated file only held a *public* API URL, so `config.js` is committed and the
   command is gone. **Do not add a build command back.**
2. **`neon deploy --env .env.local` is broken on CLI 8.3.5.** Always `npm run deploy`
   (it parses the env file itself and refuses dangerous states).
3. **Deleting a user fails if `audit_logs` rows reference it** (no `ON DELETE`). Delete the
   audit rows first — `verify-auth.mjs` does this in its cleanup.
4. **The desktop app calls the API from the main process**, so CORS never applies to it.
   Pinning `ALLOWED_ORIGINS` cannot break it; a *browser* host not in the list will break.
5. **A raised exception only becomes a `403` if its text matches the pattern in
   `platform/api/admin.ts`** (`forbidden|not_authorized|permission|require_admin|
   cannot_remove_own_admin|cannot_remove_last_owner`). Postgres `raise exception
   'some_new_guard'` otherwise surfaces as `400`. When you add a guard, add its name there
   too — `verify-auth.mjs` check 12 is what caught this.
6. **New admin RPCs must be added to `platform/api/adminSignatures.ts`** or
   `POST /admin/rpc` rejects them (`unknown_function`).

## 8. Tests and commands actually run

```bash
npm run typecheck                 # exit 0
npx vitest run                    # 72 passed (8 files)
npm run verify:auth               # 8 passed, 0 failed  (read-only, safe on prod)
npm run verify:auth -- --with-write   # 27 passed, 0 failed, cleanup 0 leftover
npm run verify:admin              # 15 passed, 0 failed, settings restored, 0 leftover
npm run smoke -- --website https://alpha-website-lime.vercel.app   # 7 passed, 0 warnings
npm run admin:password            # sets an administrator password locally
npm run deploy                    # deploys the Function
node scripts/db-migrate.mjs       # applies database/migrations/*
cd admin && npm run build         # tsc + vite build, exit 0
```

`verify-auth.mjs --with-write` creates two throwaway accounts, proves login/admin/
download/suspension/single-use-code behaviour against production, then deletes them
**including their sessions, credentials, identities and audit rows**. It refuses to run
without `DATABASE_URL`.

`verify-admin.mjs` is the *effects* half: it creates one throwaway administrator and one
throwaway user, then changes a feature flag, an announcement, `desktop_versions`,
maintenance mode and an account status — each through the RPC the portal calls, each read
back through a user-facing surface — and checks the audit log recorded all of it. It then
restores every `system_settings` value to the exact value it found, deletes the temp
accounts, and prints the restored rows so a reader can see nothing was left switched on.

**Session 2 re-ran all of this after its own repair** (earlier passes do not cover later
changes): `npm run deploy` → `verify:auth --with-write` **27/27** → `verify:admin` **15/15**
→ `npm run smoke -- --website https://alpha-website-lime.vercel.app` **7 passed,
0 warnings, 0 failed, exit 0** → a final residue sweep: `0` test accounts, `0` test flags,
`0` test announcements, `maintenance = {active:false,message:""}`, `desktop_versions = {}`,
live gate `401`. Database holds **6 users, 0 administrators**.

## 9. Git and deployment state at handover

- Branch `main`, pushed to `martinssqeel-maker/Alpha-`.
- Latest verified commits: `e52313e` (auth verifier) and the control-center commit that
  follows it. CI and Vercel are `success` on each. `main` is level with `origin/main`
  (`0 0` ahead/behind) at `e52313e`.
- Migrations `0001`–`0003` applied to Neon `production` (`schema_migrations` lists all
  three; 28 `admin_*` functions exist). The Function is deployed — session 2 redeployed it
  after the `/admin/rpc` status fix.
- **Working tree is dirty: the entire Admin Control Center is still uncommitted.** `main`
  does not contain it yet.

```
 D "Ai agent upgrade.docx"               <- not ours, pre-existing, leave alone
 D premium-ai-workspace-master-prompt.md <- not ours, pre-existing, leave alone
 M admin/src/App.tsx            M admin/src/styles.css      M admin/src/supabase.ts
 M package.json                 M platform/api/admin.ts      M platform/api/adminSignatures.ts
 M platform/api/auth.ts         M platform/api/downloads.ts  M scripts/verify-auth.mjs
 M website/index.html           M website/download.html
?? HANDOVER.md (new)            ?? database/migrations/0003_control_center.sql
?? platform/api/maintenance.ts  ?? scripts/verify-admin.mjs
```

  Nothing was committed in session 2 — no commit was authorised. Note the asymmetry: the
  **API** half of session 2 is already live (deployed with `npm run deploy`), the **website**
  half is not (it only reaches production when this tree is committed and pushed).

## 10. Manual actions required from the operator

0. **Create your administrator account — the product currently has none.**
   `public.admin_users` is empty and `bootstrap_admin_email` is blank, so there is no way
   into the control center. Two ways in:

   ```sql
   -- (a) make an account that already exists the owner
   insert into public.admin_users (user_id, role_id)
   select u.id, r.id from public.users u join public.admin_roles r on r.code = 'owner'
    where lower(u.email) = lower('you@example.com') on conflict (user_id) do nothing;

   -- (b) or set the bootstrap so the next sign-in with that email becomes the owner
   update public.system_settings
      set value = '"you@example.com"'::jsonb, updated_at = now()
    where key = 'bootstrap_admin_email';
   ```

   (b) is chicken-and-egg today because that sign-in needs email delivery — use (a), or
   insert the user with `select public.provision_user('you@example.com');` first. Then
   `npm run admin:password` and sign into the portal. Verify:
   `select count(*) from public.admin_users;` → non-zero.
1. **Google OAuth client** — `BLOCKED` until this exists. Steps: `docs/platform/MANUAL-TODO.md` §7b.
   Redirect URI must be exactly
   `https://br-flat-morning-b41hcfhc-api.compute.c-6.us-east-2.aws.neon.tech/auth/google/callback`,
   then `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` in `.env.local` and `npm run deploy`.
   Verify: `GET /auth/providers` → `"google":true`.
2. **Administrator password** — `npm run admin:password` (hidden prompt; nothing printed).
   Until this is set, the portal cannot be signed into except by an admin who already has a
   credential.
3. **Admin host origin** — if the portal is hosted anywhere other than `localhost:5173`,
   add that origin to `ALLOWED_ORIGINS` and redeploy, or the browser blocks its API calls.
4. **Install the desktop build** — `release/Alpha AI Workspace-Setup-1.0.4.exe`
   (125,197,395 bytes). Builds older than 1.0.4 are unusable.
5. **Real email delivery** (before any ordinary user can sign in): set
   `EMAIL_PROVIDER=resend`, `RESEND_API_KEY`, a verified `EMAIL_FROM`, then
   `npm run deploy`. Until then only an administrator with a password can authenticate.
6. **Commit and push the working tree** if you want the fixes live: the API fix is already
   deployed, but the website link fix and the control centre only reach production when
   this tree is committed and pushed (Vercel deploys `website/` from the push; there is no
   build step to run). Do not commit the two deleted documents unless you deleted them.
7. **Host `admin/dist/`** somewhere private and add that origin to `ALLOWED_ORIGINS`
   (`localhost:5173`/`3000` are already allowed for local development).

## 11. The exact next step for the next agent

**Highest priority: make the product usable by a real person.** Right now there is no
administrator account and no way for an ordinary user to sign in, so everything else is
academic. Both halves are operator-credential work (§10.0 and §10.5); the code paths are
tested and ready. If you have no credentials to set, the highest-value *code* task left is
giving the desktop a real announcement/maintenance surface (§3) or private installer
hosting (§4) — pick one, verify it the same way `verify:admin` does, and record the result
here.

Once the credentials exist, finish the Google round trip (10 minutes):

```bash
grep -c GOOGLE_CLIENT_ID .env.local      # 1 when configured
npm run deploy
curl -s https://br-flat-morning-b41hcfhc-api.compute.c-6.us-east-2.aws.neon.tech/auth/providers
# expect {"ok":true,"google":true,...}
# then: browser → /account → Continue with Google → sign in → must land back on /account signed in
# and confirm the account shows up in the admin Users panel with identityProviders ["google"]
```

After that, in priority order: (a) private installer hosting with signed URLs,
(b) plan-creation form + subscription fields, (c) desktop maintenance/announcement banners,
(d) role selection (owner/admin/support) in the user drawer.

**Do not** re-do the website deployment fix, the auth layer or the admin rebuild — they are
verified and live. Extend them.

---

## 12. Session log — 2026-10-13 (second agent, no access to session 1)

**What this session did**, in order, with the evidence:

1. **Confirmed the previous session's claims** rather than trusting them: `git log`,
   `git status`, `npm run typecheck` (exit 0), `npm test` (**72 passed, 8 files**),
   `cd admin && npm run build` (exit 0), `npm run build` / electron-vite (exit 0), all three
   migrations present in `schema_migrations`, 28 `admin_*` functions in the database.
2. **Proved the API obeys the control center's maintenance switch**: toggled it in the
   browser (confirmation dialog → "Go live"/"Disable maintenance mode"), then from the
   shell: ordinary `/auth/request` → `503 {code:'maintenance'}`, administrator password
   login → `200`, and back to `200` for ordinary sign-ins after switching it off.
3. **Extended `verify-auth.mjs` with checks 9–12** (valid non-admin session refused by
   `/admin/rpc` and `/admin/system`; a *correctly signed* token claiming `role:admin`
   refused; role grant/revoke taking effect on a live session; self-demotion refused).
   Found and fixed one real bug: those authorization refusals were reported as `400`.
4. **Wrote `scripts/verify-admin.mjs`** (`npm run verify:admin`) to prove every control has
   a real effect, and ran it against production: **15 passed, 0 failed**, with all settings
   restored afterwards. See §2 rows 13–15 and §8.
5. **Deleted the temporary administrator** used for the browser test early in session 1
   (`verify-admin-ui-…@example.invalid`) — it had been left behind; a full sweep now shows
   **0** accounts left at `@example.invalid`.
6. **Audited the download gate and found a real hole**: the deployed landing page linked
   straight to the public GitHub Releases page, letting a visitor skip the gate. Removed
   those links locally (with the underlying artifact finding written up in §3).
7. **Redeployed the Function** with the `/admin/rpc` status fix (`npm run deploy`).

**Not re-run (state them as prior-session claims):** `npm run smoke:desktop` (drives the
real Electron window over CDP to prove no invisible overlay swallows clicks — the v1.0.3
"frozen app" regression) and `npm run smoke` live. `docs/handover/RECOVERY_REPORT.md`
records desktop-smoke as passing for the current build; this session verified only that the
app *builds* (`npm run build`, exit 0). If you touch renderer overlays, splash, or the
settings/IPC contract, run `npm run smoke:desktop` before believing the fix.

**Attempted and failed:** nothing this session. One test assertion failed on the first run
(an audit action named `user.status` instead of `user.set_status`) — the *script* was wrong,
not the product; corrected and re-run green. A second first-run failure was the same class:
my flag-existence snapshot was taken after creating the flag, so cleanup reported
`test flag removed=false`; fixed to delete any `verify_toggle_%` row.

**Where this session stopped:** after the final green run of `npm run verify:admin` and the
handover edits in this file. Nothing was left half-applied; the database was verified to be
back to its prior settings, and no background process other than the local admin dev server
(`vite`, port 5173) was left running — stop it with Ctrl-C in its terminal when done.

**Unfinished / next:** §3 (public installer artifact, no admin account, no usable user
sign-in) and §10.0 (create the first administrator) — that is the highest-priority item on
the board.

---

## 13. Session log — 2026-10-13, admin design pass

**Brief:** "upgrade admin dashboard to look expensive".

**What was wrong with the old look:** near-black `#0b0d12` with one bright violet accent
and twelve identical rounded cards at the same radius under the same soft shadow. That is
the generic generated-dashboard default, and its glass tell was that every panel competed
for attention equally.

**The direction taken:** treat it as an operator's instrument panel rather than a marketing
dashboard. Graphite planes (`--ink #0c0f14` / `--panel #141922` / `--panel-2 #1b212b`),
hairlines instead of boxes, a serif plate (Iowan/Palatino/Georgia) for the wordmark, page
title and panel titles, and machine-grade tabular numerals for every reading. The twelve
stat cards became **one** divided band, so the readings read as a cluster of instruments
instead of a card kit. Accent is now a state — selection, focus, primary action — not a
wash. Every table gained sticky row actions, so "Details" is never the thing that fell off
a narrow screen.

**Verified, not eyeballed:**

- **Contrast, both palettes, measured in the live DOM** (relative-luminance ratio against
each element's real composited background): **0 failures**. Dark — nav 16.2, reading 14.9,
stat label 5.78, footnote 4.85, group label 5.29, table header 5.30. Light — nav 13.9,
badges 6.0 / 5.8 / 8.1, table header 6.01, body 17.5. Two tokens had to change to get
there: dark `--faint` measured **3.29:1** on a panel (below the 4.5 floor) and the light
green "active" badge measured **3.47:1**; both are darker/lighter now.
- **Layout**, measured with `getBoundingClientRect` at 430 / 820 / 1440 px: no horizontal
  page scroll at any of them; the nav rail becomes a single scrollable row rather than the
  ragged two-column wrap it had; the drawer is exactly 640 px and flush to the edge; the
  sticky action column stays inside the viewport on a 430 px screen.
- `cd admin && npm run build` — `tsc --noEmit && vite build`, **exit 0** (CSS 8.81 → 15.88 kB).
- Reduced motion is honoured; every interactive element has a visible focus ring via
  `:focus-visible`; both palettes are also applied to `color-scheme`, so native scrollbars
  and form controls follow.

**A methodology note worth keeping:** the preview screenshots in this environment are
returned **scaled/cropped** — three times they looked like content was cut off at the right
edge when the DOM measurements proved every element was inside the viewport. Trust
`getBoundingClientRect` for bounds; use the screenshot only for palette and proportion.
A composite measurement that clicked tabs and toggled themes *between* reads also produced
nonsense (`.nav` reported 1.1:1) because it raced the 120 ms colour transitions. Measure one
settled state at a time.

**A throwaway administrator** (`review-admin-…@example.invalid`) was created to see the
populated console, and **deleted afterwards** together with its audit rows: the database is
back to **6 users, 0 administrators, 0 leftover test accounts**.

**Not done:** the portal is still not hosted anywhere (see §10.7), and no automated test
covers the theme toggle. If you extend the palette, re-run the contrast sweep rather than
trusting the colour values.
```

After that, in priority order: (a) private installer hosting with signed URLs,
(b) plan-creation form + subscription fields, (c) desktop maintenance/announcement banners,
(d) role selection (owner/admin/support) in the user drawer.

**Do not** re-do the website deployment fix, the auth layer or the admin rebuild — they are
verified and live. Extend them.
