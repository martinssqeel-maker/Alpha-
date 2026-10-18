# Platform verification

## Automated, local (no backend needed)

```bash
npm run typecheck   # tsc --noEmit over src/**, platform/**, neon.ts, renderer
npm test            # vitest: permissions, pathGuard, providers, store, gateway, platform, adminRpc
npm run build       # electron-vite build → out/
cd admin && npm run build   # tsc --noEmit && vite build
```

`tests/platform.test.ts` covers deep-link parsing, encrypted session storage
(round-trip plus ciphertext-at-rest) and `PlatformStatus` re-deriving `enabled` /
`configured` from live settings without a restart.
`tests/gateway.test.ts` covers OpenAI-compatible SSE parsing including streaming
tool-call deltas. `tests/adminRpc.test.ts` covers the named-argument call builder
(key order, defaulted parameters, arity, unknown names).

CI (`.github/workflows/ci.yml`) runs all of the above on every push and PR, plus a
guard that refuses a tracked `.env` / `.env.local` / `secrets.enc`.

## Live checks (safe against production)

Both scripts below only make unauthenticated, read-only requests unless you opt in.

```bash
npm run deploy -- --check     # validate .env.local: presence, empty values, dev-echo, CORS, email
npm run deploy -- --plan      # read-only diff of what a deploy would change
npm run smoke                 # liveness, auth rejection, input validation, CORS probe
npm run smoke -- --website https://<site>     # + website config.js is configured
npm run smoke -- --email you@example.com      # + sign-in path leaks no code/token
```

Two deeper live checks need a database connection (`DATABASE_URL`); they create throwaway
accounts and delete them again, so they are still safe to point at production:

```bash
npm run verify:auth -- --with-write   # 44 checks: identity, authorization, gating, replay, passwords
npm run verify:admin                  # 15 checks: every portal control has a real effect
```

`verify:auth` proves the *authorization* boundary: an ordinary session is refused by
`GET /admin/overview` and `GET /admin/system`, a correctly signed token that merely claims
`role:admin` is refused too, a role granted in the database lets the *same* session through
until it is revoked, and an administrator cannot strip its own rights.

`verify:admin` proves the *effects* boundary — that no control in the portal is decorative.
Each one is changed through the REST route the portal's own JavaScript calls and then read
back through the surface a user sees:

| Control | Changed via | Read back through |
| --- | --- | --- |
| Feature flag | `POST /admin/flags` | `GET /platform/config` → `flags` (present when on, absent when off) |
| Announcement | `POST /admin/announcements` | `GET /platform/config` → `announcements` |
| Application version / minimum | `POST /admin/settings` (`desktop_versions`) | `GET /platform/config` → `desktop` |
| Maintenance mode | `POST /admin/settings` (`maintenance`) | `POST /auth/request` → `503 maintenance` carrying the admin's own message, while an administrator still gets `200` |
| Account status | `POST /admin/users/:id/status` | `GET /downloads/latest` → `200` → `403` → `200` |
| Release | `GET /admin/releases` | `GET /downloads/latest` → the published version |
| Audit trail | all of the above | `GET /admin/audit` contains each action, and no key/hash material |

Before it changes anything, `verify:admin` probes every route above with its ordinary
throwaway session: an existing route answers `403`, a route that has been renamed or removed
answers `404`, and the run stops rather than reporting fifteen failures that describe the
script. `tests/adminRouteParity.test.ts` makes the same guarantee without a deployment — it
extracts the routes named by both verification scripts and asserts the admin router mounts
each one, and that the retired `admin/rpc` endpoint is still gone.

It restores every `system_settings` value it touched and prints the restored rows, so a run
leaves no switch flipped. `verify:admin` needs `DATABASE_URL`; `verify:auth` needs it only
for `--with-write`.

`npm run smoke` passes/fails per check and exits non-zero on any failure. Expected
shape of a healthy API:

