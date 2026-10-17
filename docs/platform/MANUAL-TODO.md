# MANUAL TODO — go live

Ordered runbook. Everything here needs an account, a mailbox, or a secret holder — the
things that cannot be done from the repository. Tick as you go.

## Live state at last check

Measured with `npm run smoke`, `npm run deploy -- --check` and `neon config plan`, so
you do not have to re-derive any of it:

| Thing | State |
| --- | --- |
| Function URL | Live — `GET /health` → `200 {ok:true, service:"alpha-platform-api", branch:"production"}` |
| Auth on private routes | Enforced — `/platform/config`, `/gateway/models`, `/admin/overview` all `401` with the API's own `unauthorized` body (re-measured 2026-10-16; the old `/admin/rpc` path no longer exists — see §10) |
| Input validation | Working — malformed email → `400 invalid_email` before any mail is touched |
| Sign-in token leak | **Closed** — `/auth/request` no longer returns `devCode` / `devMagicToken` |
| CORS | **Closed** — `ALLOWED_ORIGINS` set to the website origin plus `localhost:5173`/`3000`; a foreign origin is not reflected |
| Sign-in callbacks | **Corrected 2026-10-16** — both providers were pointed at the bare site origin, which broke Google *and* GitHub sign-in at once. `npm run deploy` now refuses that shape — see §7c |
| Administrators | **One** — `martinssqeel@gmail.com` holds `owner` (measured 2026-10-16 via `npm run admin:grant -- --check`), and it carries a `scrypt` password credential. See §4 |
| Maintenance mode | Off. Enforced by the API when on (verified 2026-10-13: ordinary `503 maintenance` with the admin's message, administrator `200`) |
| Downloads | 11 rows in `public.downloads` (measured 2026-10-16) — the Downloads metric reads real data, not 0 |
| Email | `EMAIL_PROVIDER=resend` with a live key — mail **is** sent, but from `onboarding@resend.dev`, which delivers only to the mailbox that owns the Resend account. See §5 |
| Provider credentials | **None** — no Neon AI Gateway and no provider keys ⇒ every chat request returns `502 provider_unavailable`. All four catalog rows are active; mind that `openrouter` reads `OPENROUTER_API_KEY`, not `PROVIDER_API_KEY_OPENROUTER` — see §3 |
| Schema | Applied on `production`; the `~ function api` change was applied by `npm run deploy` on 2026-10-16 (re-check with `neon config plan`) |
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

## [x] 2. Verify the Neon schema + seed

**Measured 2026-10-16** against `production`: `users` 11 rows; `plans` → `free, pro, team` all
active; `ai_providers` → `anthropic, groq, openai, openrouter` all active; `downloads` 11 rows.
No `bootstrap_admin_email` is needed any more (§4 is done).

Neon SQL Editor on the `production` branch:

```sql
select count(*) from public.users;
select code, active from public.plans;          -- expect free, pro, team
select code, active from public.ai_providers;   -- expect openai, anthropic, groq
```

To re-apply the schema on a fresh branch: `npm run db:migrate`.

## [ ] 3. Provider credentials — required before any cloud chat works

**Nothing is configured yet** (measured 2026-10-16: all six candidate variables are unset,
including the Neon AI Gateway pair), so `/gateway/models` lists catalog models and every
`/gateway/chat/completions` call returns `502 provider_unavailable`. Pick one:

- **Preferred:** enable the Neon AI Gateway on the branch and set
  `NEON_AI_GATEWAY_BASE_URL` + `NEON_AI_GATEWAY_TOKEN`. One credential, every provider.
- **Or** add per-provider keys to `.env.local` using each provider row's `api_key_env`
  name (`PROVIDER_API_KEY_OPENAI`, `PROVIDER_API_KEY_ANTHROPIC`, `PROVIDER_API_KEY_GROQ` for the first three; the **`openrouter`** row instead reads `OPENROUTER_API_KEY`, which does
  not follow the pattern — check any row with `select code, api_key_env from public.ai_providers`).
  Then `npm run deploy`. `npm run deploy -- --check` warns while this is still unset.

## [x] 4. Grant yourself the owner role — done 2026-10-16

`martinssqeel@gmail.com` holds `owner`; `npm run admin:grant -- --check` reports it as the only
administrator. A `scrypt` password credential is set for it too — note that the `/admin` portal
never asks for a password (it reuses the website session), so the credential is for
`POST /auth/password`, not for the dashboard. The steps below are kept for a fresh environment.

Measured 2026-10-16: `select count(*) from public.admin_users;` → **0**, and
`bootstrap_admin_email` is still `""`. The dashboard is reachable and its API is deployed,
but it answers `403 forbidden` for every account until this step is done. Signing in is what
makes an account exist, so do that first (Google and GitHub both work without any email
setup — `/auth/providers` reports `google:true, github:true`).

Then, from this repository on your own machine:

```powershell
npm run admin:grant                                  # prompts for the address
npm run admin:grant -- --email you@example.com       # or pass it
npm run admin:grant -- --email you@example.com --check   # show the plan, change nothing
```

The script **cannot create an account**, refuses a suspended one, refuses to change an
existing role without `--force`, and writes an `audit_logs` row so the change appears in the
dashboard's own audit view. It builds the connection from `DATABASE_URL_UNPOOLED` (falling
back to `DATABASE_URL`) in `.env.local`, parsing the URL by parts so a password containing
`@`, `#` or `/` cannot be misread as a host.

