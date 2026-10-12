-- ---------------------------------------------------------------------------
-- 0002: Google sign-in, administrator passwords, throttling, releases
--
-- Additive only. Nothing here alters or drops an existing table, so accounts,
-- sessions and subscriptions created by 0001 keep working unchanged.
-- ---------------------------------------------------------------------------

-- External identity links (Google now; other providers later).
--   unique (provider, provider_user_id) is what prevents a second account being
--   created for the same Google identity, and provision_user() keeps one user
--   row per email, so a Google sign-in and an existing email sign-in converge on
--   the *same* account rather than forking it.
create table if not exists public.user_identities (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  provider text not null,
  provider_user_id text not null,
  email text,
  created_at timestamptz not null default now(),
  last_used_at timestamptz not null default now(),
  unique (provider, provider_user_id)
);
create index if not exists idx_user_identities_user on public.user_identities(user_id);

-- Administrator passwords. Only a scrypt digest is stored; there is no API
-- endpoint that can write this table — it is seeded by scripts/admin-password.mjs
-- running on the operator's machine with database credentials.
create table if not exists public.password_credentials (
  user_id uuid primary key references public.users(id) on delete cascade,
  password_hash text not null,
  algo text not null default 'scrypt',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
drop trigger if exists trg_password_credentials_touch on public.password_credentials;
create trigger trg_password_credentials_touch before update on public.password_credentials
  for each row execute function public.touch_updated_at();

-- Login throttling for the credential-based paths.
create table if not exists public.auth_attempts (
  id bigint generated always as identity primary key,
  scope text not null,
  key text not null,
  succeeded boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists idx_auth_attempts_lookup on public.auth_attempts(scope, key, created_at desc);

-- Single-use codes handed to the browser after an external sign-in, so a session
-- token never travels in a URL or lands in browser history.
create table if not exists public.auth_oauth_codes (
  id uuid primary key default gen_random_uuid(),
  code_hash text not null,
  user_id uuid not null references public.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  consumed_at timestamptz
);
create unique index if not exists idx_auth_oauth_codes_hash on public.auth_oauth_codes(code_hash);

-- Desktop releases. The download surface reads this table, so publishing a
-- release is an administrative act rather than a link hard-coded in the website.
create table if not exists public.releases (
  id uuid primary key default gen_random_uuid(),
  version text not null,
  channel text not null default 'stable',
  platform text not null default 'win',
  notes text,
  installer_url text not null,
  installer_size bigint,
  sha512 text,
  minimum_supported_version text,
  published boolean not null default true,
  released_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (version, channel, platform)
);
drop trigger if exists trg_releases_touch on public.releases;
create trigger trg_releases_touch before update on public.releases
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- identity linking
-- ---------------------------------------------------------------------------
create or replace function public.link_identity(
  p_provider text,
  p_provider_user_id text,
  p_email text,
  p_full_name text default null
)
returns uuid language plpgsql security definer set search_path = public as $$
declare uid uuid;
begin
  if coalesce(p_provider,'') = '' or coalesce(p_provider_user_id,'') = '' then
    raise exception 'identity_required' using errcode = '22023';
  end if;
  if coalesce(p_email,'') = '' then
    raise exception 'email_required' using errcode = '22023';
  end if;

  select user_id into uid
    from public.user_identities
   where provider = p_provider and provider_user_id = p_provider_user_id;

  if uid is null then
    -- Idempotent: returns the existing account when the email already exists.
    uid := public.provision_user(p_email);
    insert into public.user_identities (user_id, provider, provider_user_id, email)
    values (uid, p_provider, p_provider_user_id, lower(p_email))
    on conflict (provider, provider_user_id) do update set last_used_at = now()
    returning user_id into uid;
    if p_full_name is not null then
      update public.users set full_name = coalesce(full_name, p_full_name) where id = uid;
    end if;
  else
    update public.user_identities
       set last_used_at = now(), email = lower(p_email)
     where provider = p_provider and provider_user_id = p_provider_user_id;
  end if;

  return uid;
end $$;

-- ---------------------------------------------------------------------------
-- releases
-- ---------------------------------------------------------------------------
create or replace function public.latest_release(
  p_channel text default 'stable',
  p_platform text default 'win'
)
returns jsonb language sql stable security definer set search_path = public as $$
  select to_jsonb(r) - 'id'
    from public.releases r
   where r.channel = p_channel and r.platform = p_platform and r.published
   order by r.released_at desc
   limit 1
$$;

create or replace function public.admin_list_releases()
returns jsonb language plpgsql security definer set search_path = public as $$
declare actor uuid := public.require_admin('releases.read');
begin
  return coalesce((
    select jsonb_agg(to_jsonb(r) order by r.released_at desc)
      from public.releases r
  ), '[]'::jsonb);
end $$;

create or replace function public.admin_upsert_release(p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare actor uuid := public.require_admin('releases.write'); rid uuid;
        v text := nullif(p->>'version','');
        url text := coalesce(nullif(p->>'installerUrl',''), '');
begin
  if v is null then
    raise exception 'version_required' using errcode = '22023';
  end if;
  if url = '' then
    raise exception 'installer_url_required' using errcode = '22023';
  end if;
  -- Only https installer links are accepted; the API additionally refuses to
  -- serve any URL that is not on a known release-asset host.
  if url !~ '^https://' then
    raise exception 'installer_url_must_be_https' using errcode = '22023';
  end if;

  insert into public.releases (
    version, channel, platform, notes, installer_url, installer_size, sha512,
    minimum_supported_version, published, released_at
  ) values (
    v,
    coalesce(nullif(p->>'channel',''), 'stable'),
    coalesce(nullif(p->>'platform',''), 'win'),
    nullif(p->>'notes',''),
    url,
    nullif(p->>'installerSize','')::bigint,
    nullif(p->>'sha512',''),
    nullif(p->>'minimumSupportedVersion',''),
    coalesce((p->>'published')::boolean, true),
    now()
  )
  on conflict (version, channel, platform) do update set
    notes = excluded.notes,
    installer_url = excluded.installer_url,
    installer_size = excluded.installer_size,
    sha512 = excluded.sha512,
    minimum_supported_version = excluded.minimum_supported_version,
    published = excluded.published,
    released_at = excluded.released_at,
    updated_at = now()
  returning id into rid;

  insert into public.audit_logs (actor_id, action, target, detail)
  values (actor, 'release.upsert', rid::text, p);

  return public.latest_release();
end $$;

-- ---------------------------------------------------------------------------
-- permission for release management
-- ---------------------------------------------------------------------------
insert into public.admin_permissions (code, label) values
  ('releases.read', 'View desktop releases'),
  ('releases.write', 'Publish desktop releases')
on conflict (code) do nothing;

insert into public.admin_role_permissions (role_id, permission_id)
select r.id, p.id
  from public.admin_roles r
  join public.admin_permissions p on p.code in ('releases.read','releases.write')
 where r.code in ('owner','admin')
on conflict do nothing;

insert into public.admin_role_permissions (role_id, permission_id)
select r.id, p.id
  from public.admin_roles r
  join public.admin_permissions p on p.code = 'releases.read'
 where r.code = 'support'
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- seed: the release that is currently published on GitHub
-- ---------------------------------------------------------------------------
insert into public.releases (
  version, channel, platform, notes, installer_url, installer_size, sha512,
  minimum_supported_version, published, released_at
) values (
  '1.0.4',
  'stable',
  'win',
  'Fixes the invisible splash overlay that froze the window, and routes seven mis-keyed IPC channels to their handlers.',
  'https://github.com/martinssqeel-maker/Alpha-/releases/download/v1.0.4/Alpha-AI-Workspace-Setup-1.0.4.exe',
  125197395,
  'gXu0+2uo9Ge0bVkHlPBz7hTmwTlFVaq8la1N0nDxvGcuikmjUqoVVSGhbiBDakm7pY0LUfDepsnOOAKTyJcuRg==',
  '1.0.4',
  true,
  '2026-10-12T21:49:16Z'
)
on conflict (version, channel, platform) do nothing;
