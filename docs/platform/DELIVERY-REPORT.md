# Alpha AI Workspace — delivery report

Scope of this pass: the shared AI infrastructure, the administration control center, and the
public site. Written after the work, describing what was verified and what was not.

## A. What changed

| Area | Files | What it does now |
| --- | --- | --- |
| Shared AI data layer | `database/migrations/0004_shared_ai.sql` (new) | OpenRouter provider + catalogue, `ai_requests` per-request accounting, atomic `claim_ai_request` / `finish_ai_request`, `admin_ai_usage`, paginated `admin_users_page`, `admin_set_provider_policy`, provider spend caps, `ai_shared` / `ai_budget` safeguards, free-tier entitlement |
| AI gateway | `platform/api/gateway.ts`, `platform/api/aiGuard.ts` (new) | Requires authentication, resolves OpenRouter with attribution headers, reserves allowance before the call and settles to the provider's real token count, captures `usage.cost` / generation id, maps provider failures honestly, releases reservations on cancel |
| Platform API | `platform/api/platform.ts`, `platform/api/index.ts` | `requireAuth` on every platform route; fixed `upsert_device(, )`; mounted `/admin` |
| Admin API | `platform/api/admin.ts` (new) | ~25 routes over the existing `admin_*` RPCs, plus provider credential state and model availability |
| Admin UI | `website/admin.html`, `website/assets/admin.js` (new) | Seven-section control center: overview, users, AI providers, usage & cost, plans & flags, security, system |
| Public site | `website/index.html`, `website/features.html`, `website/pricing.html`, `website/about.html` | New pages plus navigation, footer, hero CTAs and a plan summary on the landing page |
| QA stub | `scripts/stub-platform-api.mjs` | Admin response fixtures and `--forbidden` / `--empty` modes so the dashboard is testable locally |
| Docs / config | `.env.example`, `docs/platform/product-transformation-plan.md` (new), `package.json` | `OPENROUTER_API_KEY` documented; plan and audit recorded; `@electric-sql/pglite` added as a dev dependency |
| Tests | `tests/migrations.test.ts`, `tests/aiGuard.test.ts`, `tests/apiAuth.test.ts` (new) | 56 new tests, described in section C |

Untouched, deliberately: every file under `src/**`, `scripts/desktop-smoke.mjs`,
`tests/theme.test.ts` and the two Apex/Aurora briefs — that is the in-progress desktop redesign,
and `git status` confirms none of it was modified, reverted or reformatted.

## B. What works (verified, not assumed)

- **Quota enforcement is atomic.** `claim_ai_request` checks the allowance, records the
  reservation and creates the in-flight row in one transaction under a per-user advisory lock. A
  second request that no longer fits is refused with `quota_exceeded` and does not move the
  counter.
- **Settlement is correct.** A completed run settles to the provider's real total; a failed or
  cancelled run returns its whole reservation; a provider that reports no usage keeps the
  estimate.
- **Spending cannot silently run away.** A company monthly budget, a per-provider monthly cap, a
  daily request ceiling and a concurrency ceiling are each enforced server-side. Values a client
  sends are never trusted — the API passes only the user id and the model.
- **Authorization is server-side.** Every admin route calls an RPC that begins with
  `require_admin(permission)`; an ordinary signed-in account is refused (`forbidden`), an
  anonymous caller is refused (`not_authenticated`), and there is no path in the API for an
  account to grant itself a role.
- **The dashboard is honest.** Seven sections render from live API data; a metric that cannot be
  read shows as *Unavailable*; provider-reported cost and list-price estimates are separated and
  labelled; a model is shown as *verified* only after real requests have succeeded.
- **A provider key cannot leave the server.** The operator's credential view is built by a single
  function that reads a secret only to answer "is one present" and "does its fingerprint match";
  the object it returns has no field able to hold a key. A test asserts the serialised response
  contains neither the secret nor any 8-character fragment of it.
- **Local Ollama integration still works, verified live.** `tests/ollama.live.test.ts` ran against
  the real service on this machine and passed: it detected the running service, listed installed
  models, read real hardware figures, recommended a model the machine can run, and completed a
  real model pull. This is pre-existing functionality, re-verified rather than changed.
- **The website serves clean URLs** — `/features`, `/pricing`, `/about`, `/admin` all 200, and all
  pages interlink. The landing page still resolves the newest GitHub release (live `200` from the
  public Releases API in the browser).