Verify without SQL: `npm run admin:grant -- --email <address> --check` prints the current
administrator roster. Then open `/admin` (§7).

## [x] 5. Configure real email — done 2026-10-16, sending domain still open

**Done 2026-10-16:** the key is pasted and deployed, so mail really is sent.
`EMAIL_PROVIDER=log` is the fallback you get by emptying that key — it delivers **nothing**
while the API still answers "we sent a code". `/auth/request` reports `"delivered": false` in
that mode, and `/account` says so instead of pointing you at an empty inbox.

`.env.local` holds `EMAIL_PROVIDER=resend`, `EMAIL_FROM=Alpha AI Workspace
<onboarding@resend.dev>` and a live `RESEND_API_KEY`, so the deploy guard that refuses a resend
config with no key is satisfied. What is still missing is the sending **domain** — verify one at
resend.com/domains and point `EMAIL_FROM` at it, then deploy:

```powershell
npm run deploy
```

The deploy is **refused on purpose** while that line is empty, so a half-configured email
setup cannot reach production. Nothing else needs to change, and the key is never printed,
committed (`.env.local` is gitignored) or returned by any endpoint.

`onboarding@resend.dev` needs no domain verification, but Resend delivers from it only to the
address that owns the Resend account. Measured on 2026-10-16, a send to any other recipient is
rejected with **HTTP 403** and this body, which is quoted because it names the fix:

> You can only send testing emails to your own email address (martinssqeel@gmail.com). To send
> emails to other recipients, please verify a domain at resend.com/domains, and change the
> `from` address to an email using this domain.

403 is not retried, so the caller gets an honest `502 email_delivery_failed`, the one-time code
is retired, and the message reaches the function logs as `status=403` with no key material in it.

**This is the gate on real sign-up.** Until a domain is verified in Resend → Domains, sign-in by
email works **only** for `martinssqeel@gmail.com` — every other address is refused. Google and
GitHub sign-in are unaffected and already work for everybody, so that is the fallback meanwhile.
Once a domain is verified, set `EMAIL_FROM` to an address on it and deploy again.

`WEB_ACCOUNT_URL` is already the website origin, so emailed links land on `/account` rather
than the desktop app's `alpha://auth/callback` link. Clear it to send people to the app instead.

