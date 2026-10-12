# Recovery Report — Alpha AI Workspace (Neon API migration)

Author: coding agent (Buffy)
Date: 2026-10-11
Scope: validate the migration, restore a working desktop build, complete the automatable
verification, and record what still needs a human.

Every claim below is marked **verified**, **failed**, or **NOT RUN**.
The supplied `HANDOVER_NOTE.md` and the professionalized handover report were treated as
claims to test, not as facts.

---

## 1. Repository state (differs from the handover note)

| Item | Handover claim | Actual (verified) |
|---|---|---|
| Branch | `main` | `main` ✅ |
| Commit | `4c4321a` | `4c4321a` ✅ (`Migrate to Neon Function API: …`, 2026-10-11T01:15:27+01:00) |
| Working tree | clean | **NOT clean** ❌ |
| Tests | 43/43 | 43/43 before changes, 46/46 after ✅ |
| Typecheck | passing | passing ✅ |
| Build | passing | passing ✅ |

Pre-existing, not created by this recovery:

```
 D "Ai agent upgrade.docx"
 D premium-ai-workspace-master-prompt.md
?? HANDOVER_NOTE.md
?? docs/handover/
```

These were left untouched (nothing staged, stash, reset, or discarded).

Repo root is `C:\Users\Martins\OneDrive\Documents\ALPHA`.
Note: the tool workspace root is the `ALPHA/.agents` subdirectory, **not** the git root —
paths in commands below are relative to `ALPHA`.

---

## 2. The "frozen desktop" — reported cause not reproduced

**Reported cause:** old packaged build `v1.0.2` running against new code → IPC/platform
contract mismatch → unresponsive UI.

**Verdict: NOT REPRODUCED as described.** An old packaged build executes its own bundled
code; it cannot be made to consume a newer renderer from the checkout. The stated mechanism
is not coherent, and the symptom does not occur with the current build.

Verified by launching the built app and reading the live renderer over the Chrome DevTools
Protocol (`electron --remote-debugging-port=…` + `Runtime.evaluate`):

```
hasBody: true, alphaBridge: "object", hasAppShell: true,
spinnerCount: 0, buttonCount: 29,
showsStarting: false, showsStartupError: false
```

The UI renders fully (sidebar, model `qwen2.5:3b`, conversations, chat suggestions).
No "Starting Alpha…" hang, no startup-error card, zero renderer exceptions.

**What was actually true:** the shipped packaged artifacts are pre-migration (see §3), and a
real in-session defect broke platform onboarding (see §4).

---

## 3. The packaged builds are stale — verified with evidence

All files in `release/` were built 2026-10-10 21:34–21:35, i.e. **before** the migration
commit (2026-10-11 01:15). Proof by content, not timestamps:

| String searched | old `release/win-unpacked/resources/app.asar` | new `out/main/index.js` |
|---|---|---|
| `authRedirectScheme` | **0** | 2 |
| `gateway/chat/completions` | **0** | 1 |
| `platform/config` | **0** | 1 |
| `Alpha Cloud` | **0** | 9 |

The old asar also carries a `package.json` with the pre-migration dependency set (no
`@neon/*`, `hono`, `jose`, `@supabase/supabase-js`).

⚠️ `docs/platform/MANUAL-TODO.md` step 9 tells the operator to install the GitHub `v1.0.3`
release. That asset is a **pre-migration** build. Installing it cannot work with the new
platform contract.

**Correct course taken:** rebuilt from the migrated (and fixed) source — see §7.

---

## 4. Real defect found and fixed — stale `PlatformStatus`

### Symptom
Enable **Settings → Alpha Cloud (platform)**, set the API base URL, open **Account** → the
modal still says *"Alpha Cloud is disabled. Enable the platform and set the API base URL in
Settings → Platform."* and never offers the sign-in form. The stored settings are correct at
the same moment, so the UI contradicts itself and onboarding cannot proceed.

### Root cause
`PlatformService` cached a status snapshot at startup and never re-derived `enabled` /
`configured` from live settings:

- `refresh()`'s "configured but signed out" branch used `{ ...this.cached, configured: true, … }`
  and **omitted `enabled`**, so it kept the startup value `false`.