| Check | Expected |
| --- | --- |
| `GET /health` | `200 {ok:true, service:"alpha-platform-api", branch:"production"}` |
| `GET /platform/config` | `401 unauthorized` |
| `GET /gateway/models` | `401 unauthorized` |
| `GET /admin/overview` | `401 unauthorized` |
| `POST /auth/request` with a malformed address | `400 invalid_email` (validation runs before any mail) |
| CORS probe from a foreign origin | must **not** reflect that origin — a reflection means `ALLOWED_ORIGINS` is unset/`*` |
| `POST /auth/request` with `--email` | `200` with **no** `devCode` / `devMagicToken` in the body |

## Desktop window interactivity (needs a running app)

A renderer can paint a perfect window that ignores every click, so "it built" and "it looks
right" prove nothing. `scripts/desktop-smoke.mjs` drives the real window over the Chrome
DevTools Protocol — real mouse events and real keystrokes — and fails if any control is covered:

```bash
npx electron . --remote-debugging-port=9222      # or the packaged exe
npm run smoke:desktop                            # --port 9222 by default
npm run smoke:desktop -- --port 9223 --stall-init --chat
```

| Check | Expected |
| --- | --- |
| launch splash | `.splash` unmounts — it is a full-window overlay, so a stuck one blocks every click |
| overlay probe | `elementFromPoint` over the Settings button returns that button, not an overlay |
| typing | a real `Input.insertText` lands in the prompt and enables Send |
| clicking | a real click on Settings changes the view and renders its sections |
| IPC | `platform:status` round-trips through the preload bridge |
| IPC request-key contract | every channel keyed by something other than `id` (`git:status`/`branches`/`remotes`/`init`, `edit:checkpoints`, `terminal:cancel`, `chat:cancel`) reaches its handler — a wrong schema rejects it with `Invalid request`, which the UI swallows |
| Account | the panel opens and dismisses from the backdrop |
| `--stall-init` | with startup broken on purpose, the splash still clears and the sidebar still takes clicks |
| `--chat` | a prompt round-trips and a *settled* reply renders (opt in — it writes to history) |

Exit status is 0 only when nothing failed. Two silent-failure bugs of this shape have already
shipped (a persisted collapse state and a stuck splash), so treat a failing desktop check as a
release blocker rather than a UI nit.

## Against the database

Run in the Neon SQL editor (or `psql "$DATABASE_URL_UNPOOLED"`):

1. **Provisioning** — after a first sign-in, `public.users` has the row, a `free`
   subscription exists, and `select public.is_admin(<uid>)` is true only for the
   bootstrap owner.
2. **Config contract** — `select public.get_my_platform_config();` returns plan, limits,
   usage, models and features shaped exactly like `PlatformConfig` in
   `src/shared/types.ts`. `set_config('app.user_id', …)` is required for the caller
   context; run it inside a transaction.
3. **Entitlements** — `select public.check_entitlement(<uid>, 'cloud_models')` flips to
   true after an `entitlement_overrides` row or a plan change, false after
   `admin_revoke_override`.
4. **Admin authorization** — calling an `admin_*` function as a non-admin raises
   `forbidden`, and a successful admin write appends an `audit_logs` row.
5. **Secrets are hashed** — `select * from public.auth_otps` and `public.sessions` must
   never contain a raw code, magic token or refresh token, only hashes.

## Desktop end-to-end

1. **Settings → Alpha Cloud**: enable, set the API base URL, save.
2. **Account**: enter an email → *Send sign-in link*. Open the link from the inbox; the
   app focuses itself and shows email / plan / usage.
3. Models page now lists cloud models under **Alpha Cloud**.
4. Send a prompt to a cloud model → the reply streams and usage rises on the Account
   panel after **Refresh** (requires provider keys or the Neon AI Gateway).
5. A model outside the plan is blocked by the UI *and* by the server
   (`403 model_not_allowed`).
6. Sign out → the Alpha Cloud provider and its models disappear.

## Website

- `/account` loads with the email form (the committed `config.js` supplies the API
  host); after sign-in, plan/usage/models render. A site whose `config.js` is empty
  shows the honest "not configured" notice instead.
- The page's API calls must pass CORS from the site origin: preflight on `/auth/request`
  should answer `204` with `access-control-allow-origin: <site>` and
  `access-control-allow-headers: Authorization,Content-Type`.