There is deliberately no password-reset email: ordinary accounts have no password (email
code, Google or GitHub only), and the only password in the system is the administrator's,
which is seeded on this machine with `npm run admin:password` — a stronger path than an
emailed reset link for an account that can see every user.

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
   `https://alpha-website-lime.vercel.app/auth/google/callback`
   The site URL, not the Function's own host: `vercel.json` rewrites `/auth/*`
   through to the Function, so this keeps the whole flow on the site origin the
   browser already has. (The raw Function URL works too — the callback route
   forwards on to `state.url` either way — but then the callback response is
   cross-origin, which buys nothing.) Whichever you register **must match the
   deployed `GOOGLE_REDIRECT_URI` byte for byte**; see §7c.
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

### 7c. The callback URL is one string, and it has to be the callback route

Observed on 2026-10-16: **both** Google and GitHub sign-in stopped working at once.
`.env.local` held

```
GOOGLE_REDIRECT_URI=https://alpha-website-lime.vercel.app
GITHUB_REDIRECT_URI=https://alpha-website-lime.vercel.app
```

— the site **origin**, with the `/auth/<provider>/callback` path missing. Since the
API sends that string to the provider verbatim (`oauthRedirectUri` in `platform/api/auth.ts`
returns the configured value as-is), the two providers failed differently but
equally silently:

* Google refuses the request outright and redirects to
  `accounts.google.com/signin/oauth/error?authError=…` carrying
  `redirect_uri_mismatch`, because its console has the callback route registered, not
  the bare origin. The page the user sees never mentions our name.
* GitHub shows its normal sign-in page and only checks the callback *after* login, so
the code comes back to `/` — where no script exchanges it. Nothing appears to fail;
sign-in simply does nothing.

The one-line fix is the path: `https://alpha-website-lime.vercel.app/auth/google/callback`
and the `github` equivalent, then `npm run deploy` (the redirect values are pushed from
`.env.local`; editing the file alone changes nothing live).

**How to check it without signing in as anybody.** Ask the provider directly and read
its own verdict:

```powershell
npm run check:oauth        # ACCEPTED / REJECTED per provider, never prints a secret
```

Then confirm what the deployment is actually serving, and what Google makes of it:

```powershell
$start = Invoke-WebRequest -MaximumRedirection 0 -SkipHttpErrorCheck \
  "https://br-flat-morning-b41hcfhc-api.compute.c-6.us-east-2.aws.neon.tech/auth/google/start?redirect=https%3A%2F%2Falpha-website-lime.vercel.app%2Faccount"
# read redirect_uri out of $start.Headers.Location — it must end /auth/google/callback
```

Following that `Location` once more is the decisive test: a Google **sign-in page**
means the URI is registered, while `/signin/oauth/error` means it is not. GitHub cannot
be probed this way — it validates the callback only after login, so confirming GitHub
still needs one real sign-in.

`npm run deploy` now **refuses** an env whose callback is not the callback route
(rule in `scripts/envRules.mjs`, tests in `tests/deployEnvRules.test.ts`), so this
particular outage cannot be deployed a second time. It cannot catch the other half:
a console where the registered URI disagrees with the deployed one. Only a real
sign-in proves that.

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
npm run verify:admin                          # 15 checks; creates + deletes temp accounts
```

`verify:admin` is the check that the portal is not decorative: it flips a feature flag, an
announcement, the application-version setting, maintenance mode and an account status
through the portal's own REST routes and reads each one back through `/platform/config`,
`/downloads/latest` and `/auth/request`. It restores every `system_settings` value it
touched and prints the restored rows.

**Rewritten on 2026-10-17, not yet run against production.** It had been calling
`POST /admin/rpc`, which the admin API stopped serving when the portal moved to REST
(`/admin/overview`, `/admin/settings`, `/admin/flags`, …), so every check failed for a reason
that described the script. The calls now match `website/assets/admin.js` route for route, and
the script probes all nine routes with its ordinary throwaway session before changing
anything — an existing route answers `403`, a removed one `404`, and the run stops there.
`tests/adminRouteParity.test.ts` enforces the same mapping without touching a deployment.

The live run is left to you because it writes: it creates two `@example.invalid` accounts,
flips maintenance mode for a few seconds and deletes both accounts again. Run it when that is
acceptable, then check the `restore:` lines it prints (settings row count, flag removed,
zero leftover test accounts).

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
