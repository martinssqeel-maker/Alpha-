# Platform environment & deployment

## 1. Create the Supabase project (MANUAL — only you can do this)

1. Go to https://supabase.com/dashboard → **New project**. Pick an
   organisation, name (e.g. `alpha-platform`), a strong DB password, and a
   region close to your users. Wait for provisioning.
2. Project settings → **API**: copy
   - **Project URL** (e.g. `https://abcd1234.supabase.co`)
   - **anon / publishable key** (safe for clients)
   - **service_role key** (SECRET — server-side only; never commit)

## 2. Push the schema

Local machine (one-off) with the service role key:

```bash
npm i -g supabase          # or use npx
supabase login
supabase link --project-ref <your-project-ref>
supabase db push           # applies supabase/migrations/*.sql
```

## 3. Deploy the AI gateway + provider keys

Set one secret per provider whose `ai_providers.api_key_env` you configured,
then deploy:

```bash
supabase secrets set PROVIDER_API_KEY_OPENAI=sk-... PROVIDER_API_KEY_ANTHROPIC=sk-ant-... PROVIDER_API_KEY_GROQ=gsk_...
supabase functions deploy ai-gateway
```

`SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` are injected automatically.

## 4. Configure Auth redirects

Supabase Dashboard → **Authentication → URL configuration**:
- Site URL: your Vercel site URL (e.g. `https://alpha-ai-workspace.vercel.app`)
- Redirect URLs: `https://alpha-ai-workspace.vercel.app/account` and
  `alpha://auth/callback`  ← the desktop deep link

(These mirror `supabase/config.toml`.)

## 5. Bootstrap the first admin

1. Sign up once from the website account page with your admin email.
2. In the Supabase SQL editor, either set the bootstrap email *before* first
   sign-in:
   ```sql
   update public.system_settings
      set value = '"you@example.com"'::jsonb
    where key = 'bootstrap_admin_email';
   ```
   or grant the role directly:
   ```sql
   insert into public.admin_users (user_id, role_id)
   select id, (select id from public.admin_roles where code = 'owner')
     from auth.users where email = 'you@example.com'
   on conflict (user_id) do nothing;
   ```

## 6. Website (Vercel)

- Root directory: `website`
- Environment variables (Production/Preview):
  - `SUPABASE_URL` = your project URL
  - `SUPABASE_ANON_KEY` = your anon/publishable key
- `website/vercel.json` runs `node gen-config.mjs` at build time, which writes
  the (gitignored) `website/config.js`.

## 7. Admin dashboard

```bash
cd admin
cp .env.example .env          # VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY
npm install
npm run dev                   # local
npm run build                 # → admin/dist (deploy anywhere static)
```

Guard the deployment: only staff should reach it. The RPCs are safe regardless
(every call is `require_admin`-checked), but keep the URL private.

## 8. Desktop app

In the app: **Settings → Alpha Cloud (platform)** →
- enable, set **Supabase project URL** and **anon key**
(Or pre-seed defaults in `src/main/services/store.ts` → `DEFAULT_SETTINGS.platform`.)
Then **Account → enter email → open the emailed link**. The app registers the
`alpha://` protocol on install; the magic link returns you to the app signed in.

## Environment summary

| Variable | Where | Secret? |
| --- | --- | --- |
| `SUPABASE_URL` | Vercel build, admin `.env` | no |
| `SUPABASE_ANON_KEY` / `VITE_SUPABASE_ANON_KEY` | Vercel build, admin `.env` | no |
| `SUPABASE_SERVICE_ROLE_KEY` | edge functions (auto), CI migrations | **yes** |
| `PROVIDER_API_KEY_<CODE>` | edge function secrets | **yes** |
| `GH_TOKEN` | local release publishing | **yes** |
