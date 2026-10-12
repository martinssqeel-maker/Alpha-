# Platform environment & deployment

Everything here is Neon. There is no Supabase project, no edge function and no
anon/service-role key pair any more.

## 1. What already exists

| Thing | Value |
| --- | --- |
| Neon project | `alpha-platform` (`billowing-brook-66269785`) |
| Branch | `production` (`br-flat-morning-b41hcfhc`) |
| Function | `alpha-platform-api` (slug `api`), region `aws-us-east-2` |
| API base URL | `https://br-flat-morning-b41hcfhc-api.compute.c-6.us-east-2.aws.neon.tech` |
| Schema | `database/migrations/0001_platform.sql` |
| Local env file | `.env.local` (gitignored — the source of truth for Function env) |

The Neon-managed variables (`DATABASE_URL`, `DATABASE_URL_UNPOOLED`, `NEON_BRANCH`,
`NEON_FUNCTION_API_BASE_URL`) are injected by the platform. Never set them yourself.

## 2. Configure `.env.local`

Copy `.env.example` to `.env.local` and fill it in. The rules that actually bite:

- **`neon.ts` forwards only the keys it lists *and* that are present.** A key you delete
  from `.env.local` is **left as-is on the live Function**. To turn something off you
  must set it explicitly (`AUTH_DEV_ECHO_OTP=0`), never remove the line.
- An **empty assignment deletes the live key** (`AUTH_PEPPER=` uploads `""`).
- `npm run deploy -- --check` validates all of this and prints key *names* only.

Required: `AUTH_JWT_SECRET` (32+ random bytes) and `AUTH_PEPPER`. See `.env.example`
for the full list with defaults.

## 3. Deploy the Function

```bash
npm run deploy              # validate, then `neon deploy`
npm run deploy -- --plan    # read-only diff (`neon config plan`)
npm run deploy -- --check   # validate .env.local, deploy nothing
```

⚠️ The documented `neon deploy --env .env.local` **does not work on CLI 8.3.5**: the
`--env` flag fails to load the file and the config then throws
`AUTH_JWT_SECRET is required`. `scripts/deploy.mjs` reads `.env.local` (CRLF and quoted
values handled), validates it, then passes the values to `neon deploy` through the child
process environment — the path that works. It also **refuses to deploy** when
`AUTH_DEV_ECHO_OTP` is truthy, since that would hand live sign-in codes to any caller.

Deploy to the `production` branch. `neon config plan` shows what would change.

## 4. Database schema

The schema is already applied to the `production` branch. For a fresh branch/database:

```bash
npm run db:migrate        # node scripts/db-migrate.mjs, uses DATABASE_URL_UNPOOLED
```

Sanity check afterwards (Neon SQL editor):

```sql
select count(*) from public.users;
select code, active from public.plans;          -- expect free, pro, team
select code, active from public.ai_providers;   -- expect openai, anthropic, groq
```

## 5. Provider credentials for the gateway

Preferred: enable the **Neon AI Gateway** on the branch and set
`NEON_AI_GATEWAY_BASE_URL` + `NEON_AI_GATEWAY_TOKEN`. Otherwise add per-provider keys
whose names match each provider row's `api_key_env` column (default
`PROVIDER_API_KEY_<CODE>`), e.g. `PROVIDER_API_KEY_OPENAI`.

Without one of the two, `/gateway/chat/completions` returns `502 provider_unavailable`
for every model. It is a configuration gap, not a code fault.

## 6. Website (Vercel)

- **Root directory:** `website`, framework preset *Other*, and **no build command**.
  `vercel.json` only sets clean URLs and the security headers.
- `website/config.js` is **committed** and served as a plain static file, so a deployment
  needs no environment variables and no build step. It points at the production Function
  URL above.
- If the Function URL ever changes:
  `API_BASE_URL=<new url> node website/gen-config.mjs`, then commit the regenerated file.