- Verify programmatically with `npm run smoke -- --website <url>` and
  `npm run verify:auth`. The latter is read-only by default (capability endpoints, the
  anonymous `401` on `/downloads/latest`, the foreign-redirect refusal, and CORS for both an
  allowed and a foreign origin). Add `-- --with-write` to also create two throwaway
  accounts, prove administrator password sign-in, `/admin/*` authorization, the gated
  release, suspension and single-use code replay, then delete them again. It mints its
  sessions through the API's own one-time-code exchange, so it needs no mailbox.
- **Run 2026-10-17 against production: 30 passed, 0 failed**, after `npm run deploy`.
  Notable passes: `a signed-in account gets the release metadata — version=1.0.6` (a real
  session created through the API's own one-time-code exchange, reading the real
  `/downloads/latest`), `CORS preflight allows PATCH and DELETE`, `an administrator cannot
  remove its own admin rights — 409 cannot_remove_own_admin`.
- **The same script run before that deploy scored 26 passed, 4 failed**, and all four were
  one cause: the Function was older than `main`. It answered `404` for `/auth/me` and
  `/auth/sessions`, its preflight allowed only `GET,POST,OPTIONS`, and it lacked the
  message-first mapping in `describeAdminError` (asserted by `tests/adminErrorMap.test.ts`),
  so a self-demotion answered `403 forbidden` instead of `409`. Nothing was wrong with the
  code — it had never been shipped. Re-run this script after any deploy to `platform/api`;
  these four lines are exactly what "the backend is behind" looks like.

### Account dashboard (`/app`)

The signed-in dashboard is static JavaScript against five read endpoints and three
self-service routes. What was checked, and how:

| Check | How |
| --- | --- |
| Every dashboard call is served | `tests/userDashboardParity.test.ts` reads `website/assets/dashboard.js`, extracts every `api(...)` path, and fails if the auth/platform/downloads/gateway routers do not serve it (and asserts `PATCH /auth/me`, `DELETE /auth/sessions/:id`, `POST /auth/sessions/revoke-others` by method) |
| Session liveness rule | `tests/sessionPolicy.test.ts`: revoked, expired, missing row, exactly-at-expiry and camelCase shapes |
| Layout, empty states, interactions | Browser run against `scripts/stub-platform-api.mjs` at 1280 and 390 px: overview, security, usage, models, downloads; profile rename; revoke another session; signed-out redirect to `/account?next=app` |
| Revoked sessions stop working | `requireLiveSession` on `/platform`, `/downloads`, `/gateway`, `/admin` and the self-service routes answers `401 session_ended` on the next request. **Not verified against production** — it needs a live session |
| Real data | Rendering was checked against the stub only. The one production check with a real session is `/downloads/latest` (see the `verify:auth` run below), which now answers `1.0.6` |
| The version the dashboard offers | `npm run release:register -- --check` compares the GitHub asset's length with the local installer and prints what it would register; the write path then prints what `/downloads/latest` answers |

CORS: the dashboard uses `PATCH` and `DELETE`, so `allowMethods` in `platform/api/index.ts`
lists both. Without them the browser's preflight fails before a handler runs — this was
caught in the browser run against the stub and fixed in both places.

The stub is QA-only and holds fixture data; it is never used by the site or a deployment.

## Member passwords (shipped 2026-10-18)

Email + password replaced nothing: the emailed code, Google and GitHub all still work, and
the desktop app's `alpha://auth/callback` handoff is untouched. What is new is `register`,
password `sign-in` for members, `forgot`/`reset`, and `change` from the dashboard, plus the
`public.users.email_verified_at` marker that gates the installer.

| Check | Where it is proven |
| --- | --- |
| Validation answers before any database work: bad address, short password, weak phrase, surrounding whitespace, non-numeric code | `tests/memberPasswords.test.ts` (11 tests, no database) |
| The whole lifecycle against production | `npm run verify:auth -- --with-write` — **44 passed, 0 failed**: sign-up (202, no session), an identical answer for a second address, `email_verified_at` still null, member sign-in with `admin:false`, `403 email_unverified` on the installer, the code confirming the address, the installer then served at `1.0.6`, `change` revoking other sessions, the replaced password refusing, `forgot` answering 202, the reset code setting a password, and that code refusing a replay |
| An account with no credential cannot sign in with one | the same run (`401`) |
| The site offers the password path in the promised order and no longer claims to be passwordless | `node scripts/verify-website.mjs` — new guards for `/auth/register`, `/auth/password/forgot`, `/auth/password/reset`, GitHub before Google, and the absence of "no password to remember" / "passwordless" claims |
| A password sign-in is not a mailbox proof | `verificationProblem()` in `platform/api/releases.ts`, asserted in `tests/memberPasswords.test.ts` |

