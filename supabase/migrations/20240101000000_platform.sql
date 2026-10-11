-- Alpha AI Workspace — platform schema
-- Backend is the source of truth for accounts, plans, entitlements, usage,
-- the AI provider/model catalog and the admin control plane.
--
-- Security model:
--   * Row Level Security is enabled on every table.
--   * Tables are NOT directly readable by anon/authenticated except a small
--     read-only catalog (plans, providers, models, flags, announcements).
--   * All privileged reads/writes go through SECURITY DEFINER RPCs that check
--     admin permissions (require_admin) and write an audit_logs row.
--   * The desktop/website only ever call RPCs with the user's own JWT; the
--     service role key is used exclusively server-side (edge function).

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- helpers
-- ---------------------------------------------------------------------------
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

-- ---------------------------------------------------------------------------
-- identity: profiles
-- ---------------------------------------------------------------------------
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  full_name text,
  status text not null default 'active' check (status in ('active','suspended','disabled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
drop trigger if exists trg_profiles_touch on public.profiles;
create trigger trg_profiles_touch before update on public.profiles
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- plans / features / limits
--   plan_features.feature keys beginning with 'limit.' are numeric limits;
--   all other keys are boolean/JSON features.
-- ---------------------------------------------------------------------------
create table if not exists public.plans (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  description text,
  interval text not null default 'month',
  price_cents integer not null default 0,
  is_trial boolean not null default false,
  trial_days integer not null default 0,
  sort integer not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
drop trigger if exists trg_plans_touch on public.plans;
create trigger trg_plans_touch before update on public.plans
  for each row execute function public.touch_updated_at();

create table if not exists public.plan_features (
  plan_id uuid not null references public.plans(id) on delete cascade,
  feature text not null,
  value jsonb not null default 'true'::jsonb,
  primary key (plan_id, feature)
);

create table if not exists public.subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  plan_id uuid not null references public.plans(id),
  status text not null default 'active'
    check (status in ('active','trialing','past_due','canceled','incomplete','paused')),
  provider text,
  provider_ref text,
  current_period_start timestamptz not null default now(),
  current_period_end timestamptz,
  cancel_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_subscriptions_user on public.subscriptions(user_id);
drop trigger if exists trg_subscriptions_touch on public.subscriptions;
create trigger trg_subscriptions_touch before update on public.subscriptions
  for each row execute function public.touch_updated_at();

create table if not exists public.entitlement_overrides (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  feature text not null,
  value jsonb not null,
  reason text,
  ends_at timestamptz,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);
create index if not exists idx_overrides_user on public.entitlement_overrides(user_id);

-- ---------------------------------------------------------------------------
-- usage
-- ---------------------------------------------------------------------------
create table if not exists public.usage_counters (
  user_id uuid not null references auth.users(id) on delete cascade,
  resource text not null,
  period_start date not null default date_trunc('month', now())::date,
  used numeric not null default 0,
  updated_at timestamptz not null default now(),
  primary key (user_id, resource, period_start)
);
create index if not exists idx_usage_user on public.usage_counters(user_id, period_start);

-- ---------------------------------------------------------------------------
-- AI catalog
-- ---------------------------------------------------------------------------
create table if not exists public.ai_providers (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  label text not null,
  kind text not null default 'openai'
    check (kind in ('openai','anthropic','google','openai-compatible')),
  base_url text,
  api_key_env text,
  active boolean not null default true,
  sort integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
drop trigger if exists trg_ai_providers_touch on public.ai_providers;
create trigger trg_ai_providers_touch before update on public.ai_providers
  for each row execute function public.touch_updated_at();

create table if not exists public.ai_models (
  id uuid primary key default gen_random_uuid(),
  provider_id uuid not null references public.ai_providers(id) on delete cascade,
  model_id text not null,
  label text not null,
  capabilities jsonb not null default '{"streaming":true,"tools":false,"vision":false}'::jsonb,
  context_length integer,
  parameter_size text,
  family text,
  default_allowed boolean not null default false,
  active boolean not null default true,
  sort integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (provider_id, model_id)
);
drop trigger if exists trg_ai_models_touch on public.ai_models;
create trigger trg_ai_models_touch before update on public.ai_models
  for each row execute function public.touch_updated_at();

create table if not exists public.model_plan_access (
  model_id uuid not null references public.ai_models(id) on delete cascade,
  plan_id uuid not null references public.plans(id) on delete cascade,
  allowed boolean not null default true,
  primary key (model_id, plan_id)
);

create table if not exists public.model_user_access (
  model_id uuid not null references public.ai_models(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  allowed boolean not null default true,
  ends_at timestamptz,
  primary key (model_id, user_id)
);

-- ---------------------------------------------------------------------------
-- feature flags / system settings / announcements
-- ---------------------------------------------------------------------------
create table if not exists public.feature_flags (
  key text primary key,
  enabled boolean not null default true,
  description text,
  rollout integer not null default 100,
  updated_at timestamptz not null default now()
);

create table if not exists public.system_settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.announcements (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  body text not null default '',
  level text not null default 'info' check (level in ('info','warning','critical')),
  active boolean not null default true,
  starts_at timestamptz not null default now(),
  ends_at timestamptz,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- admin roles / permissions
-- ---------------------------------------------------------------------------
create table if not exists public.admin_roles (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  label text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.admin_permissions (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  label text not null
);

create table if not exists public.admin_role_permissions (
  role_id uuid not null references public.admin_roles(id) on delete cascade,
  permission_id uuid not null references public.admin_permissions(id) on delete cascade,
  primary key (role_id, permission_id)
);

create table if not exists public.admin_users (
  user_id uuid primary key references auth.users(id) on delete cascade,
  role_id uuid not null references public.admin_roles(id),
  created_at timestamptz not null default now()
);

create table if not exists public.audit_logs (
  id bigint generated always as identity primary key,
  actor_id uuid references auth.users(id),
  action text not null,
  target text,
  detail jsonb,
  created_at timestamptz not null default now()
);
create index if not exists idx_audit_created on public.audit_logs(created_at desc);

-- ---------------------------------------------------------------------------
-- devices
-- ---------------------------------------------------------------------------
create table if not exists public.devices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  platform text not null,
  app_version text,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  unique (user_id, platform)
);

-- ---------------------------------------------------------------------------
-- authorization helpers
-- ---------------------------------------------------------------------------
create or replace function public.is_admin(uid uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.admin_users a where a.user_id = uid)
$$;

create or replace function public.admin_has_permission(uid uuid, perm text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1
    from public.admin_users a
    join public.admin_role_permissions rp on rp.role_id = a.role_id
    join public.admin_permissions p on p.id = rp.permission_id
    where a.user_id = uid and p.code = perm
  )
$$;

create or replace function public.require_admin(perm text)
returns uuid language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid();
begin
  if uid is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;
  if not public.admin_has_permission(uid, perm) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return uid;
end $$;

-- ---------------------------------------------------------------------------
-- identity: profile sync + admin bootstrap + free plan
-- ---------------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  free_plan uuid;
  bootstrap text;
begin
  insert into public.profiles (id, email, full_name)
  values (new.id, new.email, coalesce(new.raw_user_meta_data->>'full_name', null))
  on conflict (id) do nothing;

  select id into free_plan from public.plans where code = 'free' limit 1;
  if free_plan is not null then
    insert into public.subscriptions (user_id, plan_id, status)
    values (new.id, free_plan, 'active');
  end if;

  select value #>> '{}' into bootstrap from public.system_settings where key = 'bootstrap_admin_email';
  if bootstrap is not null and lower(bootstrap) = lower(new.email) then
    insert into public.admin_users (user_id, role_id)
    select new.id, id from public.admin_roles where code = 'owner'
    on conflict (user_id) do nothing;
  end if;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- RPC: user-facing
-- ---------------------------------------------------------------------------
create or replace function public.upsert_device(p_platform text, p_app_version text)
returns void language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid();
begin
  if uid is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;
  insert into public.devices (user_id, platform, app_version)
  values (uid, p_platform, p_app_version)
  on conflict (user_id, platform)
  do update set app_version = excluded.app_version, last_seen_at = now();
end $$;

-- resolve a single feature/limit value for a user (override > plan > null)
create or replace function public.check_entitlement(p_user uuid, p_feature text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  val jsonb;
begin
  select value into val from public.entitlement_overrides
   where user_id = p_user and feature = p_feature
     and (ends_at is null or ends_at > now())
   order by created_at desc limit 1;
  if val is not null then return val; end if;

  select pf.value into val
    from public.subscriptions s
    join public.plan_features pf on pf.plan_id = s.plan_id
   where s.user_id = p_user and s.status in ('active','trialing')
     and pf.feature = p_feature
   order by s.created_at desc limit 1;
  if val is not null then return val; end if;

  select pf.value into val
    from public.plan_features pf
    join public.plans p on p.id = pf.plan_id
   where p.code = 'free' and pf.feature = p_feature
   limit 1;
  return val;
end $$;

create or replace function public.get_my_platform_config()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  prof public.profiles%rowtype;
  sub record;
  planrow public.plans%rowtype;
  features jsonb := '{}'::jsonb;
  limits jsonb := '{}'::jsonb;
  usage jsonb := '[]'::jsonb;
  models jsonb := '[]'::jsonb;
  flags jsonb := '{}'::jsonb;
  ann jsonb := '[]'::jsonb;
  maintenance jsonb;
  desktop jsonb;
  rec record;
  lim numeric;
begin
  if uid is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;

  select * into prof from public.profiles where id = uid;

  -- active subscription + plan
  select s.*, p.code as plan_code, p.name as plan_name, p.interval as plan_interval,
         p.is_trial as plan_is_trial
    into sub
    from public.subscriptions s
    join public.plans p on p.id = s.plan_id
   where s.user_id = uid and s.status in ('active','trialing')
   order by s.created_at desc limit 1;

  if sub is null then
    select * into planrow from public.plans where code = 'free' limit 1;
  end if;

  -- features + limits from plan
  if sub is not null then
    for rec in
      select pf.feature, pf.value from public.plan_features pf where pf.plan_id = sub.plan_id
    loop
      if rec.feature like 'limit.%' then
        limits := jsonb_set(limits, array[substring(rec.feature from 7)], rec.value, true);
      else
        features := jsonb_set(features, array[rec.feature], rec.value, true);
      end if;
    end loop;
  elsif planrow.id is not null then
    for rec in
      select pf.feature, pf.value from public.plan_features pf where pf.plan_id = planrow.id
    loop
      if rec.feature like 'limit.%' then
        limits := jsonb_set(limits, array[substring(rec.feature from 7)], rec.value, true);
      else
        features := jsonb_set(features, array[rec.feature], rec.value, true);
      end if;
    end loop;
  end if;

  -- entitlement overrides win over plan
  for rec in
    select feature, value from public.entitlement_overrides
     where user_id = uid and (ends_at is null or ends_at > now())
  loop
    if rec.feature like 'limit.%' then
      limits := jsonb_set(limits, array[substring(rec.feature from 7)], rec.value, true);
    else
      features := jsonb_set(features, array[rec.feature], rec.value, true);
    end if;
  end loop;

  -- usage for current period, joined with limits
  for rec in
    select u.resource, u.used from public.usage_counters u
     where u.user_id = uid and u.period_start = date_trunc('month', now())::date
     order by u.resource
  loop
    lim := null;
    if limits ? rec.resource and jsonb_typeof(limits->rec.resource) = 'number' then
      lim := (limits->>rec.resource)::numeric;
    end if;
    usage := usage || jsonb_build_array(jsonb_build_object(
      'resource', rec.resource,
      'used', rec.used,
      'limit', lim,
      'unlimited', lim is null
    ));
  end loop;
  -- include limits that have no usage row yet
  for rec in select key as resource from jsonb_each(limits) loop
    if not exists (select 1 from jsonb_array_elements(usage) e where e->>'resource' = rec.resource) then
      usage := usage || jsonb_build_array(jsonb_build_object(
        'resource', rec.resource, 'used', 0,
        'limit', (limits->>rec.resource)::numeric, 'unlimited', false));
    end if;
  end loop;

  -- model catalog with per-user access resolution
  for rec in
    select m.id, m.model_id, m.label, m.capabilities, m.context_length, m.parameter_size, m.family,
           m.default_allowed, m.sort,
           pr.code as provider_code, pr.label as provider_label,
           coalesce(
             (select mua.allowed from public.model_user_access mua
               where mua.model_id = m.id and mua.user_id = uid
                 and (mua.ends_at is null or mua.ends_at > now())
               limit 1),
             (select mpa.allowed from public.model_plan_access mpa
               where mpa.model_id = m.id and sub.plan_id is not null and mpa.plan_id = sub.plan_id
               limit 1),
             m.default_allowed
           ) as allowed
      from public.ai_models m
      join public.ai_providers pr on pr.id = m.provider_id
     where m.active and pr.active
     order by pr.sort, m.sort, m.label
  loop
    models := models || jsonb_build_array(jsonb_build_object(
      'modelId', rec.model_id,
      'providerId', rec.provider_code,
      'providerLabel', rec.provider_label,
      'label', rec.label,
      'allowed', coalesce(rec.allowed, false),
      'capabilities', rec.capabilities,
      'contextLength', rec.context_length
    ));
  end loop;

  -- flags
  for rec in select key, enabled from public.feature_flags where enabled loop
    flags := jsonb_set(flags, array[rec.key], to_jsonb(rec.enabled), true);
  end loop;

  -- announcements
  for rec in
    select id, title, body, level from public.announcements
     where active and starts_at <= now() and (ends_at is null or ends_at > now())
     order by created_at desc limit 10
  loop
    ann := ann || jsonb_build_array(jsonb_build_object(
      'id', rec.id, 'title', rec.title, 'body', rec.body, 'level', rec.level));
  end loop;

  select value into maintenance from public.system_settings where key = 'maintenance';
  select value into desktop from public.system_settings where key = 'desktop_versions';

  return jsonb_build_object(
    'account', case when prof.id is null then null else jsonb_build_object(
      'email', prof.email, 'fullName', prof.full_name, 'status', prof.status) end,
    'plan', case
      when sub is not null then jsonb_build_object(
        'id', sub.plan_id, 'name', sub.plan_name, 'code', sub.plan_code,
        'interval', sub.plan_interval, 'isTrial', sub.plan_is_trial)
      when planrow.id is not null then jsonb_build_object(
        'id', planrow.id, 'name', planrow.name, 'code', planrow.code,
        'interval', planrow.interval, 'isTrial', planrow.is_trial)
      else null end,
    'subscription', case when sub is not null then jsonb_build_object(
      'status', sub.status, 'endsAt', sub.current_period_end) else null end,
    'features', features,
    'limits', limits,
    'usage', usage,
    'models', models,
    'flags', flags,
    'maintenance', coalesce(maintenance, '{"active":false}'::jsonb),
    'announcements', ann,
    'desktop', coalesce(desktop, '{}'::jsonb),
    'serverTime', now()
  );
end $$;

-- record usage for a user (called by the AI gateway using the service role)
create or replace function public.record_usage(p_user uuid, p_resource text, p_amount numeric)
returns void language plpgsql security definer set search_path = public as $$
begin
  insert into public.usage_counters (user_id, resource, period_start, used)
  values (p_user, p_resource, date_trunc('month', now())::date, greatest(p_amount, 0))
  on conflict (user_id, resource, period_start)
  do update set used = public.usage_counters.used + greatest(p_amount, 0), updated_at = now();
end $$;

-- ---------------------------------------------------------------------------
-- RPC: admin
-- ---------------------------------------------------------------------------
create or replace function public.admin_overview()
returns jsonb language plpgsql security definer set search_path = public as $$
declare actor uuid := public.require_admin('overview.read');
begin
  return jsonb_build_object(
    'users', (select count(*) from public.profiles),
    'admins', (select count(*) from public.admin_users),
    'activeSubscriptions', (select count(*) from public.subscriptions where status in ('active','trialing')),
    'plans', (select count(*) from public.plans),
    'models', (select count(*) from public.ai_models),
    'providers', (select count(*) from public.ai_providers),
    'serverTime', now()
  );
end $$;

create or replace function public.admin_list_users(p_query text default null, p_limit integer default 100)
returns jsonb language plpgsql security definer set search_path = public as $$
declare actor uuid := public.require_admin('users.read');
begin
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', p.id, 'email', p.email, 'fullName', p.full_name, 'status', p.status,
      'createdAt', p.created_at,
      'plan', (select pl.name from public.subscriptions s join public.plans pl on pl.id = s.plan_id
                where s.user_id = p.id and s.status in ('active','trialing')
                order by s.created_at desc limit 1),
      'isAdmin', public.is_admin(p.id)
    ) order by p.created_at desc)
    from (
      select * from public.profiles
       where p_query is null or p_query = '' or email ilike '%' || p_query || '%'
          or full_name ilike '%' || p_query || '%'
       order by created_at desc limit p_limit
    ) p
  ), '[]'::jsonb);
end $$;

create or replace function public.admin_set_user_status(p_user uuid, p_status text)
returns void language plpgsql security definer set search_path = public as $$
declare actor uuid := public.require_admin('users.write');
begin
  if p_status not in ('active','suspended','disabled') then
    raise exception 'invalid_status' using errcode = '22023';
  end if;
  update public.profiles set status = p_status where id = p_user;
  insert into public.audit_logs (actor_id, action, target, detail)
  values (actor, 'user.set_status', p_user::text, jsonb_build_object('status', p_status));
end $$;

create or replace function public.admin_grant_override(p_user uuid, p_feature text, p_value jsonb, p_ends_at timestamptz default null, p_reason text default null)
returns void language plpgsql security definer set search_path = public as $$
declare actor uuid := public.require_admin('entitlements.write');
begin
  insert into public.entitlement_overrides (user_id, feature, value, ends_at, reason, created_by)
  values (p_user, p_feature, p_value, p_ends_at, p_reason, actor);
  insert into public.audit_logs (actor_id, action, target, detail)
  values (actor, 'entitlement.grant', p_user::text, jsonb_build_object('feature', p_feature, 'value', p_value, 'endsAt', p_ends_at, 'reason', p_reason));
end $$;

create or replace function public.admin_revoke_override(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare actor uuid := public.require_admin('entitlements.write');
begin
  delete from public.entitlement_overrides where id = p_id;
  insert into public.audit_logs (actor_id, action, target, detail)
  values (actor, 'entitlement.revoke', p_id::text, '{}'::jsonb);
end $$;

create or replace function public.admin_set_user_plan(p_user uuid, p_plan_code text, p_interval text default 'month', p_period_end timestamptz default null)
returns void language plpgsql security definer set search_path = public as $$
declare actor uuid := public.require_admin('subscriptions.write'); plan_id uuid;
begin
  select id into plan_id from public.plans where code = p_plan_code limit 1;
  if plan_id is null then raise exception 'plan_not_found' using errcode = '22023'; end if;
  update public.subscriptions set status = 'canceled'
   where user_id = p_user and status in ('active','trialing');
  insert into public.subscriptions (user_id, plan_id, status, current_period_end)
  values (p_user, plan_id, 'active', p_period_end);
  insert into public.audit_logs (actor_id, action, target, detail)
  values (actor, 'subscription.set_plan', p_user::text, jsonb_build_object('plan', p_plan_code, 'periodEnd', p_period_end));
end $$;

create or replace function public.admin_upsert_plan(p jsonb)
returns uuid language plpgsql security definer set search_path = public as $$
declare actor uuid := public.require_admin('plans.write'); pid uuid;
begin
  if p->>'id' is not null then
    pid := (p->>'id')::uuid;
    update public.plans set
      code = coalesce(p->>'code', code),
      name = coalesce(p->>'name', name),
      description = coalesce(p->>'description', description),
      interval = coalesce(p->>'interval', interval),
      price_cents = coalesce((p->>'priceCents')::int, price_cents),
      is_trial = coalesce((p->>'isTrial')::boolean, is_trial),
      active = coalesce((p->>'active')::boolean, active)
    where id = pid;
  else
    insert into public.plans (code, name, description, interval, price_cents, is_trial, active)
    values (p->>'code', p->>'name', p->>'description', coalesce(p->>'interval','month'),
            coalesce((p->>'priceCents')::int,0), coalesce((p->>'isTrial')::boolean,false),
            coalesce((p->>'active')::boolean,true))
    returning id into pid;
  end if;
  insert into public.audit_logs (actor_id, action, target, detail) values (actor, 'plan.upsert', pid::text, p);
  return pid;
end $$;

create or replace function public.admin_set_plan_feature(p_plan uuid, p_feature text, p_value jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare actor uuid := public.require_admin('plans.write');
begin
  if p_value is null then
    delete from public.plan_features where plan_id = p_plan and feature = p_feature;
  else
    insert into public.plan_features (plan_id, feature, value) values (p_plan, p_feature, p_value)
    on conflict (plan_id, feature) do update set value = excluded.value;
  end if;
  insert into public.audit_logs (actor_id, action, target, detail)
  values (actor, 'plan.feature', p_plan::text, jsonb_build_object('feature', p_feature, 'value', p_value));
end $$;

create or replace function public.admin_upsert_provider(p jsonb)
returns uuid language plpgsql security definer set search_path = public as $$
declare actor uuid := public.require_admin('providers.write'); pid uuid;
begin
  if p->>'id' is not null then
    pid := (p->>'id')::uuid;
    update public.ai_providers set
      code = coalesce(p->>'code', code), label = coalesce(p->>'label', label),
      kind = coalesce(p->>'kind', kind), base_url = coalesce(p->>'baseUrl', base_url),
      api_key_env = coalesce(p->>'apiKeyEnv', api_key_env),
      active = coalesce((p->>'active')::boolean, active)
    where id = pid;
  else
    insert into public.ai_providers (code, label, kind, base_url, api_key_env, active)
    values (p->>'code', p->>'label', coalesce(p->>'kind','openai'), p->>'baseUrl', p->>'apiKeyEnv',
            coalesce((p->>'active')::boolean,true))
    returning id into pid;
  end if;
  insert into public.audit_logs (actor_id, action, target, detail) values (actor, 'provider.upsert', pid::text, p);
  return pid;
end $$;

create or replace function public.admin_upsert_model(p jsonb)
returns uuid language plpgsql security definer set search_path = public as $$
declare actor uuid := public.require_admin('models.write'); mid uuid;
begin
  if p->>'id' is not null then
    mid := (p->>'id')::uuid;
    update public.ai_models set
      model_id = coalesce(p->>'modelId', model_id),
      label = coalesce(p->>'label', label),
      capabilities = coalesce(p->'capabilities', capabilities),
      context_length = coalesce((p->>'contextLength')::int, context_length),
      default_allowed = coalesce((p->>'defaultAllowed')::boolean, default_allowed),
      active = coalesce((p->>'active')::boolean, active)
    where id = mid;
  else
    insert into public.ai_models (provider_id, model_id, label, capabilities, context_length, default_allowed, active)
    values ((p->>'providerId')::uuid, p->>'modelId', p->>'label',
            coalesce(p->'capabilities','{"streaming":true,"tools":false,"vision":false}'::jsonb),
            (p->>'contextLength')::int, coalesce((p->>'defaultAllowed')::boolean,false),
            coalesce((p->>'active')::boolean,true))
    returning id into mid;
  end if;
  insert into public.audit_logs (actor_id, action, target, detail) values (actor, 'model.upsert', mid::text, p);
  return mid;
end $$;

create or replace function public.admin_set_model_plan_access(p_model uuid, p_plan uuid, p_allowed boolean)
returns void language plpgsql security definer set search_path = public as $$
declare actor uuid := public.require_admin('models.write');
begin
  insert into public.model_plan_access (model_id, plan_id, allowed) values (p_model, p_plan, p_allowed)
  on conflict (model_id, plan_id) do update set allowed = excluded.allowed;
  insert into public.audit_logs (actor_id, action, target, detail)
  values (actor, 'model.plan_access', p_model::text, jsonb_build_object('plan', p_plan, 'allowed', p_allowed));
end $$;

create or replace function public.admin_upsert_flag(p_key text, p_enabled boolean, p_description text default null, p_rollout integer default 100)
returns void language plpgsql security definer set search_path = public as $$
declare actor uuid := public.require_admin('flags.write');
begin
  insert into public.feature_flags (key, enabled, description, rollout) values (p_key, p_enabled, p_description, p_rollout)
  on conflict (key) do update set enabled = excluded.enabled, description = coalesce(excluded.description, public.feature_flags.description), rollout = excluded.rollout, updated_at = now();
  insert into public.audit_logs (actor_id, action, target, detail)
  values (actor, 'flag.upsert', p_key, jsonb_build_object('enabled', p_enabled, 'rollout', p_rollout));
end $$;

create or replace function public.admin_set_setting(p_key text, p_value jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare actor uuid := public.require_admin('settings.write');
begin
  insert into public.system_settings (key, value) values (p_key, p_value)
  on conflict (key) do update set value = excluded.value, updated_at = now();
  insert into public.audit_logs (actor_id, action, target, detail)
  values (actor, 'setting.set', p_key, p_value);
end $$;

create or replace function public.admin_upsert_announcement(p jsonb)
returns uuid language plpgsql security definer set search_path = public as $$
declare actor uuid := public.require_admin('announcements.write'); aid uuid;
begin
  if p->>'id' is not null then
    aid := (p->>'id')::uuid;
    update public.announcements set
      title = coalesce(p->>'title', title), body = coalesce(p->>'body', body),
      level = coalesce(p->>'level', level), active = coalesce((p->>'active')::boolean, active),
      ends_at = coalesce((p->>'endsAt')::timestamptz, ends_at)
    where id = aid;
  else
    insert into public.announcements (title, body, level, active)
    values (p->>'title', coalesce(p->>'body',''), coalesce(p->>'level','info'), coalesce((p->>'active')::boolean,true))
    returning id into aid;
  end if;
  insert into public.audit_logs (actor_id, action, target, detail) values (actor, 'announcement.upsert', aid::text, p);
  return aid;
end $$;

create or replace function public.admin_audit_log(p_limit integer default 200)
returns jsonb language plpgsql security definer set search_path = public as $$
declare actor uuid := public.require_admin('audit.read');
begin
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', a.id, 'actor', a.actor_id, 'action', a.action, 'target', a.target,
      'detail', a.detail, 'createdAt', a.created_at) order by a.created_at desc)
    from (select * from public.audit_logs order by created_at desc limit p_limit) a
  ), '[]'::jsonb);
end $$;

-- admin catalog reads (plans/providers/models/flags/announcements/settings)
create or replace function public.admin_list_catalog()
returns jsonb language plpgsql security definer set search_path = public as $$
declare actor uuid := public.require_admin('overview.read');
begin
  return jsonb_build_object(
    'plans', coalesce((select jsonb_agg(to_jsonb(p) order by p.sort, p.name) from public.plans p), '[]'::jsonb),
    'planFeatures', coalesce((select jsonb_agg(to_jsonb(pf)) from public.plan_features pf), '[]'::jsonb),
    'providers', coalesce((select jsonb_agg(to_jsonb(pr) order by pr.sort, pr.label) from public.ai_providers pr), '[]'::jsonb),
    'models', coalesce((select jsonb_agg(to_jsonb(m) order by m.sort, m.label) from public.ai_models m), '[]'::jsonb),
    'modelPlanAccess', coalesce((select jsonb_agg(to_jsonb(a)) from public.model_plan_access a), '[]'::jsonb),
    'flags', coalesce((select jsonb_agg(to_jsonb(f) order by f.key) from public.feature_flags f), '[]'::jsonb),
    'announcements', coalesce((select jsonb_agg(to_jsonb(an) order by an.created_at desc) from public.announcements an), '[]'::jsonb),
    'settings', coalesce((select jsonb_agg(to_jsonb(s) order by s.key) from public.system_settings s), '[]'::jsonb)
  );
end $$;

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
alter table public.profiles enable row level security;
alter table public.plans enable row level security;
alter table public.plan_features enable row level security;
alter table public.subscriptions enable row level security;
alter table public.entitlement_overrides enable row level security;
alter table public.usage_counters enable row level security;
alter table public.ai_providers enable row level security;
alter table public.ai_models enable row level security;
alter table public.model_plan_access enable row level security;
alter table public.model_user_access enable row level security;
alter table public.feature_flags enable row level security;
alter table public.system_settings enable row level security;
alter table public.announcements enable row level security;
alter table public.admin_roles enable row level security;
alter table public.admin_permissions enable row level security;
alter table public.admin_role_permissions enable row level security;
alter table public.admin_users enable row level security;
alter table public.audit_logs enable row level security;
alter table public.devices enable row level security;

-- profiles: users read/update their own row
drop policy if exists profiles_select_self on public.profiles;
create policy profiles_select_self on public.profiles for select using (id = auth.uid() or public.is_admin(auth.uid()));
drop policy if exists profiles_update_self on public.profiles;
create policy profiles_update_self on public.profiles for update using (id = auth.uid()) with check (id = auth.uid());

-- devices: users manage their own
drop policy if exists devices_rw_self on public.devices;
create policy devices_rw_self on public.devices for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- read-only public catalog for signed-in users
drop policy if exists plans_read on public.plans;
create policy plans_read on public.plans for select using (auth.role() = 'authenticated' and active);
drop policy if exists plan_features_read on public.plan_features;
create policy plan_features_read on public.plan_features for select using (auth.role() = 'authenticated');
drop policy if exists providers_read on public.ai_providers;
create policy providers_read on public.ai_providers for select using (auth.role() = 'authenticated' and active);
drop policy if exists models_read on public.ai_models;
create policy models_read on public.ai_models for select using (auth.role() = 'authenticated' and active);
drop policy if exists flags_read on public.feature_flags;
create policy flags_read on public.feature_flags for select using (auth.role() = 'authenticated');
drop policy if exists announcements_read on public.announcements;
create policy announcements_read on public.announcements for select using (
  auth.role() = 'authenticated' and active and starts_at <= now() and (ends_at is null or ends_at > now())
);
drop policy if exists settings_read on public.system_settings;
create policy settings_read on public.system_settings for select using (
  auth.role() = 'authenticated' and key <> 'bootstrap_admin_email'
);

-- admin-only reads
drop policy if exists subscriptions_admin_read on public.subscriptions;
create policy subscriptions_admin_read on public.subscriptions for select using (public.is_admin(auth.uid()));
drop policy if exists audit_admin_read on public.audit_logs;
create policy audit_admin_read on public.audit_logs for select using (public.is_admin(auth.uid()));

-- ---------------------------------------------------------------------------
-- seed
-- ---------------------------------------------------------------------------
insert into public.admin_roles (code, label) values
  ('owner', 'Owner'), ('admin', 'Administrator'), ('support', 'Support')
on conflict (code) do nothing;

insert into public.admin_permissions (code, label) values
  ('overview.read', 'View overview'),
  ('users.read', 'View users'),
  ('users.write', 'Modify users'),
  ('subscriptions.write', 'Manage subscriptions'),
  ('entitlements.write', 'Manage entitlements'),
  ('plans.write', 'Manage plans'),
  ('providers.write', 'Manage providers'),
  ('models.write', 'Manage models'),
  ('flags.write', 'Manage feature flags'),
  ('settings.write', 'Manage settings'),
  ('announcements.write', 'Manage announcements'),
  ('audit.read', 'View audit log')
on conflict (code) do nothing;

-- owner gets every permission; admin gets everything except settings/entitlements writes
insert into public.admin_role_permissions (role_id, permission_id)
select r.id, p.id from public.admin_roles r cross join public.admin_permissions p
where r.code = 'owner'
on conflict do nothing;

insert into public.admin_role_permissions (role_id, permission_id)
select r.id, p.id from public.admin_roles r cross join public.admin_permissions p
where r.code = 'admin' and p.code not in ('settings.write','entitlements.write')
on conflict do nothing;

insert into public.admin_role_permissions (role_id, permission_id)
select r.id, p.id from public.admin_roles r join public.admin_permissions p on p.code in ('overview.read','users.read','audit.read')
where r.code = 'support'
on conflict do nothing;

insert into public.plans (code, name, description, interval, price_cents, sort) values
  ('free', 'Free', 'Local models and a taste of Alpha Cloud.', 'month', 0, 0),
  ('pro', 'Pro', 'Cloud models, higher limits and priority access.', 'month', 1900, 1),
  ('team', 'Team', 'Everything in Pro plus team management.', 'month', 4900, 2)
on conflict (code) do nothing;

insert into public.plan_features (plan_id, feature, value)
select id, 'cloud_models', 'false'::jsonb from public.plans where code = 'free'
on conflict do nothing;
insert into public.plan_features (plan_id, feature, value)
select id, 'limit.tokens', '0'::jsonb from public.plans where code = 'free'
on conflict do nothing;

insert into public.plan_features (plan_id, feature, value)
select id, 'cloud_models', 'true'::jsonb from public.plans where code in ('pro','team')
on conflict do nothing;
insert into public.plan_features (plan_id, feature, value)
select id, 'limit.tokens', '2000000'::jsonb from public.plans where code = 'pro'
on conflict do nothing;
insert into public.plan_features (plan_id, feature, value)
select id, 'limit.tokens', '20000000'::jsonb from public.plans where code = 'team'
on conflict do nothing;

insert into public.feature_flags (key, enabled, description) values
  ('gateway', true, 'Route cloud model traffic through the AI gateway'),
  ('new_ui', true, 'Enable the refreshed workspace UI')
on conflict (key) do nothing;

insert into public.system_settings (key, value) values
  ('maintenance', '{"active":false}'::jsonb),
  ('desktop_versions', '{}'::jsonb),
  ('bootstrap_admin_email', '""'::jsonb)
on conflict (key) do nothing;

-- Example provider/model catalog (safe placeholders; fill real API keys as
-- encrypted function secrets named by api_key_env, e.g. PROVIDER_API_KEY_OPENAI).
insert into public.ai_providers (code, label, kind, base_url, api_key_env, sort) values
  ('openai', 'OpenAI', 'openai', 'https://api.openai.com/v1', 'PROVIDER_API_KEY_OPENAI', 10),
  ('anthropic', 'Anthropic', 'anthropic', 'https://api.anthropic.com/v1', 'PROVIDER_API_KEY_ANTHROPIC', 20),
  ('groq', 'Groq', 'openai-compatible', 'https://api.groq.com/openai/v1', 'PROVIDER_API_KEY_GROQ', 30)
on conflict (code) do nothing;

insert into public.ai_models (provider_id, model_id, label, capabilities, context_length, default_allowed, sort)
select pr.id, 'gpt-4o-mini', 'GPT-4o mini', '{"streaming":true,"tools":true,"vision":true}'::jsonb, 128000, true, 10
from public.ai_providers pr where pr.code = 'openai'
on conflict (provider_id, model_id) do nothing;

insert into public.ai_models (provider_id, model_id, label, capabilities, context_length, default_allowed, sort)
select pr.id, 'gpt-4o', 'GPT-4o', '{"streaming":true,"tools":true,"vision":true}'::jsonb, 128000, false, 11
from public.ai_providers pr where pr.code = 'openai'
on conflict (provider_id, model_id) do nothing;

insert into public.model_plan_access (model_id, plan_id, allowed)
select m.id, pl.id, true
from public.ai_models m, public.plans pl
where m.model_id = 'gpt-4o' and pl.code in ('pro','team')
on conflict do nothing;