- History: the Neon migration added `"buildCommand": "node gen-config.mjs"` to
  `vercel.json`, and **every** production deployment failed from `4c4321a` onward
  (`npx vercel inspect <deployment> --logs`). Serving the committed config and dropping
  the command restored successful deployments (`07e3801`).

### Website sign-in and downloads

`/account.html` and `/download.html` offer only the methods the deployment actually
supports, discovered from `GET /auth/providers`:

- **Google** — needs `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET` (below). While they are
  unset the API answers `503 google_not_configured` and the button is hidden.
- **Emailed one-time link** — the original path, still present. `EMAIL_PROVIDER=log`
  means no mail is actually sent (see §5).
- **Downloads** are authenticated: `/downloads/latest` returns the published release for a
  signed-in *active* account, `401` anonymously and `403` when the account is suspended.
  Publishing a release is a row in `public.releases` (seeded with `1.0.4`); the website
  never links to an installer asset directly.

## 7. Admin dashboard

```bash
cd admin
cp .env.example .env.local     # set VITE_API_BASE_URL to the Function URL
npm install
npm run dev                    # local
npm run build                  # → admin/dist (deploy to any static host)
```

**Sign-in is an administrator email + password** (not the emailed link). The account must
already exist and already hold an admin role; the password is set locally so it never
travels through the API, the shell or chat:

```bash
npm run admin:password                 # prompts for the email and a hidden password
npm run admin:password -- --revoke     # remove the credential
```

Only a scrypt digest reaches `public.password_credentials`. The API re-checks the admin
role in the database on every request and throttles failed attempts per email and per
address, so this path cannot be used to promote an ordinary account.

When you host the dashboard somewhere other than `http://localhost:5173`, add that origin
to `ALLOWED_ORIGINS` — otherwise the browser will refuse its API calls.

Guard the deployment (only staff should reach it), but note the RPCs are safe
regardless: every call is `require_admin`-checked in the database.

## 8. Desktop app

**Settings → Alpha Cloud (platform)** → enable, set **API base URL** to the Function URL,
save. Then **Account → enter email → open the emailed link**; the `alpha://` protocol
handler returns focus to the app signed in. The installer registers `alpha://`
independently, and the server emits `alpha://auth/callback` unless `WEB_ACCOUNT_URL` is
set — so changing the scheme requires matching changes in both places.

## 9. Environment summary

| Variable | Where it lives | Secret? |
| --- | --- | --- |
| `AUTH_JWT_SECRET` | Function env (`.env.local`) | **yes** |
| `AUTH_PEPPER` | Function env (`.env.local`) | **yes** |
| `AUTH_DEV_ECHO_OTP` | Function env — must be `0`/unset in production | no, but dangerous |
| `ALLOWED_ORIGINS` | Function env — real website + admin origins | no |
| `EMAIL_PROVIDER` / `RESEND_API_KEY` / `EMAIL_FROM` | Function env | `RESEND_API_KEY` **yes** |
| `WEB_ACCOUNT_URL` | Function env | no |
| `NEON_AI_GATEWAY_BASE_URL` / `_TOKEN` | Function env | token **yes** |
| `PROVIDER_API_KEY_<CODE>` | Function env | **yes** |
| `API_BASE_URL` | only when regenerating `website/config.js` | no |
| `GOOGLE_CLIENT_ID` | Function env — enables Google sign-in | no |
| `GOOGLE_CLIENT_SECRET` | Function env — enables Google sign-in | **yes** |
| `AUTH_APP_SCHEME` | Function env — desktop deep-link scheme (`alpha`) | no |
| `VITE_API_BASE_URL` | `admin/.env.local` (build time) | no |
| `GH_TOKEN` | local shell only, for publishing a release | **yes** |

## 10. Check it

```bash
npm run smoke                                        # read-only, safe against production
npm run smoke -- --website https://<site>            # also verify config.js
npm run smoke -- --email you@example.com             # also exercise sign-in (sends mail)
```
