# Alpha AI Workspace — product transformation plan

Written from the repository audit performed before any change was made. It records
what actually exists, what is genuinely broken, and the order the work is done in.

## 1. What the product already is

Three cooperating surfaces, deliberately only loosely coupled:

| Surface | Location | Runtime | Notes |
| --- | --- | --- | --- |
| Desktop app | `src/main`, `src/preload`, `src/renderer` | Electron 44 + React 19 + Vite (`electron-vite dev`) | Local-first: Ollama, project folders, terminal, Git/GitHub, permissions/approval engine |
| Platform API | `platform/api` | Hono on a **Neon Function** (`neon.ts`, deployed by `npm run deploy`) | Auth, OAuth, platform config, AI gateway, downloads |
| Public website | `website/*.html` | Static, no build step, Vercel (`cleanUrls`) | Landing, download, account, privacy, terms |

Database: **Neon Postgres**. Migrations `database/migrations/000{1,2,3}_*.sql`
applied by `npm run db:migrate`. 27 tables, ~40 `security definer` RPCs.

### Identity

- `public.provision_user(email)` creates the account on first verified sign-in —
  signing in *is* signing up.
- Sessions: OTP email code, password, Google OAuth, GitHub OAuth. Sessions are
  `public.sessions` rows; access tokens are HS256 JWTs (`platform/api/jwt.ts`),
  refresh tokens stored as peppered hashes.
- Admin identity is separate: `public.admin_users` + `admin_roles` +
  `admin_role_permissions`, enforced by `public.require_admin(perm)`.

## 2. Defects found in the audit (real, reproducible from source)

1. **`/gateway/*` is unauthenticated.** `platform/api/gateway.ts` imports
   `requireAuth` but never mounts it; `platform/api/index.ts` mounts the router with
   no middleware. Every request therefore reaches the handler with
   `c.get('userId') === undefined`, `loadPlatformConfig(undefined)` returns `null`,
   and the handler answers **402 `plan_required` for everybody**. Shared cloud AI is
   not merely unguarded — it is entirely non-functional.
2. **`/platform/config` and `/platform/device` are unauthenticated** for the same
   reason, and `/platform/device` runs the syntactically invalid SQL
   `select public.upsert_device(, )`, so device telemetry has never worked.
3. **No admin API and no admin UI exist.** Migration `0003_control_center.sql` added
   nine `admin_*` RPCs (`admin_metrics`, `admin_get_user`, `admin_list_sessions`,
   `admin_revoke_session`, `admin_revoke_user_sessions`, `admin_set_user_admin`,
   `admin_security_overview`, `admin_list_downloads`, `admin_system_status`) plus a
   `public.downloads` table, but nothing exposes them over HTTP and no page calls them.
   `scripts/verify-admin.mjs` describes "the admin RPC the UI calls" — that UI does
   not exist.
4. **The free plan cannot use shared inference.** `plan_features` seeds
   `cloud_models` for `pro`/`team` only, so the "free tier with limited shared usage"
   the product needs is not expressible today.
5. **Quota enforcement is a race.** The gateway reads `limits.tokens` and
   `usage.used`, then calls upstream, then records usage afterwards. Two concurrent
   requests both observe the same `used` and both proceed.
6. **No per-request accounting or cost reporting**, so the admin cost/budget views
   the directive requires have no data to show.

## 3. Guardrails observed

- `feat/nebula-design-system` is at `230ad6e`; the working tree carries ~2,000 lines
  of in-progress desktop redesign across 24 tracked + 4 new files. **None of it is
  touched, reverted, stashed or reformatted by this work.**
- Evidence: `git status` before and after, all edits confined to `website/`,
  `platform/api/`, `database/migrations/`, `docs/`, `tests/`, `.env.example`.
- Nothing is pushed, deployed or published.

## 4. Work order

Priority follows dependency and risk, not visibility.

| # | Work | Why here |
| --- | --- | --- |
| 1 | Authenticate `/gateway`, `/platform`, `/admin`; fix the `upsert_device` SQL | Everything else is unsafe or dead without it |
| 2 | `0004` migration: OpenRouter provider + model seed, free-tier entitlement, `ai_requests`, atomic `claim_ai_request` / `finish_ai_request`, paginated `admin_users_page` | Shared inference must not exist before its controls do |
| 3 | OpenRouter adapter in the gateway: attribution headers, native usage/cost capture, reservation settlement, cancellation release | Provider abstraction stays one interface, not one vendor |
| 4 | `/admin` API wrapping the nine existing RPCs | Authorization is already correct in SQL — do not re-implement it |
| 5 | Admin dashboard UI (`website/admin.html`) | Reads only the API above; never trusts the client for authorization |
| 6 | Public site: `/features`, `/pricing`, `/about`, nav + footer | Honest claims only, sourced from shipped functionality |
| 7 | Browser-preview QA at desktop and mobile, console/network inspection | Mandatory per directive Part 6 |
| 8 | Tests, typecheck, delivery report | Verified outcomes only |

## 5. Deliberate non-goals in this pass

- **No real payments.** `plans`/`subscriptions`/`plan_features` already make plans
  configurable, which is what the directive asks for; wiring a payment provider
  requires business decisions and credentials the founder has not supplied.
- **No provider key storage in the database.** A DB-held key needs a separately
  managed encryption root key — a second secret with no home in the current
  infrastructure. The deployment-secret path (`OPENROUTER_API_KEY` in `.env.local`,
  pushed to the Function by `npm run deploy`) is the honest secure mechanism, and the
  admin UI reports configuration state without ever receiving the value.
- **No fabricated metrics anywhere.** Every number on `/admin` comes from a query;
  anything unmeasurable renders as *unavailable*.