## C. Test results (actually executed)

| Check | Command | Result |
| --- | --- | --- |
| Type checking | `npm run typecheck` | **exit 0** (node + web projects) |
| Full suite | `npx vitest run` | **22 files passed; 233 tests passed; 0 failed; exit 0** (re-run unchanged after the final refactor). One earlier run showed 5 skipped — the live Ollama tests, which self-skip when the local service has not answered yet; on the two later runs they executed and passed |
| Migrations | `npx vitest run tests/migrations.test.ts` | **24 passed** — all four migrations execute against real PostgreSQL via PGlite, then the quota, budget, provider-cap, suspension and authorization behaviour is exercised through the same SQL the API calls |
| Gateway guards | `npx vitest run tests/aiGuard.test.ts` | **26 passed** — credential redaction, provider failure mapping, reservation sizing, cost estimation, and provider credential summaries |
| API authentication | `npx vitest run tests/apiAuth.test.ts` | **6 passed** — missing/malformed/forged/expired tokens refused, a validly signed session accepted, mutating verbs protected |

Two of my own mistakes were caught by these tests rather than by inspection and fixed: an
ambiguous PL/pgSQL reference to a column named `used`, and a `never`-narrowed variable in the
streaming tap.

## D. Visual verification

Verified in the real browser against local servers serving `website/` (with the QA stub for API
responses — the committed `config.js` was never modified).

| Page | Viewports | Result |
| --- | --- | --- |
| `/admin` | 1440×900, 362×726 | Seven tabs all render live data; **zero horizontal overflow**; tables fit their scroll containers; dark tokens applied (`rgb(12,15,20)` page, `rgb(233,236,243)` headings) |
| `/admin` (light) | 1440×900 | Light tokens applied correctly (`rgb(242,243,246)` page, white cards) |
| `/` | 1600×1000, 434×844 | New nav, both hero CTAs, 4-card plan section, footer links; no broken images; no overflow |
| `/features` | 434×844 | 15 cards, correct `aria-current`, no overflow |
| `/pricing` | 390×844 | 10 cards, no overflow |
| `/about` | 434×844 | 9 cards, no overflow |

Interactions exercised, not just rendered: tab switching across all seven sections; account search
(3 rows → 1 row, pager updated); opening an account detail (six sections, usage, overrides,
sessions, devices, downloads, audit); a sensitive action (`Suspend account`) opening its
confirmation dialog with the correct wording and then issuing `POST /admin/users/:id/status → 200`
followed by a reload; and the signed-in-but-not-administrator path rendering the server's own
refusal with no dashboard content leaking.

**Defects found by this browser pass and fixed:** `admin.html` never loaded `config.js`, so the
page reported "The API is not configured" instead of its real state; and a `window`-shadowing
local variable in the security panel.

