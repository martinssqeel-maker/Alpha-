# MANUAL TODO — go live

Ordered runbook. Everything here needs an account, a mailbox, or a secret holder — the
things that cannot be done from the repository. Tick as you go.

## Live state at last check

Measured with `npm run smoke`, `npm run deploy -- --check` and `neon config plan`, so
you do not have to re-derive any of it:

| Thing | State |
| --- | --- |
| Function URL | Live — `GET /health` → `200 {ok:true, service:"alpha-platform-api", branch:"production"}` |
| Auth on private routes | Enforced — `/platform/config`, `/gateway/models`, `/admin/rpc` all `401` anonymously |
| Input validation | Working — malformed email → `400 invalid_email` before any mail is touched |
| Sign-in token leak | **Closed** — `/auth/request` no longer returns `devCode` / `devMagicToken` |
| CORS | **Still open** — `ALLOWED_ORIGINS` unset/`*`, so any origin is reflected |
| Email | `EMAIL_PROVIDER=log` — sends no mail, but still replies "we sent a code" |
| Provider credentials | **None** — no Neon AI Gateway and no provider keys ⇒ every chat request returns `502 provider_unavailable` |
| Schema | Applied on `production`; `neon config plan` reports a pending `~ function api` change |
| Deploy path | `neon deploy --env .env.local` is **broken** on CLI 8.3.5; use `npm run deploy` |

```
NEON_PROJECT                = alpha-platform (billowing-brook-66269785)
NEON_BRANCH                 = production (br-flat-morning-b41hcfhc)
NEON_FUNCTION_API_BASE_URL  = https://br-flat-morning-b41hcfhc-api.compute.c-6.us-east-2.aws.neon.tech
API_BASE_URL                = $NEON_FUNCTION_API_BASE_URL
WEBSITE_URL                 = ____________________   (Vercel domain)
ADMIN_EMAIL                 = ____________________   (bootstrap admin)
RESEND_API_KEY              = re___________________
PROVIDER_API_KEY_OPENAI     = sk-__________________
PROVIDER_API_KEY_ANTHROPIC  = sk-ant-______________
PROVIDER_API_KEY_GROQ       = gsk__________________
```

---

## [ ] 1. Rotate exposed secrets (critical)

Reported done in `HANDOVER_NOTE.md`, **not independently verified here**. Confirm:

- **Neon MCP API key**: `neon api-keys list` → the account-wide key minted by `neon mcp`
  must no longer work. Revoke it if it is still listed.
- **GitHub token `GH_TOKEN`**: the old one must be revoked; the current one needs
  `Contents: read/write` on `martinssqeel-maker` only.
  `[Environment]::SetEnvironmentVariable("GH_TOKEN", "<new-token>", "User")`

## [x] 1b. Stop the API handing out sign-in tokens (critical)

**Closed and deployed.** `AUTH_DEV_ECHO_OTP` is now falsy on the live Function, the code
additionally requires `NODE_ENV=development` before it will ever echo, and a probe
confirms neither `devCode` nor `devMagicToken` appears in the response.

Remaining from that finding:

- [ ] Set `ALLOWED_ORIGINS` to the real website + admin origins (comma-separated) in
      `.env.local`, then `npm run deploy`. Deleting the line does **not** work — `neon.ts`
      only forwards keys that are present, so a removed key keeps its live value. A
      wildcard makes Hono reflect any origin. Bearer-only auth keeps this from being
      credential theft, but it is the last open item.
- [ ] Confirm with `npm run smoke` (expect the CORS warning to disappear).
- [ ] Never delete a key you want turned off — set it explicitly (`AUTH_DEV_ECHO_OTP=0`).

## [ ] 2. Verify the Neon schema + seed

Neon SQL Editor on the `production` branch:

```sql
select count(*) from public.users;
select code, active from public.plans;          -- expect free, pro, team
select code, active from public.ai_providers;   -- expect openai, anthropic, groq
```

To re-apply the schema on a fresh branch: `npm run db:migrate`.

## [ ] 3. Provider credentials — required before any cloud chat works

Currently **nothing** is configured, so `/gateway/models` lists catalog models and every
`/gateway/chat/completions` call returns `502 provider_unavailable`. Pick one:

