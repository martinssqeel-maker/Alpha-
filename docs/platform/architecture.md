# Alpha platform architecture

Alpha AI Workspace is one product across three surfaces that share a single
account and a single source of truth.

```
                +---------------------------- Supabase (source of truth) ---------------------------+
                |  Postgres (RLS) · Auth · Edge Functions                                       |
                |                                                                               |
 Desktop app ---+-- platform:status/signin/signout/refresh (IPC) -->  get_my_platform_config()  |
 (Electron)     |                                                       check_entitlement()       |
   |  GatewayAdapter('gateway' provider) --- POST /functions/v1/ai-gateway --> upstream provider |
   |                                                                     record_usage()           |
 Website  ------+-- supabase-js (anon key) --- signInWithOtp / get_my_platform_config()          |
 (static)       |                                                                               |
 Admin app -----+-- supabase-js (anon key) --- admin_* RPCs (require_admin + audit)             |
 (Vite/React)   |                                                                               |
                +------------------------------------------------------------------------------+
```

## Surfaces

- **Desktop app** (`src/main`, `src/renderer`): local-first workspace. Local
  Ollama stays fully offline. When signed in, a managed `gateway` provider
  ("Alpha Cloud") appears and its models are listed via the gateway. All cloud
  traffic is proxied server-side so provider keys never reach the client.
- **Website** (`website/`): marketing site + passwordless account portal
  (`account.html`) showing plan, usage, available models and announcements.
- **Admin dashboard** (`admin/`): separate Vite/React app for staff — users,
  plans, providers/models, feature flags, announcements, settings, audit log.

## Identity

- Supabase Auth (email magic-link/OTP). One account works in both the website
  and the desktop app.
- Desktop flow: `signInWithOtp({ email, emailRedirectTo: 'alpha://auth/callback' })`.
  The link opens the app via the `alpha://` protocol; the main process parses
  the callback (`parseDeepLink`), calls `setSession`, and persists the session
  **encrypted via the OS keystore** (`SecretStore` → DPAPI), never in plaintext
  settings.
- A trigger on `auth.users` creates a `profiles` row, assigns the `free` plan,
  and auto-grants the `owner` admin role when the email matches
  `system_settings.bootstrap_admin_email`.

## Entitlements, plans and usage

- `plans` + `plan_features` (`limit.*` keys are numeric limits, other keys are
  features), plus per-user `entitlement_overrides` (time-boxed).
- Resolution order (highest first): active override → plan feature → free plan.
  Encapsulated in `check_entitlement()`.
- `usage_counters` are per user/resource/month. The gateway checks the token
  limit before a call and calls `record_usage()` afterwards.
- `model_plan_access` / `model_user_access` / `ai_models.default_allowed`
  resolve per-model access for a user.

## AI gateway (the security boundary)

`supabase/functions/ai-gateway` is the only place upstream provider keys live.

1. Re-verifies the caller from their bearer token (`auth.getUser`).
2. Resolves the model + provider from the catalog.
3. Enforces plan feature (`cloud_models`) and model access.
4. Enforces the periodic token quota.
5. Calls the upstream provider with the **server-side** key
   (`PROVIDER_API_KEY_<CODE>`), streaming the reply back as OpenAI-compatible
   SSE (Anthropic responses are translated).
6. Records usage (`tokens`, `requests`).

The desktop `GatewayAdapter` is an ordinary `ProviderAdapter`; it just posts to
the gateway with the user's access token and parses the same SSE it would from
any OpenAI-compatible endpoint (including streaming tool calls).

## Security model

- RLS on by default. Catalog tables (plans, providers, models, flags,
  announcements, public settings) are read-only for authenticated users; every
  other table is reachable only through `SECURITY DEFINER` RPCs.
- Admin RPCs call `require_admin(permission)` and write an `audit_logs` row.
- The service role key is used only inside edge functions / CLI migrations.
- The desktop stores only the public anon key in settings; provider keys entered
  manually for *direct* (non-gateway) providers remain in the OS-encrypted
  secret store and never touch the backend.