**Not verified here:** that a real person receives the confirmation code. The run mints the
code row directly, because delivery needs a mailbox — and `EMAIL_FROM` needs a verified
Resend domain before any address other than the operator's can receive one (see
`docs/platform/MANUAL-TODO.md` §5). Registration, sign-in and the download gate are all
proven regardless, because none of them depends on the mail arriving.

**Migration 0005** adds `email_verified_at`, backfilled from `last_sign_in_at` for every
existing account so nobody lost download access, plus `set_password_credential()` — the
first server-side write path to `password_credentials`, which 0002 recorded as
operator-only.

## Sign-up collects a name and a phone number (2026-10-18)

The sign-up card asks who the account belongs to before it asks for credentials, and a
rejected field is marked where it is rather than only in a line at the bottom of the card.
The rules live in `platform/api/profile.ts` so the API, the card's own copy of them and the
tests cannot drift apart.

| Check | Where it is proven |
| --- | --- |
| A name or number is normalized and its rules stated once | `tests/profile.test.ts` (10 tests, no database): tabs and newlines become spaces, control characters dropped, names in any script, the same 80-character cap the form prints, `+1 (555) 010-2030` → `+15550102030`, 7–15 digits |
| Sign-up refuses a missing name or an impossible number before any database work | `tests/memberPasswords.test.ts` (`400 invalid_name`, `400 invalid_phone`) |
| The name and number reach the account row | `npm run verify:auth -- --with-write` gained three checks for this: no name → `400 invalid_name`, `phone: '555'` → `400 invalid_phone`, and `full_name`/`phone` stored on the new row. **Not yet run against production** — the run needs `--with-write` and a live database, and the three new lines are unproven until then |
| The card keeps a place to mark each field | `node scripts/verify-website.mjs` now fails if the `data-field-error` slot for name, email, phone, password or code is gone, or if the six-digit well moves below the provider buttons |
| Where a failure appears | Browser run against `scripts/stub-platform-api.mjs` at 1280 and 390 px, in both palettes: an empty submit marks all four fields at once with `aria-invalid`, typing in a field clears its own message, `401 invalid_password` from the server lands under the password field (not in the status line), the `202` reveals the code well directly under the button with the address it was sent to, and a refused code shows the server's own sentence there |

**Migration 0006** adds `public.users.phone`, nullable, because every account that exists
today arrived by an emailed code or a provider and never filled a form. It is contact
information, not a second factor: nothing sends SMS, so there is no "verified" flag that
would imply a check took place. It is **pending on `production`** — run `npm run db:migrate`
before deploying the API that writes the column (see `docs/platform/MANUAL-TODO.md` §2).

## Admin dashboard

- Sign in with an administrator email and password. Overview shows counts; Users changes
  status/plan and grants overrides; every action appears under Audit.
- `npm run verify:admin` is the programmatic form of the checklist above — if a control is
  added to the portal, add its effect there, because "the button calls an RPC" is not the
  same claim as "the product changed".

## What cannot be verified here

Signing in needs a real mailbox and an authenticated session, and the gateway needs a
provider credential. Those steps are listed in `docs/platform/MANUAL-TODO.md` and are
the only ones that require a human.

## Deployed vs committed

A green CI run proves `main` builds, not that production runs it. On 2026-10-17 the
website had picked up `522d32f` (Vercel deploys on push — `/app` answers `200`) while the
Function had not: `npm run deploy` is the only thing that ships `platform/api`, and
`npm run deploy -- --plan` is the read-only way to see how far behind it is. Check the
live surface before claiming a backend change is live — `curl -o /dev/null -w '%{http_code}'
<api>/auth/me` answering `404` means "not deployed", not "route missing".