**Limitation:** screenshot capture is unavailable in this build ("the preview webview is not being
composited"), so there are no images. Rendering was verified through the accessibility tree,
computed styles, element geometry and the console/network logs instead. That is real inspection,
but it is not a picture — a human should still glance at `/admin` once.

## E. AI infrastructure

- **How OpenRouter is connected.** `public.ai_providers` holds a row for `openrouter`
  (`kind = openai-compatible`, `base_url = https://openrouter.ai/api/v1`,
  `api_key_env = OPENROUTER_API_KEY`). `platform/api/gateway.ts` resolves that row, reads the key
  from the Function's environment, and calls `/chat/completions` with the two optional
  attribution headers. If `NEON_AI_GATEWAY_*` is configured it takes precedence and one credential
  covers every provider.
- **Where the key goes.** `OPENROUTER_API_KEY` in `.env.local` (gitignored), then `npm run deploy`.
  It is never in the database, never in a response, never in a log, and never in the desktop
  bundle. No key is configured today, so shared inference currently answers
  `provider_unconfigured` rather than pretending to work.
- **How quotas work.** Each account has a monthly token allowance and a daily request ceiling from
  its plan (with per-account overrides). A request reserves before it is sent and settles
  afterwards; failures and cancellations release the reservation. The free plan can use shared
  inference — previously it could not, because `cloud_models` was seeded only for `pro`/`team`.
- **How spending is controlled.** `ai_shared` (master pause), `ai_budget` (company monthly cap),
  per-provider `spend_limit_usd`, and each account's own allowances. All four are evaluated inside
  `claim_ai_request`, so no API or client change can bypass them. OpenRouter's own per-key credit
  limit is documented as a second, independent safeguard rather than the primary one.
- **A real provider constraint worth knowing:** OpenRouter's free (`:free`) model limits are per
  *account*, not per user — 20 requests/minute and 50/day below a $10 lifetime purchase, with
  failed attempts counting toward the daily figure. Because Alpha uses one company key, the free
  plan's own ceiling is deliberately set lower than that.

## F. Administration

- **Provisioning an administrator.** `system_settings.bootstrap_admin_email` names one address; the
  first verified sign-in by that address is granted the `owner` role by `provision_user`. There is
  no public administrator registration route and no default password.
- **How access is protected.** `require_admin(permission)` resolves the caller from the
  transaction-scoped `app.user_id` and checks `admin_role_permissions`. Roles (`owner`, `admin`,
  `support`) and their permissions are database rows. The last owner cannot be demoted, and an
  administrator cannot remove their own access.
- **Operational controls that work:** company budget and master switch, per-provider enable/disable
  and spend caps, plan entitlements and feature flags, maintenance mode, account suspend/restore,
  plan changes, entitlement overrides, session revocation (single and all), and an append-only
  audit log of every change with its actor.
- **Privacy boundary held:** administrators can see an account's sessions, devices, downloads,
  usage and audit trail — not its conversations.

## G. Deployment status

- **Local implementation only.** Nothing was pushed, deployed or published.
- The website changes, the API changes and migration `0004` exist in the working tree and are
  verified locally. The live site and the live Function are unchanged from before this pass.

## H. Remaining blockers

1. **Migration `0004` has not been applied to the live database.** It is verified against real
   PostgreSQL in tests, but running it against production is an operator action:
   `npm run db:migrate`. Until it runs, the deployed API cannot serve the new admin routes or claim
   allowance, because those functions do not exist yet.
2. **The API has not been deployed.** `npm run deploy` is required for the authenticated gateway,
   the fixed platform routes and `/admin` to exist in production.
3. **No `OPENROUTER_API_KEY` is configured**, so no shared cloud request can succeed yet, and **no
   live end-to-end AI request was tested** — there is no key and no deployed migration to test
   against. Everything about that path is verified at the unit and SQL level only.
4. **Rate limiting on admin mutations is not implemented.** Authorization, audit logging and
   confirmation are; brute-force throttling is not. The realistic exposure is small (a valid
   session *and* an administrator role are both required), but it is a gap.
5. **Metrics that need history do not exist yet**: provider health monitoring over time, latency
   percentiles, and alerts. The schema records what they need; nothing computes them.
6. **The authenticated *web* dashboard (Part 4 of the brief) was not built.** The signed-in web
   surface remains the existing `/account` page — sign-in, plan, usage and the gated download —
   and the full application shell (workspace sidebar, model management, usage and billing pages)
   lives in the desktop app. Building `/app/*` routes would have duplicated that shell, so I did
   not. If a browser-based workspace is genuinely wanted as well, it is unstarted work.
7. **Not attempted in this pass** (unchanged, not regressed): the desktop agent workspace, Ollama
   *management UI* changes, low-memory model recommendations, BYOK UI, and the final "publish the
   Google consent screen" step reported earlier. The desktop app already manages Ollama and
   per-provider keys; I added no new capability there.
8. **`npm run smoke:desktop` was not run.** It exercises the packaged desktop application, which
   was outside what this pass changed and which the concurrent redesign work is actively editing.
   The desktop test suite itself passed as part of the full run.
9. **Payments are not connected.** Plans, entitlements and subscriptions are configurable in the
   database, which is what the monetisation foundation requires; no checkout exists, and the
   pricing page says so.
10. **BYOK is unchanged and untested by me.** The desktop app already supports per-provider keys,
    and the gateway meters company-funded usage separately, but I added no BYOK flow and ran no
    isolation test for it.

## I. Next recommended action

**Apply the migration and deploy, then set the key** — in that order:

```
npm run db:migrate      # creates the shared-AI tables, RPCs and the OpenRouter provider
npm run deploy          # publishes the authenticated gateway and the admin API
```

then add `OPENROUTER_API_KEY` to `.env.local` and deploy once more. After that, place your key in
OpenRouter and set a small credit limit on it, open `/admin` and confirm the provider reads
*both* configured and verified — that is the first point at which shared cloud inference is
genuinely live rather than verified in isolation.
