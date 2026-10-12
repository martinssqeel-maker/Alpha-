# Alpha platform architecture

Alpha AI Workspace is one product across three surfaces that share a single account
and a single source of truth: **Neon Postgres, reached only through one Neon Function
(the `platform/api` Hono app)**.

```
                        ┌──────────── Neon ────────────┐
                        │  Function: alpha-platform-api │
                        │  (Hono, Node 24, platform/api)│
   Desktop app ─────────┤                               │
   (Electron)           │  /auth/*      /platform/*     │
     │  AccountModal    │  /gateway/*   /admin/*        ├──▶ Postgres (pooled)
     │  PlatformService │  /  /health                  │    public.* tables,
     │  GatewayAdapter  │                               │    SECURITY DEFINER fns
     │                  └───────────────┬───────────────┘
     │                                  │
   Website (static)  ── POST /auth/*, /platform/config
   Admin (Vite/React) ── POST /admin/rpc                        │
                                                                ▼
                                          Upstream model providers (server-side keys only)
```

There is no client SDK and no direct database access from any surface. Everything is
plain HTTPS JSON against the Function with `Authorization: Bearer <access token>`.

## Surfaces

- **Desktop app** (`src/main`, `src/renderer`) — local-first workspace. Local Ollama
  stays fully offline. When the user enables *Settings → Alpha Cloud* and sets an API
  base URL, a managed `gateway` provider ("Alpha Cloud") appears and its models are
  listed through `/gateway/models`. Cloud traffic is proxied server-side, so provider
  keys never reach the client.
- **Website** (`website/`) — static marketing site plus a passwordless account portal
  (`account.html`) showing plan, usage and available models. Reads its API base URL
  from a generated `config.js` (see `website/gen-config.mjs`).
- **Admin dashboard** (`admin/`) — separate Vite/React app for staff: users, plans,
  providers/models, feature flags, announcements, settings, audit log. All reads and
  writes go through `/admin/rpc`.

## Identity

Passwordless only: an emailed code, or a magic link.

- `POST /auth/request` stores a hashed code + hashed magic-link token in `auth_otps`
  and emails them (`email.ts`; `EMAIL_PROVIDER=log` prints to Function logs instead of
  sending mail).
- `POST /auth/verify` reads a matching unexpired row and mints a session: a
  **short-lived HS256 access JWT** (signed with `AUTH_JWT_SECRET` via `jose`, carrying
  `sub`, `email`, `sid`, `role`) plus an opaque **refresh token whose hash** is stored
  in `sessions`. Raw tokens are never persisted.
- `POST /auth/refresh` rotates the session; `POST /auth/signout` revokes it.
- First sign-in calls `public.provision_user()` in the database, which creates the
  `users` row, assigns the `free` plan, and grants the `owner` admin role when the
  address matches the configured bootstrap admin.

Desktop flow: the app is registered for the `alpha://` scheme (configurable via
`platform.authRedirectScheme`), the link opens `alpha://auth/callback`, the main
process parses it (`parseDeepLink`) and persists the session through
`EncryptedSessionStorage` into the OS-encrypted `SecretStore` (Windows DPAPI) — never
in plaintext settings. The website's `account.html` accepts the same magic link when
`WEB_ACCOUNT_URL` is configured, so one account works in both places.

## Entitlements, plans and usage

- `plans` + `plan_features` (`limit.*` keys are numeric limits; every other key is a
  boolean feature, e.g. `cloud_models`), plus time-boxed per-user
  `entitlement_overrides` and `subscriptions`.
- Resolution order (highest first): active override → plan feature → free plan.
  Encapsulated in `public.check_entitlement(user, feature)`.
- `usage_counters` are per user/resource/month. `public.record_usage()` increments
  them; the gateway checks the token limit before a call and records tokens after.
- Model access resolves through `model_plan_access`, `model_user_access` and
  `ai_models.default_allowed`, all folded into `public.get_my_platform_config()`.
- `get_my_platform_config()` is the single contract consumed by every surface. Its
  shape must match `PlatformConfig` in `src/shared/types.ts` — the desktop app,
  website and gateway all read the same object, so changing one without the other
  breaks them together.

## AI gateway (the security boundary)

`platform/api/gateway.ts` is the only place upstream provider credentials live.

1. Re-verifies the caller from the bearer token (`requireAuth` → `verifyAccessToken`).
2. Loads the caller's own config and requires the `cloud_models` feature.
3. Rejects a model that is unknown or not allowed for the plan.
4. Rejects the request once the period token quota is reached (`429 quota_exceeded`).
5. Resolves the upstream in this order:
   - the **Neon AI Gateway** when `NEON_AI_GATEWAY_BASE_URL` + `NEON_AI_GATEWAY_TOKEN`
     are set (one credential for every provider), else
   - the provider's own `base_url` + `api_key_env` column from `ai_providers`.
     Only `openai` / `openai-compatible` kinds are proxied.
6. Streams the reply back as OpenAI-compatible SSE, teeing the stream so a
   `waitUntil`-scheduled tap can read token usage and call `record_usage()` after the
   response is already on its way to the client.

Failure modes are explicit and stable: `402 plan_required`, `403 model_not_allowed`,
`404 unknown_model`, `429 quota_exceeded`, `502 provider_unavailable` /
`upstream_unreachable`. If neither the AI Gateway nor any provider key is configured,
every chat request returns `502 provider_unavailable` — a working API with no chat
backing is a configuration state, not a bug.

The desktop `GatewayAdapter` is an ordinary `ProviderAdapter`: it POSTs to the gateway
with the user's access token and parses the same SSE it would parse from any
OpenAI-compatible endpoint (including streaming tool calls).

## Security model

- **Bearer tokens only.** No cookies and no server-side sessions for the API itself, so
  CORS cannot be used to steal credentials. `ALLOWED_ORIGINS` still narrows which
  pages may call the API and should list the real website/admin origins; unset or `*`
  makes Hono reflect any origin.
- **Authorization is in the database.** Each request runs inside a transaction that
  first calls `set_config('app.user_id', …, true)`, so
  `public.current_user_id()` / `current_request_role()` return the caller inside the
  `SECURITY DEFINER` functions. RLS is enabled on every table as defence-in-depth for
  any non-owner connection.
- **Auth internals are never exposed.** `auth_otps` and `sessions` store hashes only
  and are touched exclusively by the API.
- **Admin RPCs are an allow-list.** `platform/api/adminSignatures.ts` declares the
  callable functions, each parameter's name and cast, and which parameters have
  server-side defaults; `buildAdminCall()` builds Postgres **named-argument** SQL so key
  order never matters. Unknown parameters, missing required parameters and short
  positional lists are rejected before reaching the database, and every function
  additionally calls `public.require_admin(permission)` and writes an `audit_logs` row.
- **Secrets stay server-side.** Provider keys live only in Function env. The desktop
  app stores only the API base URL; keys entered for *direct* (non-gateway) providers
  remain in the OS-encrypted secret store and never touch the backend.
- Two env flags are load-bearing and must stay off in production:
  `AUTH_DEV_ECHO_OTP` (would return live sign-in codes to any caller) and a wildcard
  `ALLOWED_ORIGINS`. `npm run deploy` refuses to deploy with the former enabled.

## Legacy (do not use)

`supabase/` is the **pre-migration** backend (config, edge function, RLS-era schema) and
is not compiled: it is outside every tsconfig and outside the desktop build. The live
schema is `database/migrations/0001_platform.sql` and the live API is `platform/api/`.
The `@supabase/supabase-js` dependency is likewise unused by application code. Treat
the folder as history; deleting it is a deliberate cleanup, not a migration step.
