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

`npm run smoke` passes/fails per check and exits non-zero on any failure. Expected
shape of a healthy API:

| Check | Expected |
| --- | --- |
| `GET /health` | `200 {ok:true, service:"alpha-platform-api", branch:"production"}` |
| `GET /platform/config` | `401 unauthorized` |
| `GET /gateway/models` | `401 unauthorized` |
| `POST /admin/rpc` | `401 unauthorized` |
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

- `/account` loads. With no `API_BASE_URL` you get the honest "not configured" notice;
  once set, the email form appears and after sign-in plan/usage/models render.
- Verify programmatically with `npm run smoke -- --website <url>`.

## Admin dashboard

- Sign in with the bootstrap admin email. Overview shows counts; Users changes
  status/plan and grants overrides; every action appears under Audit.

## What cannot be verified here

Signing in needs a real mailbox and an authenticated session, and the gateway needs a
provider credential. Those steps are listed in `docs/platform/MANUAL-TODO.md` and are
the only ones that require a human.
