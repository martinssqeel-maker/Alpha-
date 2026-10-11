# Platform verification

## Automated (local, no backend needed)

```bash
npm run typecheck   # node + renderer
npm test            # vitest: permissions, pathGuard, providers, store, platform, gateway
npx electron-vite build
```

`tests/platform.test.ts` covers deep-link parsing, encrypted session storage
(round-trip + ciphertext-at-rest) and auth error mapping.
`tests/gateway.test.ts` covers OpenAI-compatible SSE parsing including streaming
tool-call deltas.

## Against a live backend

After `supabase db push`, use the SQL editor or the admin dashboard:

1. **RLS**: as an authenticated non-admin, `select * from audit_logs;` must
   return no rows; `select * from profiles;` returns only your own row.
2. **Entitlements**: `select get_my_platform_config();` returns your plan,
   limits, usage, models and is shaped exactly like `PlatformConfig` in
   `src/shared/types.ts`.
3. **Gateway auth**: `curl -X POST <url>/functions/v1/ai-gateway -H 'content-type: application/json' -d '{"action":"models"}'`
   returns `401 unauthorized`. With a valid user bearer token it returns the
   accessible models.
4. **Quota**: with `limit.tokens` reached, `action:"chat"` returns
   `402 quota_exceeded`. For a plan without `cloud_models`, `403 plan_required`.
5. **Admin**: call `admin_overview()` as a non-admin → `forbidden`; as an admin
   → stats, and a new `audit_logs` row appears after any write RPC.

## Desktop end-to-end

1. Settings → Alpha Cloud: enable + project URL + anon key → Save.
2. Account → enter email → "Send sign-in link". Open the link from your inbox;
   the app should focus itself and show your email/plan/usage.
3. Models page should now include cloud models under **Alpha Cloud**.
4. Send a prompt to a cloud model → response streams; usage increases on the
   Account panel after **Refresh**.
5. Pick a cloud model not in your plan (if any) → send is blocked with
   "This model is not included in your plan." (server also enforces this).
6. Sign out → the Alpha Cloud provider and its models disappear.

## Website

- Visit `/account`. If env vars are missing you should see the honest
  "not configured" notice; once set, an email form appears and after sign-in the
  plan/usage/models render.

## Admin dashboard

- Sign in with the bootstrap admin email. Overview shows counts; Users lets you
  change status/plan and grant overrides; every action shows up under Audit.
