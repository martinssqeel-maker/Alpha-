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
| CORS | **Closed** — `ALLOWED_ORIGINS` set to the website origin plus `localhost:5173`/`3000`; a foreign origin is not reflected |
| Administrators | **None.** `admin_users` is empty and `bootstrap_admin_email` is `""` — see §4 |
| Maintenance mode | Off. Enforced by the API when on (verified 2026-10-13: ordinary `503 maintenance` with the admin's message, administrator `200`) |
| Downloads | `public.downloads` has 0 rows — the Downloads metric legitimately reads 0 |
| Email | `EMAIL_PROVIDER=log` — sends no mail, but still replies "we sent a code" |
| Provider credentials | **None** — no Neon AI Gateway and no provider keys ⇒ every chat request returns `502 provider_unavailable` |
| Schema | Applied on `production`; `neon config plan` reports a pending `~ function api` change |
| Deploy path | `neon deploy --env .env.local` is **broken** on CLI 8.3.5; use `npm run deploy` |

```
NEON_PROJECT                = alpha-platform (billowing-brook-66269785)
NEON_BRANCH                 = production (br-flat-morning-b41hcfhc)
NEON_FUNCTION_API_BASE_URL  = https://br-flat-morning-b41hcfhc-api.compute.c-6.us-east-2.aws.neon.tech
API_BASE_URL                = $NEON_FUNCTION_API_BASE_URL
WEBSITE_URL                 = https://alpha-website-lime.vercel.app
ADMIN_EMAIL                 = ____________________   (bootstrap admin)
GOOGLE_CLIENT_ID            = __________.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET        = GOCSPX-_______________
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

- [x] `ALLOWED_ORIGINS` is set (website origin + `localhost:5173`, `localhost:3000`) and
      deployed; `npm run smoke` reports the CORS warning gone. Add the hosted admin origin
      to the same list when you host `admin/dist`.
- [ ] Never delete a key you want turned off — `neon.ts` only forwards keys that are present,
      so a removed key keeps its live value. Set it explicitly (`AUTH_DEV_ECHO_OTP=0`).

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

## [ ] 4. Bootstrap admin user — currently there are none

Measured 2026-10-13: `select count(*) from public.admin_users;` → **0**. The control centre
is built and verified but unreachable until this step is done. `bootstrap_admin_email` in
`system_settings` is blank, and the bootstrap-instead-of-SQL route needs a sign-in, which
needs email delivery (§5) — so use the SQL promotion below.

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

## [x] 6. Website: the deployed site is configured and serving

Project `alpha--website` (scope `martinssqeel-zapdata`), production domain
`https://alpha-website-lime.vercel.app`, root directory `website`, no build command.

The API host ships in the **committed** `website/config.js`, so there is nothing to set in
Vercel: the pushed commit deploys and the account portal is live. Verified `07e3801`
(deployment `success`; `/account` and `/config.js` both `200`).

Verify any time: `npm run smoke -- --website https://alpha-website-lime.vercel.app`.

If the Function URL changes: `API_BASE_URL=<new> node website/gen-config.mjs`, commit, push.

> Do **not** put a `buildCommand` back in `website/vercel.json`. See §6b.

### 6b. Why the website deployments were failing

Every production deployment failed from `4c4321a` until it was fixed, so the live site was
frozen on the build of `62571c7`: `/account` and `/config.js` both answered `404` while the
old landing page kept serving.

The only change at that boundary was one line added to `website/vercel.json`,
`"buildCommand": "node gen-config.mjs"`; the rest of the migration commit was inert static
files. The generated file only ever held a **public** API URL, so there was no reason to
build it on the host: `website/config.js` is committed instead, and `vercel.json` is back to
the exact blob (`bb1f31d`) that last deployed successfully.

Evidence after the fix (commit `07e3801`): Vercel reported `success` where every earlier
commit reported `failure`; `/`, `/account`, `/config.js`, `/assets/account.js` and
`/assets/styles.css` all `200` with correct content types; the page's API calls pass CORS
(origin reflected, preflight `204`); `npm run smoke -- --website <domain>` → 7 passed,
0 failed, including `website config.js is configured`.

## [ ] 7. Admin dashboard: API base URL + your administrator password

The dashboard now signs in with an **administrator email and password** instead of an
emailed link, so you need to set one. Run this on your machine (it prompts for the password
with hidden input, writes only a scrypt digest, and prints nothing):

```powershell
npm run admin:password                 # email + hidden password
```

The account must already exist and already be an admin: sign in once on the website with the
bootstrap admin email first, then run the command. `npm run admin:password -- --revoke`
removes the credential again.

Then build the dashboard:

```powershell
cd admin
$env:VITE_API_BASE_URL = "https://br-flat-morning-b41hcfhc-api.compute.c-6.us-east-2.aws.neon.tech"
npm run build
```

Host `admin/dist/` privately. The RPCs are `require_admin`-checked regardless, but keep
the URL unlisted. **Add that host to `ALLOWED_ORIGINS`** (and redeploy) or the browser will
block its API calls — only the website origin and `localhost:5173/3000` are allowed today.

## [ ] 7b. Google sign-in: create the OAuth client

The code is written and deployed; Google is simply switched off until these two values
exist on the Function (`GET /auth/providers` reports `google:false`, and the website hides
the button rather than showing one that cannot work).

1. https://console.cloud.google.com/ → create/select a project.
2. **APIs & Services → OAuth consent screen**: External; app name `Alpha AI Workspace`;
   your support email; add your own Google account under **Test users**. Scopes: the
   defaults plus `openid`, `email`, `profile`.
3. **APIs & Services → Credentials → Create credentials → OAuth client ID**.
   Application type: **Web application**.
   Authorized redirect URI (exactly this, no trailing slash):
   `https://br-flat-morning-b41hcfhc-api.compute.c-6.us-east-2.aws.neon.tech/auth/google/callback`
4. Add the client ID and secret to `.env.local` as `GOOGLE_CLIENT_ID` and
   `GOOGLE_CLIENT_SECRET` (never paste them into chat).
   Then prove the pair is right **before** deploying — `npm run check:oauth` asks
   Google and GitHub directly and prints `ACCEPTED` / `REJECTED` without ever
   printing a secret. Only once Google reads `ACCEPTED`, run `npm run deploy`.
   - The secret must be the one shown **for that same client id** (it looks like
     `GOCSPX-…`). A secret belonging to another client, or one that has since been
     reset in the Console, is accepted at the consent screen and then rejected by
     Google's token endpoint with `401 invalid_client` — sign-in dies after the
     Google page with nothing obvious to point at. Diagnose from the Function logs:
     `neon logs query --project-id billowing-brook-66269785 --branch production --source function --body-contains "api:google"`.
5. Verify: `curl https://br-flat-morning-b41hcfhc-api.compute.c-6.us-east-2.aws.neon.tech/auth/providers`
   must show `"google":true`, and `/account` must now show **Continue with Google**.
6. Verify with a real sign-in (the check that actually matters): press
   **Continue with Google**, pick an account, and confirm you land back on `/account`
   signed in. If instead you see “Google rejected this deployment's sign-in
   credentials” (error code `google_misconfigured`), the client id and secret do not
   match — re-copy the secret for that client and redeploy. The old generic
   “could not be verified, try again” is now reserved for genuine identity failures,
   so it never means a credential problem.

Desktop sign-in with Google uses the same completion path; the API returns the
browser to the app's existing `alpha://auth/callback` link, so no desktop change is
needed. A rejected secret shows up in the app as a plain-language message instead of
the raw `google_misconfigured` code.

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

### 9b. The installer file is public — a decision, not an oversight

The download *page* and the download *API* are gated (`401` anonymous, `403` suspended,
and the asset URL is only handed to a signed-in active account). The **file** is not: it is
a GitHub release asset and the repository is public. Measured anonymously 2026-10-13:
repository API `200`, release page `200`, asset `206` on a range request. Anything a
visitor can fetch, they can install.

Three honest options, pick one and record the choice:

1. **Private storage + signed URLs (recommended).** Upload each installer to a private
   bucket and serve a minutes-long signed URL from `GET /downloads/latest` after the gate.
   Keep `latest.yml` in the public GitHub release so electron-updater keeps working.
2. **Make the repository private.** Release assets then require auth, but existing installs
   cannot auto-update without a token shipped in the app — do not do this without adding
   one.
3. **Accept it.** Treat the installer as public and gate only the product surface; then say
   so on the site rather than implying the download is exclusive.

## [ ] 10. End-to-end smoke

Automated part — safe, read-only, survives a deploy:

```powershell
npm run deploy -- --check
npm run smoke
npm run smoke -- --email you@example.com      # also exercises sign-in (sends mail)
npm run verify:auth -- --with-write           # 27 checks; creates + deletes temp accounts
npm run verify:admin                          # 15 checks; changes settings, then restores them
```

`verify:admin` is the check that the portal is not decorative: it flips a feature flag, an
announcement, the application-version setting, maintenance mode and an account status
through the portal's own RPCs and reads each one back through `/platform/config`,
`/downloads/latest` and `/auth/request`. It restores every `system_settings` value it
touched and prints the restored rows.

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