- **Preferred:** enable the Neon AI Gateway on the branch and set
  `NEON_AI_GATEWAY_BASE_URL` + `NEON_AI_GATEWAY_TOKEN`. One credential, every provider.
- **Or** add per-provider keys to `.env.local` using each provider row's `api_key_env`
  name (`PROVIDER_API_KEY_OPENAI`, `PROVIDER_API_KEY_ANTHROPIC`, `PROVIDER_API_KEY_GROQ`
  by default).

Then `npm run deploy`. `npm run deploy -- --check` warns while this is still unset.

## [ ] 4. Bootstrap admin user

If `ADMIN_EMAIL` is not yet an owner, promote via SQL (Neon SQL Editor):

```sql
insert into public.admin_users (user_id, role_id)
select u.id, r.id
from public.users u
join public.admin_roles r on r.code = 'owner'
where lower(u.email) = lower('$ADMIN_EMAIL')
  and not exists (select 1 from public.admin_users au where au.user_id = u.id)
on conflict (user_id) do nothing;
```

Verify:

```sql
select u.email, r.code from public.admin_users au
join public.users u on u.id = au.user_id
join public.admin_roles r on r.id = au.role_id;
```

## [ ] 5. Configure real email

`EMAIL_PROVIDER=log` sends nothing while the API still answers "we sent a code". Before
real users sign in: set `EMAIL_PROVIDER=resend`, `RESEND_API_KEY` and a verified
`EMAIL_FROM`, then `npm run deploy`.

Also set `WEB_ACCOUNT_URL` to the website origin if the magic link should open in the
browser instead of the app; otherwise links fall back to `alpha://auth/callback`.

## [ ] 6. Website: set the API base URL (Vercel)

Vercel project root `website`. Environment Variables (Production **and** Preview):

```
API_BASE_URL = https://br-flat-morning-b41hcfhc-api.compute.c-6.us-east-2.aws.neon.tech
```

Redeploy — the config is generated at build time, so a new deployment is required.
Verify: `npm run smoke -- --website https://<your-domain>` and open `/account`.

## [ ] 7. Admin dashboard: set the API base URL

```powershell
cd admin
$env:VITE_API_BASE_URL = "https://br-flat-morning-b41hcfhc-api.compute.c-6.us-east-2.aws.neon.tech"
npm run build
```

Host `admin/dist/` privately. The RPCs are `require_admin`-checked regardless, but keep
the URL unlisted. Remember to add the admin origin to `ALLOWED_ORIGINS`.

## [ ] 8. Desktop app: connect to Alpha Cloud

Installed app → **Settings → Alpha Cloud (platform)**: enable, set the API base URL
above, save. Then **Account** → enter the email → open the link from the inbox.

## [ ] 9. Install the desktop build (build it yourself)

⚠️ Any build older than `v1.0.4` is unusable: `v1.0.3` and earlier contain the launch
splash that never unmounts, which leaves an invisible overlay swallowing every click (the
window opens and looks fine but nothing responds), and the `v1.0.3` assets on GitHub
Releases also predate the Neon migration. Build from source instead:

```powershell
npm run dist        # → release/Alpha AI Workspace-Setup-1.0.4.exe
```

Uninstall the old copy first (Programs & Features) so the `alpha://` protocol handler is
re-registered, then install. When the installer is good, publish it so auto-update
customers get it: `npm run release` (needs `GH_TOKEN`).

## [ ] 10. End-to-end smoke

Automated part — safe, read-only, survives a deploy:

```powershell
npm run deploy -- --check
npm run smoke
npm run smoke -- --email you@example.com      # also exercises sign-in (sends mail)
```

Manual part, needs a mailbox and credentials:

1. Website `/account` — request a code, follow the magic link.
2. Desktop signed in — Account shows plan `Free`, models list, no errors.
3. Chat with a cloud model — free plan must be blocked (`402 plan_required`) until
   upgraded; with credentials, responses stream and usage rises. **Requires step 3.**
4. Admin dashboard — sign in as owner, load Overview / Users / Catalog / Audit.
5. Then add `ALLOWED_ORIGINS` (step 1b) and redeploy.

---

### Completion

Once 1–10 are done the platform is running on Neon (API + Postgres) as the source of
truth. `docs/platform/verification.md` has the detailed checks, and
`docs/handover/RECOVERY_REPORT.md` records how each earlier finding was resolved.