- `status()` returned the stale cache verbatim, and the renderer's post-save refresh only
  calls `platform:status` (never `platform:refresh`), so nothing corrected it.
- `isActive()` read the stale `cached.configured`, so disabling the platform mid-session did
  not deactivate it.

Evidence, before the fix (same process, settings changed in-session):

```
A. settings:set { platform: { enabled: true, apiBaseUrl: "<verified url>" } }   -> saved
B. platform:status   -> {"enabled":false,"configured":false}   <-- stale, contradicts settings
C. restart the app    -> platform:status -> {"enabled":true,"configured":true}  <-- same settings
```

That restart contrast isolates it as a cache bug, not a persistence bug.

### Fix
`src/main/services/platform.ts`:
- `status()` now derives `enabled` and `configured` from the current settings and forces
  `authenticated: false` whenever the platform is not configured (no contradictory states).
- `isActive()` uses `this.isConfigured() && this.cached.authenticated`.
- `refresh()`'s signed-out branch now also sets `enabled: cfg.enabled`.

### Verification after the fix
Same process, no restart, real UI controls:

```
enable toggle via UI  -> settings{enabled:true} ; status{enabled:true, configured:false}
set URL + real blur   -> settings{enabled:true, apiBaseUrl:"…"} ; status{enabled:true, configured:true}
Account modal         -> hasEmailInput:true, hasSendButton:true, saysDisabled:false, saysNotConfigured:false
disable via UI        -> status{enabled:false, configured:false}   (previously stayed configured:true)
cold restart          -> Account modal offers the sign-in form immediately
```

Regression tests added (`tests/platform.test.ts`, 3 new cases) covering: live re-derivation
without refresh, "configured only when toggle **and** URL are set" (incl. trailing-slash
trim), and `enabled` surviving a signed-out `refresh()`.

---

## 5. 🔴 CRITICAL — production auth bypass (server-side) — **RESOLVED and DEPLOYED**

The deployed Function echoes **live sign-in secrets to unauthenticated callers**.

```
POST https://br-flat-morning-b41hcfhc-api.compute.c-6.us-east-2.aws.neon.tech/auth/request
Origin: https://example.vercel.app          (any origin; CORS reflects it)
{"email":"nobody@example.invalid"}

HTTP/1.1 200 OK
{"ok":true,"message":"We sent a sign-in code to nobody@example.invalid.",
 "expiresInMinutes":10,"devCode":"<redacted>","devMagicToken":"<redacted>"}
```

`platform/api/auth.ts` `/request`:

```ts
if (boolEnv('AUTH_DEV_ECHO_OTP')) {
  payload.devCode = code
  payload.devMagicToken = magic
}
```

`/verify` accepts that `token` and returns `accessToken` + `refreshToken`. Chaining the two
allows signing in **as any email address**, including the bootstrap admin (`provision_user`
grants the owner role to the bootstrap admin email). `ALLOWED_ORIGINS` is unset, so
`allowedOrigins()` returns `'*'` and the endpoint is reachable from any web page.

The chain is proven by the live response plus the `/verify` source. I deliberately did **not**
complete the exchange, to avoid creating a session against a real account.

**Required operator action (cannot be done from this repository):**
1. Set `AUTH_DEV_ECHO_OTP=0` (or remove it) on the deployed Neon Function, and redeploy.
   Re-run the request above and confirm `devCode` / `devMagicToken` are absent.
2. Set `ALLOWED_ORIGINS` to the real website/admin origins instead of leaving it `*`.
3. Because a token was minted for a throwaway address during this test, treat any live
   `auth_otps` rows for it as disposable (or expire them), and review `sessions`.
4. `EMAIL_PROVIDER` still appears to be the `log` driver — the response claims an email was
   sent when none was. Configure Resend before real users sign in.

### Resolution (round 3) — FIXED, DEPLOYED, VERIFIED

`.env.local` was inspected for key *names only* and confirmed to hold both `AUTH_DEV_ECHO_OTP`
(truthy) and `ALLOWED_ORIGINS=*` — the exact configuration behind this leak. The flag was set to
`0` (a copy of the file was backed up outside the repository; no value was printed) and the
Function was redeployed with the owner's explicit approval.

