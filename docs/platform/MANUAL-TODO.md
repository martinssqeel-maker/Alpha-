# MANUAL TODO — Neon deployment (go live)

Ordered runbook. Everything here requires only account/secret holder action. Tick as you go.

## Values to gather

```
NEON_PROJECT           = alpha-platform (billowing-brook-66269785)
NEON_BRANCH            = production (br-flat-morning-b41hcfhc)
NEON_FUNCTION_API_BASE_URL = https://br-flat-morning-b41hcfhc-api.compute.c-6.us-east-2.aws.neon.tech
API_BASE_URL           = $NEON_FUNCTION_API_BASE_URL
WEBSITE_URL            = https://____________________   (Vercel domain)
ADMIN_EMAIL            = ____________________   (bootstrap admin)
RESEND_API_KEY         = re___________________   (optional; email defaults to log)
PROVIDER_API_KEY_OPENAI      = sk-________________
PROVIDER_API_KEY_ANTHROPIC   = sk-ant-____________
PROVIDER_API_KEY_GROQ        = gsk_________________
```

---

## [ ] 1. Rotate exposed secrets (critical)
- **Neon MCP API key**: `neon api-keys list` (or console) → revoke `3418620` (account-wide key minted by `neon mcp`). Create new if needed.
- **GitHub fine-grained token `GH_TOKEN`**: revoke old, issue new scoped to `martinssqeel-maker` (repo + workflow). Update local env: `[Environment]::SetEnvironmentVariable("GH_TOKEN", "<new-token>", "User")`.

---

## [ ] 2. Verify Neon schema + seed
Neon DB is already applied (`production` branch). Quick sanity check (Neon SQL Editor):
```sql
select count(*) from public.users;
select count(*) from public.plans;
select code, active from public.ai_providers;
```
Expect plans: `free, pro, team`; providers: `openai, anthropic, groq` active.

---

## [ ] 3. Add provider API keys (env for Function)
Function reads provider keys via `PROVIDER_API_KEY_<CODE_UPPER>`. Add to `.env.local` (local dev) and set as Function secrets when needed. Current `neon.ts` allows keys in env; to update deployed Function later, run `neon deploy` after setting env in shell.

Set locally: `.env.local` already has auth/email. Add provider keys if not present.

---

## [ ] 4. Bootstrap admin user
If `ADMIN_EMAIL` not yet owner, promote via SQL (Neon SQL Editor):
```sql
insert into public.admin_users (user_id, role_id)
select u.id, r.id
from public.users u
join public.admin_roles r on r.code='owner'
where lower(u.email)=lower('$ADMIN_EMAIL')
  and not exists (select 1 from public.admin_users au where au.user_id=u.id)
on conflict (user_id) do nothing;
```

Verify:
```sql
select u.email, r.code from public.admin_users au
join public.users u on u.id=au.user_id
join public.admin_roles r on r.id=au.role_id;
```

---

## [ ] 5. Configure email (optional production)
Default `EMAIL_PROVIDER=log` (dev). For production, set `EMAIL_PROVIDER=resend`, `RESEND_API_KEY`, `EMAIL_FROM` (verified sender). Update `.env.local` and redeploy: `neon deploy`.

---

## [ ] 6. Website: set API base URL (Vercel)
Vercel project root `website`. Environment Variables (Production + Preview):
- `API_BASE_URL = $NEON_FUNCTION_API_BASE_URL`

Redeploy. Verify `https://<website>/account` loads (no "not configured" notice).

---

## [ ] 7. Admin dashboard: set API base URL
Admin reads `VITE_API_BASE_URL`. For production build:
```powershell
cd admin
$env:VITE_API_BASE_URL="$NEON_FUNCTION_API_BASE_URL"
npm run build
```
Host `admin/dist/` (private). Or deploy via preferred static host.

---

## [ ] 8. Desktop app: connect to Alpha Cloud
In the installed app → **Settings → Alpha Cloud (platform)**:
- Enable
- Set **API base URL** = `$NEON_FUNCTION_API_BASE_URL`
- Save

Then **Account →** enter email → open emailed link (OTP/magic link). App signs in using Neon Function API.

---

## [ ] 9. Install v1.0.3 (desktop)
- Uninstall **Alpha AI Workspace** (Programs & Features) — removes `C:\Program Files\Alpha AI Workspace` (v1.0.2).
- Install latest: https://github.com/martinssqeel-maker/Alpha-/releases/download/v1.0.3/Alpha-AI-Workspace-Setup-1.0.3.exe

---

## [ ] 10. End-to-end smoke (quick)
1. Website `/account` — request OTP, verify magic link works.
2. Desktop signed in — **Account** shows plan `Free`, models list (if any allowed), no errors.
3. Chat with gateway — free plan blocks cloud models (expect 402 `plan_required`) until upgraded. With provider keys + entitlements, requests stream via `/gateway/chat/completions`.
4. Admin dashboard — sign in as owner, load Overview/Users/Catalog/Audit (all RPCs via `/admin/rpc`).

---

### Completion
Once 1–10 done, platform is running on Neon (API + Postgres) as source of truth. Use `docs/platform/verification.md` for detailed checks if needed.