The documented `neon deploy --env .env.local` does **not** work — the CLI (8.3.5) fails to load
the file (`AUTH_JWT_SECRET is required`) with both a relative and an absolute path. The parity
of `--env` is unresolved; the deploy was run with the same variables supplied through the
process environment using a parser that handles the file's CRLF line endings and quoted values
(verified before deploying: 64-char secret, no stray whitespace/CR, which would otherwise have
silently rotated the production signing key).

```
→ Applying to branch production (br-flat-morning-b41hcfhc)
Applied changes
  ~ function api
deploy exit: 0
```

Verification after the deploy:

```
POST /auth/request  {"ok":true,"message":"We sent a sign-in code to …","expiresInMinutes":10}
  occurrences of devCode / devMagicToken: 0        <-- leak closed
GET  /health          -> 200
GET  /platform/config -> 401
GET  /gateway/models  -> 401
POST /admin/rpc       -> 401
```

⚠️ Note for future env edits: deleting `AUTH_DEV_ECHO_OTP` from `.env.local` does **not** clear
it. `neon.ts` only forwards keys that are present, so a removed key is left untouched on the
live Function — it must be set to `0`.

### Still open from this finding

`ALLOWED_ORIGINS` is still `*`, so Hono's CORS reflects any origin (re-confirmed after the
deploy: an `attacker.example` preflight is echoed back). This was left unchanged deliberately:
the real Vercel/admin origins are unknown, and guessing would break the website's own sign-in.
The exposure is bounded — auth is bearer-token only, with no cookies — but it should be set to
the real origins. This is the last item from this finding.

---

## 6. Smoke-test results

| # | Check | Result | Evidence |
|---|---|---|---|
| 1 | Desktop launches without freezing | **PASS** | CDP: app shell rendered, 29 buttons, 0 spinners, 0 exceptions |
| 2 | Basic UI responds (nav, settings, dialogs) | **PASS** | drove Chat/Settings/Account via real clicks; `.page-title` changed each time |
| 3 | Platform settings save + read back | **PASS** | `settings:set` → `settings:get` round-trip; survives restart |
| 4 | Contract `{enabled, apiBaseUrl, authRedirectScheme}` consistent | **PASS** | `Object.keys(settings.platform)` = exactly those three; identical in `types.ts`, `store.ts` defaults, IPC, preload allowlist, renderer |
| 5 | Account offers OTP/magic-link after configuring | **PASS** | `hasEmailInput:true`, `hasSendButton:true` (packaged build too) |
| 6 | Sign-in actually completes (inbox + deep link) | **NOT RUN** | needs the user's mailbox; see §8 |
| 7 | Session persistence across restart | **PASS (partial)** | settings + status correct after cold start; no contradictory state. Not tested with a real signed-in session (blocked by #6) |
| 8 | Authorized `/gateway/*` request | **NOT RUN** | needs a real session. Unauthenticated path verified: `/gateway/models` → 401 `Invalid or expired session.` |
| 9 | Failure handling (bad input, network, expired) | **PASS** | invalid email → typed `invalid_email` rejection; unknown IPC channel → `Blocked IPC channel`; gateway 401 surfaces as an error, no hang |
| 10 | Website account flow | **PASS (static) / NOT RUN (auth)** | serves 200, page renders the email form, `config.js` picked up (no "not configured" notice), CORS preflight 204 + reflected origin. Completing OTP needs a mailbox |
| 11 | Admin dashboard authenticates + loads data | **NOT RUN** | builds + typechecks clean; needs admin credentials |
| 12 | Regression: local Ollama + existing features | **PASS** | `providers:models` → `qwen2.5:3b`; conversations/projects/git providers all reachable via IPC |
| 13 | Empty/normal build launches and behaves the same | **PASS** | packaged `release/win-unpacked/Alpha AI Workspace.exe` reports `appVersion 1.0.3`, same results as the unpacked build |

### Backend reachability (verified)

```
GET  /health          -> 200  {"ok":true,"service":"alpha-platform-api","branch":"production"}
GET  /                 -> 200
GET  /platform/config -> 401  {"ok":false,"error":{"code":"unauthorized","message":"Missing bearer token."}}
GET  /gateway/models  -> 401  {"ok":false,"error":{"code":"unauthorized","message":"Invalid or expired session."}}
```

The recorded API base URL
`https://br-flat-morning-b41hcfhc-api.compute.c-6.us-east-2.aws.neon.tech` **is live and
correct**; protected routes do enforce a bearer token.

---

## 7. Build, test and artifact evidence

| Command | Result |
|---|---|
| `npx vitest run` | 6 files, 43 → **46 passed**, exit 0 |
| `npm run typecheck` | `typecheck:node` + `typecheck:web`, exit 0 |
| `npx electron-vite build` | exit 0 — `out/main/index.js` 170 kB, `out/preload/index.js`, renderer bundle |
| `npx electron-builder --win --publish never` | exit 0 (~95 s) |
| `admin: npx vite build` / `npx tsc --noEmit` | exit 0 / exit 0 |

**Artifacts (version 1.0.3, rebuilt 2026-10-11 02:52):**

- Installer: `release/Alpha AI Workspace-Setup-1.0.3.exe` (125,196,889 bytes)
  — this **replaced** the stale pre-migration file of the same name.
- Unpacked: `release/win-unpacked/Alpha AI Workspace.exe`
- Update manifest: `release/latest.yml` (version 1.0.3, sha512 present)

The rebuilt asar now contains `authRedirectScheme` (×2), `gateway/chat/completions` (×1),
`platform/config` (×1) — the migration is actually inside the package.

`release/`, `out/` and `admin/dist/` are gitignored.

### Caveat: the handover's launch command is not equivalent to the real app

`px electron out/main/index.js` — `px` is not a real binary (`npx …` works). Even corrected,
`electron out/main/index.js` runs **unpackaged**: the app path becomes `out/main`, so
`app.getVersion()` returns the Electron version (`44.7.0`), `app.isPackaged` is false, and
userData is `%APPDATA%\Electron` instead of `%APPDATA%\alpha-ai-workspace`. Settings
configured in that mode do **not** affect the installed app. Use `release/win-unpacked/…exe`
or `npm run dev` instead. For a real userData profile, run the packaged build.

---

## 8. Remaining manual actions (require the user)

- [ ] **CRITICAL** — disable `AUTH_DEV_ECHO_OTP` on the deployed Function and set
      `ALLOWED_ORIGINS`; redeploy; confirm the dev fields are gone (§5).
- [ ] Install the rebuilt `release/Alpha AI Workspace-Setup-1.0.3.exe` (the previously
      shipped v1.0.3 was pre-migration — §3).
- [ ] Sign in: Account → enter email → open the emailed link so the OS hands it to
      `alpha://auth/callback`. **This is the one step that cannot be automated here.**
- [ ] With a session, verify a real `/gateway/chat/completions` streaming reply and that
      usage increments on the Account panel.
- [ ] Website: complete OTP on `/account` against the deployed API (Vercel `API_BASE_URL` is
      already correct in `website/config.js`).
- [ ] Admin: sign in as the bootstrap owner and load Overview/Users/Audit (`/admin/rpc`).
- [ ] Republish the GitHub release asset, or the old pre-migration installer stays available.

---

## 9. Known issues / risks not fixed here

1. **`authRedirectScheme` is dead configuration.** It is in the contract, defaults, tests and
   `PlatformService.authScheme()`, but `authScheme()` is never called. `src/main/index.ts`
   hardcodes `AUTH_SCHEME = 'alpha'`, and `platform/api/auth.ts` hardcodes
   `alpha://auth/callback`. Changing the setting has no effect. Wiring it up is a behavioural
   change (protocol registration happens before settings load) and was left to a deliberate
   follow-up.
2. `src/shared/types.ts` exports `APP_VERSION = '1.0.0'` while `package.json` is `1.0.3`.
   Nothing reads it for display, but it is a latent inconsistency.
3. `admin/package.json` still depends on `@supabase/supabase-js`, which `admin/src/supabase.ts`
   no longer uses (it is now a fetch client). Harmless, but should be removed.
4. `admin/src/supabase.ts` `rpc()` flattens named params into a positional array
   (`Object.values`) — fragile if any admin function takes more than one argument.
5. The updater logs a `404` for `github.com/your-github-username/alpha-ai-workspace/releases.atom`
   in older logs — a placeholder owner from an earlier config. Current `electron-builder.yml`
   points at `martinssqeel-maker/Alpha-`.

---

## 10. Changes made in this recovery (round 1)

| File | Change |
|---|---|
| `src/main/services/platform.ts` | Derive `enabled`/`configured` in `status()`; gate `authenticated`; fix `isActive()`; set `enabled` in `refresh()`'s signed-out branch |
| `tests/platform.test.ts` | +3 regression tests (43 → 46) |

No secrets, tokens, API keys or magic-link values were written into this report, the
repository, or any log.

---

## 11. Round 2 — fixes for every issue flagged above

### 11.1 Renderer never seeded platform state on startup (flaky onboarding) — FIXED

Reproduced while re-testing: on some launches the Account modal showed *"Alpha Cloud is
disabled"* while `platform:status` returned `enabled:true, configured:true` for the same
process. Root cause: `useApp.init()` only **subscribed** to the `evt:platform` push event and
never pulled the current status. `PlatformService.restore()` emits that event from the main
process shortly after the window is created, and IPC events are not replayed — when the emit
landed before the renderer subscribed, the store kept its `enabled:false` default until the
user toggled something. `src/renderer/src/store/useApp.ts` now calls `refreshPlatform()`
during `init()`, so state is seeded from the authoritative source regardless of event timing.

Verified with three consecutive cold starts (previously timing-dependent):

```
run 1: {"status":"true/true","modal":{"hasEmailInput":true,"saysDisabled":false}}
run 2: {"status":"true/true","modal":{"hasEmailInput":true,"saysDisabled":false}}
run 3: {"status":"true/true","modal":{"hasEmailInput":true,"saysDisabled":false}}
```

### 11.2 Admin dashboard RPC mapped arguments by position — FIXED

`admin/src/supabase.ts` flattened named parameters with `Object.keys(...).map(...)`, so a call
only worked if the caller's key insertion order happened to match the Postgres signature. Two
call sites in `App.tsx` were already broken against the server's declared arity
(`admin_set_user_plan` sent 2 of 4, `admin_upsert_flag` sent 3 of 4), and those calls would
have been rejected with `bad_args`.

The allow-list now carries each parameter's **name**, cast and whether it has a default, in a
dependency-free module (`platform/api/adminSignatures.ts`) with a pure `buildAdminCall()`.
Calls are built with Postgres named-argument notation
(`public.admin_set_user_plan(p_user => $1::uuid, p_plan_code => $2::text)`), so key order is
irrelevant and parameters with a server-side default can simply be omitted. Unknown parameter
names, missing required parameters and short positional lists are rejected with a specific
error code instead of silently shifting arguments. The admin client now sends
`{ fn, params }`; the positional `{ fn, args }` form is still accepted.

New `tests/adminRpc.test.ts` (10 cases) covers ordering, defaulted parameters, explicit `null`
vs `undefined`, missing/invalid names, positional arity, and asserts every entry in
`ADMIN_SIGNATURES` builds and declares no duplicate parameter names.

### 11.3 The backend was never typechecked — FIXED

`platform/**` and `neon.ts` were absent from every tsconfig, so the whole API could drift with
no compiler check. They are now included in `tsconfig.node.json`. Two latent errors surfaced
and were fixed rather than suppressed:

- `platform/api/db.ts` — `pg` had no type declarations; added `@types/pg` as a devDependency.
- `platform/api/auth.ts` — `/verify` used `'error' in result` narrowing, which left
  `result.error` possibly `undefined` at the map lookup. The outcome is now an explicit
discriminated union (`ok: false as const, error: …` / `ok: true as const, …`), which also
  removed the `Record<string, …>` cast on the message table.

`npm run typecheck` now passes with `platform/**` included.

### 11.4 `authRedirectScheme` was dead configuration — FIXED

The setting existed in the contract, defaults and tests, and `PlatformService.authScheme()`
was defined, but nothing called it: `src/main/index.ts` hardcoded `alpha` for both
`setAsDefaultProtocolClient` and the deep-link guard. The main process now registers and
matches the **configured** scheme (validated against `/^[a-z][a-z0-9+.-]*$/`, falling back to
`alpha`), and registration moved inside `whenReady` so the setting is actually loaded first.

Verified: with the default `alpha`, the Windows handler is registered as
`"…\electron.exe" "…\out\main\index.js" "%1"`. Note the installer independently registers
`alpha` via `electron-builder.yml` `protocols`, and the server emits `alpha://auth/callback`
unless `WEB_ACCOUNT_URL` is set — changing this setting therefore also requires matching
server/installer configuration.

### 11.5 Other cleanups

| File | Change |
|---|---|
| `platform/api/auth.ts` | Dev code/token echo now also requires `NODE_ENV=development`, so a deployed Function cannot leak sign-in tokens even if the flag is left on |
| `src/shared/types.ts` | `APP_VERSION` was `'1.0.0'` while the app is `1.0.3`; now matches, with a note that `app.getVersion()` is authoritative |
| `admin/src/supabase.ts` | Removed the commented-out reasoning block that documented the old flattening hack |
| `admin/package.json` (+ lockfile) | Dropped the unused `@supabase/supabase-js` dependency (the admin client is a fetch wrapper) |
| `tsconfig.node.json` | Added `platform/**/*.ts` and `neon.ts` to the checked set |
| `docs/platform/MANUAL-TODO.md` | Added step 1b covering the API sign-in-token leak and the CORS wildcard |

### 11.6 Post-round-2 verification

| Command | Result |
|---|---|
| `npx vitest run` | 7 files, **56 passed** (was 46), exit 0 |
| `npm run typecheck` (now incl. `platform/**`, `neon.ts`) | exit 0 |
| `npx electron-vite build` | exit 0 |
| `admin: npm run build` (tsc + vite) | exit 0 |
| `npx electron-builder --win --publish never` | exit 0 |
| Cold-start ×3 on the rebuilt app | Account modal offers sign-in every time |

### 11.6b Round 3 — the backend fix was deployed

`AUTH_DEV_ECHO_OTP=0` was set and the Function redeployed (see §5). The sign-in-token leak is
**closed in production and verified**. `ALLOWED_ORIGINS` remains `*` and needs the real origins
before it can be tightened.

### 11.6c Round 4 — the frozen workspace (reproduced, fixed, verified)

**Symptom.** The window opened and rendered correctly, but nothing responded: no button
clicks, no typing, Settings would not open. Only closing the window worked.

**Root cause.** `src/renderer/src/App.tsx` armed both splash timers in one effect and listed
`splashPhase` in its dependency array. The moment the first timer flipped the phase to
`'leaving'`, the effect re-ran, its cleanup cancelled the still-pending `'done'` timer, and the
guard (`splashPhase !== 'show'`) refused to re-arm it. `.splash` is
`position: fixed; inset: 0; z-index: 999` with no `pointer-events` rule, so the overlay stayed
mounted at `splash-leaving` — `opacity: 0`, invisible, and above every control in the window.
Captured from the live renderer: `document.elementFromPoint(<Settings button>)` returned
`splash splash-leaving`, and `.splash` never unmounted.

**When.** Commit `347a057` "Add launch splash animation" (2026-10-10 18:42) introduced it. The
app log shows the last successful interaction at 16:46 and then 8+ relaunches from 20:05 onward
that only ever reach `database opened` — consistent with the app being unclickable ever since.
The Neon migration (`4c4321a`, 01:15 the next day) is **not** the cause, though the separately
installed build predates it (see below).

**Fix.** One timer per phase (cleanup can then only cancel the *next* pending step), plus a
bounded hold when startup is slow, plus `pointer-events: none` on `.splash` so a decorative
overlay can never swallow input again.

**Verified** on the packaged build (`release/win-unpacked`), against the real profile, with
`npm run smoke:desktop`: 12/12 checks pass, twice in a row, and 16/16 with `--stall-init`
(fault-injected stalled startup). Before the fix the same script failed on "launch splash leaves
the screen", "no overlay covers the sidebar", typing, the send button and Settings — the test
demonstrably detects the defect it guards.

### 11.6d Round 5 — seven IPC channels rejected before their handler

**Symptom.** Git status/branches/remotes and the checkpoint list never populated, and the chat
**Stop** button did nothing. Nothing appeared in the UI, because every affected caller either
ignores the rejection or shows a generic failure.

**Root cause.** `shared/ipc.ts` (`IpcContract`) is the contract both sides are written against,
and it asks these channels for a key that is not `id` — `{ requestId }`, `{ runId }`,
`{ projectId }`. The main process validated all seven with `zId` (`{ id }`) and then read `.id`,
so zod rejected every call as `Invalid request: Required`. The `(p as { id: string })` casts were
the tell. Log evidence: `Error occurred in handler for 'git:status': Invalid request: Required`.

| Channel | Contract | Was validated as |
|---|---|---|
| `chat:cancel` | `{ requestId }` | `{ id }` |
| `terminal:cancel` | `{ runId }` | `{ id }` |
| `edit:checkpoints` | `{ projectId }` | `{ id }` |
| `git:status`, `git:branches`, `git:remotes`, `git:init` | `{ projectId }` | `{ id }` |

**Fix.** `zRequestId` / `zRunId` / `zProjectId` added to `shared/schemas.ts` to mirror the
contract, and the seven handlers switched over (casts removed). No renderer change was needed —
the renderer was already correct.

**Verified** in the packaged 1.0.4 build by `npm run smoke:desktop`, which now invokes each
keyed channel through the preload bridge: `IPC request-key contract` passes for all seven and
`git status answers for a real project` returns a real `GitStatus`. The app log for the run
contains **zero** `Invalid request` lines (the only handler errors are the deliberate bogus-id
probes returning `Project not found`).

### 11.6e Artifacts (1.0.4)

Version bumped to `1.0.4` in `package.json`, `package-lock.json` and `APP_VERSION`, because
electron-updater compares versions: shipping the fix as `1.0.3` would never be offered to
anyone already on `1.0.3`. Built (not published):

- Installer: `release/Alpha AI Workspace-Setup-1.0.4.exe` (125,197,395 bytes)
- Unpacked payload: `release/win-unpacked/` — FileVersion `1.0.4`
- Update manifest: `release/latest.yml` (version 1.0.4, sha512 present)

Verified by running the **packaged** app (not dev): `npm run smoke:desktop -- --stall-init --chat`
→ **20/20**, including a real streamed model reply. The installer wraps that same payload; the
installation itself was left to the operator.

**Published** with `node scripts/ensure-release.mjs` (the idempotent half of `npm run release`,
run against the already-verified installer rather than rebuilding). Release `v1.0.4` is public
and points at commit `e16c7b3`: exe 125,197,395 bytes, blockmap, and a `latest.yml` whose
sha512 is byte-identical to the installer that passed the desktop checks — so what auto-update
downloads is the build that was actually driven. `v1.0.3` and earlier are untouched.

⚠️ `release/Alpha AI Workspace-Setup-1.0.3.exe` and everything older still contains the stuck
splash overlay from §11.6c. Anyone still on 1.0.3 gets 1.0.4 from auto-update now; do not
install or distribute the older installers by hand.

### 11.7 Still open

- `ALLOWED_ORIGINS=*` — needs the real website/admin origins, then a redeploy (§5).
- `neon deploy --env <file>` is broken in CLI 8.3.5; the deploy was worked around by passing the
  variables through the environment. Worth re-checking on the next CLI upgrade.
- The rebuilt admin RPC path could not be exercised end-to-end: it needs an authenticated admin
  session. Only the pure call-building logic is covered by tests; the HTTP round-trip against
  the deployed `/admin/rpc` is unverified (it does correctly return `401` unauthenticated).
- Sign-in, a live `/gateway/chat/completions` reply and the website/admin auth flows still
  require the user's mailbox and admin credentials (§8).

### 11.6f Round 5 — the website was never deploying (fixed, verified)

**Symptom.** The site's account portal answered `404` in production even though it was
committed and the docs described it as deployed. Vercel reported `failure` for every
production deployment since `4c4321a`, so the live site was still the build of `62571c7`.

**Cause.** Between the last successful deploy (`62571c7`) and the first failing one
(`4c4321a`), the *only* change to `website/vercel.json` was one added line:
`"buildCommand": "node gen-config.mjs"`. Everything else in that commit was inert static
files. The command itself ran fine locally and in CI, but defining it made the host's build
fail; the failure details sit behind the Vercel account, so the conclusion rests on the diff
at the failure boundary plus the result of removing it.

**Fix.** The generated config only ever contained a public API base URL, so there was no
reason for it to require a build step: `website/config.js` is now **committed** (generated by
the project's own `gen-config.mjs`, so the format is identical), the generator takes an
optional output directory so CI exercises it into a temp dir instead of rewriting the tracked
file, and `vercel.json` is back to byte-identical (`bb1f31d`) to the version that last
deployed successfully.

**Verified** on `07e3801`: Vercel → `success` (every earlier commit → `failure`); live
`/`, `/account`, `/config.js`, `/assets/account.js`, `/assets/styles.css` → `200` with correct
content types; the deployed `config.js` carries the production host; the account page renders
its sign-in form in a real browser with no console errors, and its cross-origin calls reach
the Function (`/platform/config` → `401` unauthorized, `/auth/request` with a malformed email
→ `400 invalid_email`, preflight `204` allowing `Authorization` + `Content-Type`);
`npm run smoke -- --website https://alpha-website-lime.vercel.app` → 7 passed, 0 failed.

Not covered: the emailed sign-in link itself still needs a real mailbox (§11.7).

### 11.6g Round 6 — identity, administrator access and a gated download

**What was missing.** One sign-in method (emailed one-time codes), no way for the owner to
reach the admin portal without a mailbox, and a download button that linked straight to a
public release asset.

**Added, on top of the existing accounts rather than beside them:**

| Area | Change |
|---|---|
| Google sign-in | `GET /auth/google/start` → Google → `GET /auth/google/callback`, all server side: signed state, PKCE-free code exchange, id_token verified against Google's JWKS (issuer, audience, nonce, `email_verified`). The identity is linked by verified email via `public.link_identity`, so a Google sign-in lands on the account that already owns that email instead of forking a second one |
| Sessions | Every path (OTP, Google, password) mints the same session through one helper, and a web return hands the browser a single-use code it exchanges over `POST /auth/oauth/exchange` — no session token in a URL or in history |
| Desktop | A Google callback aimed at the app redirects to the existing `alpha://auth/callback` magic-link shape, so the installed app needs no change |
| Admin password | `POST /auth/password`; scrypt digests seeded by `npm run admin:password` (no API can write that table). Database-enforced admin role, per-email and per-address throttling, one generic failure message, audit row per successful login |
| Downloads | `GET /downloads/latest` backed by a new `releases` table (seeded with 1.0.4): `401` anonymous, `403` suspended, otherwise the release metadata. `/download.html` is the gated page; the landing CTA points at it instead of at GitHub |
| CORS | `ALLOWED_ORIGINS` pinned to the website origin — the long-open wildcard finding is closed |

**Verified** (all against the deployed Function, commit `e371caa`): `npm run verify:auth` →
8/8 read-only checks, then `--with-write` → 15/15 including administrator password sign-in,
`/admin/rpc` returning `users=8`, `/downloads/latest` → `1.0.4` (125197395 bytes), a
non-administrator refused on the admin path, a suspended account refused (`403` download,
`401` login), and a code that exchanges once and cannot be replayed — with both throwaway
accounts and every trace of them removed afterwards. Browser: `/download` shows the sign-in
prompt while signed out, then `Version 1.0.4 · Installer · 119 MB · SHA-512` and the
installer link once signed in. Unit tests 72/72, typecheck 0, admin build 0, `npm run smoke`
7/7 with the CORS warning now gone, Vercel `success` on the push.

**Not verified: the Google round trip itself.** No OAuth client exists yet, so the button is
testable only after §7b of the runbook supplies `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`.
Everything either side of Google is verified, including the redirect-target allow-list
(which refuses a foreign host) and the code exchange that follows the callback.
