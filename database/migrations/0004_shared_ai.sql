-- ---------------------------------------------------------------------------
-- 0004: Shared cloud inference — OpenRouter, per-request accounting, and the
-- controls that must exist *before* any shared spending is exposed.
--
-- Additive only. No existing table changes shape, no existing function's
-- signature changes, and nothing is dropped.
--
-- Design decisions worth stating, because they are the security surface:
--   * Every provider call is claimed through public.claim_ai_request(), which
--     does the allowance check and the counter update inside ONE transaction
--     under a per-user advisory lock. Checking then calling (what the API used
--     to do) lets two concurrent requests both pass an exhausted quota.
--   * The gateway reserves an estimated token budget up front and
--     public.finish_ai_request() settles the real figure afterwards. A failed or
--     cancelled run returns its reservation in full; a provider that reports no
--     usage keeps the estimate, which is the conservative direction.
--   * public.usage_period() keeps monthly ('tokens') and daily ('requests_day')
--     counters in one table without ambiguity.
--   * Company-wide safeguards are rows, not code: `ai_shared` (master switch)
--     and `ai_budget` (monthly USD cap). Both are enforced in SQL, so no API
--     change can bypass them.
--   * OpenRouter's own limits are per *account*, not per user: below a $10
--     lifetime purchase a free model allows 20 requests/minute and 50/day for
--     the whole company. limit.requests_day defaults well inside that.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- catalog metadata: what a model costs, and whether it has been proven callable
-- ---------------------------------------------------------------------------
alter table public.ai_models
  add column if not exists cost_input_per_mtok numeric(12,4),
  add column if not exists cost_output_per_mtok numeric(12,4),
  add column if not exists price_source text,
  add column if not exists availability_verified_at timestamptz;

alter table public.ai_providers
  add column if not exists spend_limit_usd numeric(12,2),
  add column if not exists docs_url text;

-- ---------------------------------------------------------------------------
-- per-request records: the evidence behind every usage and cost report
-- ---------------------------------------------------------------------------
create table if not exists public.ai_requests (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.users(id) on delete cascade,
  provider_code text not null,
  model_id text not null,
  status text not null default 'streaming'
    check (status in ('streaming','ok','error','cancelled')),
  error_code text,
  reserved_tokens numeric not null default 0,
  reservation_released boolean not null default false,
  prompt_tokens integer,
  completion_tokens integer,
  total_tokens integer,
  cost_usd numeric(12,6),
  cost_basis text,
  provider_generation_id text,
  duration_ms integer,
  created_at timestamptz not null default now(),
  finished_at timestamptz
);
create index if not exists idx_ai_requests_created on public.ai_requests(created_at desc);
create index if not exists idx_ai_requests_user on public.ai_requests(user_id, created_at desc);
create index if not exists idx_ai_requests_model on public.ai_requests(provider_code, model_id, created_at desc);
create index if not exists idx_ai_requests_inflight on public.ai_requests(user_id)
  where status = 'streaming';

alter table public.ai_requests enable row level security;
drop policy if exists ai_requests_own_read on public.ai_requests;
create policy ai_requests_own_read on public.ai_requests
  for select using (user_id = public.current_user_id());

-- A counter's period depends on the resource: token allowances are monthly,
-- request allowances are daily. One helper so no caller has to remember.
create or replace function public.usage_period(p_resource text)
returns date language sql stable security definer set search_path = public as $$
  select case when p_resource like '%\_day' then current_date
              else date_trunc('month', now())::date end
$$;

-- ---------------------------------------------------------------------------
-- company-wide safeguards (rows, so operations can change them without a deploy)
-- ---------------------------------------------------------------------------
insert into public.system_settings (key, value) values
  ('ai_shared', '{"enabled":true,"message":null}'::jsonb),
  ('ai_budget', '{"enabled":false,"monthlyUsd":null}'::jsonb)
on conflict (key) do nothing;

/** Month-to-date spend, and the company cap when one is configured. */
create or replace function public.ai_budget_state()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v jsonb;
  cap numeric;
  spent numeric;
begin
  select value into v from public.system_settings where key = 'ai_budget';
  if v is not null and jsonb_typeof(v->'monthlyUsd') = 'number' then
    cap := (v->>'monthlyUsd')::numeric;
  end if;
  if v is not null and coalesce((v->>'enabled')::boolean, false) is not true then
    cap := null;
  end if;

  select coalesce(sum(cost_usd), 0) into spent
    from public.ai_requests
   where created_at >= date_trunc('month', now()) and cost_usd is not null;

  return jsonb_build_object(
    'configured', v is not null,
    'enforced', cap is not null,
    'monthlyUsd', cap,
    'spentMtdUsd', spent,
    'remainingUsd', case when cap is null then null else greatest(cap - spent, 0) end
  );
end $$;

/** Is shared (company-funded) inference available at all right now? */
create or replace function public.ai_shared_state()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v jsonb;
begin
  select value into v from public.system_settings where key = 'ai_shared';
  return jsonb_build_object(
    'enabled', coalesce((v->>'enabled')::boolean, true),
    'message', nullif(v->>'message', '')
  );
end $$;

-- ---------------------------------------------------------------------------
-- claim: allowance check + reservation + in-flight record, atomically
-- ---------------------------------------------------------------------------
create or replace function public.finish_ai_request(
  p_id bigint,
  p_status text,
  p_prompt integer default null,
  p_completion integer default null,
  p_total integer default null,
  p_cost numeric default null,
  p_error text default null,
  p_duration integer default null,
  p_generation text default null,
  p_cost_basis text default null
) returns boolean language plpgsql security definer set search_path = public as $$
declare
  uid uuid;
  res numeric;
  released boolean;
  actual numeric;
  mperiod date := date_trunc('month', now())::date;
begin
  if p_status not in ('ok','error','cancelled') then
    raise exception 'invalid_status' using errcode = '22023';
  end if;

  select user_id, reserved_tokens, reservation_released
    into uid, res, released
    from public.ai_requests where id = p_id for update;
  if uid is null then
    return false;
  end if;

  if not released then
    actual := case
      when p_status <> 'ok' then 0
      when p_total is not null and p_total >= 0 then p_total
      else res
    end;
    if actual <> coalesce(res, 0) then
      update public.usage_counters
         set used = greatest(used - coalesce(res, 0) + actual, 0), updated_at = now()
       where user_id = uid and resource = 'tokens' and period_start = mperiod;
    end if;
  end if;

  update public.ai_requests
     set status = p_status,
         prompt_tokens = p_prompt,
         completion_tokens = p_completion,
         total_tokens = p_total,
         cost_usd = p_cost,
         cost_basis = p_cost_basis,
         error_code = p_error,
         duration_ms = p_duration,
         provider_generation_id = coalesce(p_generation, provider_generation_id),
         reservation_released = true,
         finished_at = now()
   where id = p_id;
  return true;
end $$;

create or replace function public.claim_ai_request(
  p_user uuid,
  p_provider text,
  p_model text,
  p_reserve numeric,
  p_max_concurrent integer default 4,
  p_daily_default numeric default 20
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  mperiod date := date_trunc('month', now())::date;
  dperiod date := current_date;
  r numeric := greatest(coalesce(p_reserve, 0), 0);
  acct text;
  v jsonb;
  lim numeric;
  -- Named with a v_ prefix so `select used into ...` cannot be read as the column
  -- of the same name (PostgreSQL reports that as an ambiguous reference).
  v_used numeric;
  tlim numeric;
  v_tused numeric;
  inflight integer;
  rid bigint;
  shared jsonb;
  budget jsonb;
  prov_cap numeric;
  prov_spent numeric;
  rec record;
begin
  if p_user is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;
  if coalesce(p_provider, '') = '' or coalesce(p_model, '') = '' then
    raise exception 'invalid_request' using errcode = '22023';
  end if;

  select status into acct from public.users where id = p_user;
  if acct is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;
  if acct <> 'active' then
    return jsonb_build_object('allowed', false, 'code', 'account_' || acct,
      'message', 'This account is ' || acct || '. Contact support if that is unexpected.');
  end if;

  -- One writer at a time per user. The allowance check, the in-flight count and
  -- the counter updates must be observed as a single unit or the quota leaks.
  perform pg_advisory_xact_lock(hashtextextended(p_user::text, 0));

  -- Reap runs whose isolate died mid-stream, so a crash cannot hold a slot or a
  -- reservation forever. 15 minutes is far longer than any supported completion.
  for rec in
    select id from public.ai_requests
     where user_id = p_user and status = 'streaming'
       and created_at < now() - interval '15 minutes'
  loop
    perform public.finish_ai_request(rec.id, 'error', null, null, null, null, 'abandoned', null);
  end loop;

  shared := public.ai_shared_state();
  if coalesce((shared->>'enabled')::boolean, true) is not true then
    insert into public.ai_requests (user_id, provider_code, model_id, status, error_code, reservation_released, finished_at)
    values (p_user, p_provider, p_model, 'error', 'shared_disabled', true, now());
    return jsonb_build_object('allowed', false, 'code', 'shared_disabled',
      'message', coalesce(shared->>'message',
        'Shared cloud AI is temporarily unavailable. Local models still work.'));
  end if;

  budget := public.ai_budget_state();
  if coalesce((budget->>'enforced')::boolean, false)
     and (budget->>'spentMtdUsd')::numeric >= (budget->>'monthlyUsd')::numeric then
    insert into public.ai_requests (user_id, provider_code, model_id, status, error_code, reservation_released, finished_at)
    values (p_user, p_provider, p_model, 'error', 'budget_exhausted', true, now());
    return jsonb_build_object('allowed', false, 'code', 'budget_exhausted',
      'message', 'Alpha''s shared AI budget for this month is spent. Local models still work.');
  end if;

  -- Optional per-provider company cap. A provider that has a cap set is
  -- stopped at the cap even while the global budget still has room, so one
  -- expensive upstream cannot consume the whole month.
  select p.spend_limit_usd into prov_cap from public.ai_providers p where p.code = p_provider;
  if prov_cap is not null and prov_cap > 0 then
    select coalesce(sum(r.cost_usd), 0) into prov_spent
      from public.ai_requests r
     where r.provider_code = p_provider and r.created_at >= date_trunc('month', now());
    if prov_spent >= prov_cap then
      insert into public.ai_requests (user_id, provider_code, model_id, status, error_code, reservation_released, finished_at)
      values (p_user, p_provider, p_model, 'error', 'provider_budget_exhausted', true, now());
      return jsonb_build_object('allowed', false, 'code', 'provider_budget_exhausted',
        'message', 'Alpha''s shared ' || p_provider || ' allowance is spent for this month. Local models still work.');
    end if;
  end if;

  select count(*) into inflight
    from public.ai_requests where user_id = p_user and status = 'streaming';
  if inflight >= greatest(coalesce(p_max_concurrent, 4), 1) then
    insert into public.ai_requests (user_id, provider_code, model_id, status, error_code, reservation_released, finished_at)
    values (p_user, p_provider, p_model, 'error', 'too_many_requests', true, now());
    return jsonb_build_object('allowed', false, 'code', 'too_many_requests',
      'message', 'Wait for the current response to finish, or stop it first.', 'inflight', inflight);
  end if;

  -- daily request allowance
  select public.check_entitlement(p_user, 'limit.requests_day') into v;
  tlim := case when v is not null and jsonb_typeof(v) = 'number' then (v::text)::numeric else null end;
  if tlim is null then
    tlim := greatest(coalesce(p_daily_default, 20), 0);
  end if;

  insert into public.usage_counters (user_id, resource, period_start, used)
  values (p_user, 'requests_day', dperiod, 0)
  on conflict (user_id, resource, period_start) do nothing;
  select used into v_tused from public.usage_counters
   where user_id = p_user and resource = 'requests_day' and period_start = dperiod
   for update;

  if tlim > 0 and v_tused + 1 > tlim then
    insert into public.ai_requests (user_id, provider_code, model_id, status, error_code, reservation_released, finished_at)
    values (p_user, p_provider, p_model, 'error', 'daily_limit_reached', true, now());
    return jsonb_build_object('allowed', false, 'code', 'daily_limit_reached',
      'limit', tlim, 'used', v_tused,
      'message', 'You have used today''s included cloud requests. They reset at midnight UTC.');
  end if;

  -- monthly token allowance
  select public.check_entitlement(p_user, 'limit.tokens') into v;
  lim := case when v is not null and jsonb_typeof(v) = 'number' then (v::text)::numeric else null end;

  insert into public.usage_counters (user_id, resource, period_start, used)
  values (p_user, 'tokens', mperiod, 0)
  on conflict (user_id, resource, period_start) do nothing;
  select used into v_used from public.usage_counters
   where user_id = p_user and resource = 'tokens' and period_start = mperiod
   for update;

  if lim is not null and v_used + r > lim then
    insert into public.ai_requests (user_id, provider_code, model_id, status, error_code, reservation_released, finished_at)
    values (p_user, p_provider, p_model, 'error', 'quota_exceeded', true, now());
    return jsonb_build_object('allowed', false, 'code', 'quota_exceeded',
      'limit', lim, 'used', v_used,
      'message', 'Your monthly token allowance is used up. Upgrade, or use a local model.');
  end if;

  update public.usage_counters set used = used + 1, updated_at = now()
   where user_id = p_user and resource = 'requests_day' and period_start = dperiod;
  update public.usage_counters set used = used + r, updated_at = now()
   where user_id = p_user and resource = 'tokens' and period_start = mperiod;

  insert into public.ai_requests (user_id, provider_code, model_id, status, reserved_tokens)
  values (p_user, p_provider, p_model, 'streaming', r)
  returning id into rid;

  return jsonb_build_object(
    'allowed', true,
    'requestId', rid,
    'reservedTokens', r,
    'limit', lim,
    'used', v_used + r,
    'dailyLimit', tlim,
    'dailyUsed', v_tused + 1
  );
end $$;

-- Budget may only be *read* by an authenticated caller for their own limits;
-- the values themselves come from the RPCs above, which are server-side only.
revoke all on function public.claim_ai_request(uuid, text, text, numeric, integer, numeric) from public;
revoke all on function public.finish_ai_request(bigint, text, integer, integer, integer, numeric, text, integer, text, text) from public;

-- ---------------------------------------------------------------------------
-- admin: pagination the user list did not have, and AI usage/cost reporting
-- ---------------------------------------------------------------------------
create or replace function public.admin_users_page(
  p_query text default null,
  p_limit integer default 25,
  p_offset integer default 0
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  actor uuid := public.require_admin('users.read');
  lim integer := greatest(1, least(coalesce(p_limit, 25), 200));
  off integer := greatest(0, coalesce(p_offset, 0));
  q text := coalesce(nullif(trim(p_query), ''), '');
begin
  return jsonb_build_object(
    'total', (
      select count(*) from public.users u
       where q = '' or u.email ilike '%' || q || '%' or u.full_name ilike '%' || q || '%'
    ),
    'limit', lim,
    'offset', off,
    'rows', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', u.id, 'email', u.email, 'fullName', u.full_name, 'status', u.status,
        'createdAt', u.created_at, 'lastSignInAt', u.last_sign_in_at,
        'isAdmin', public.is_admin(u.id),
        'plan', (select pl.code from public.subscriptions s join public.plans pl on pl.id = s.plan_id
                  where s.user_id = u.id and s.status in ('active','trialing')
                  order by s.created_at desc limit 1),
        -- Derived from real rows: public.users has no provider or verification
        -- column, so the facts come from the tables that actually hold them.
        'identities', coalesce((select jsonb_agg(distinct i.provider)
            from public.user_identities i where i.user_id = u.id), '[]'::jsonb),
        'hasPassword', exists (select 1 from public.password_credentials c where c.user_id = u.id),
        'devices', coalesce((select jsonb_agg(distinct d.platform) from public.devices d
            where d.user_id = u.id), '[]'::jsonb),
        'tokensMtd', coalesce((select c.used from public.usage_counters c
                    where c.user_id = u.id and c.resource = 'tokens'
                      and c.period_start = date_trunc('month', now())::date), 0),
        'requestsMtd', coalesce((select c.used from public.usage_counters c
                    where c.user_id = u.id and c.resource = 'requests_day'
                      and c.period_start = current_date), 0),
        'sessionsActive', (select count(*) from public.sessions s
                    where s.user_id = u.id and s.revoked_at is null and s.expires_at > now())
      ) order by u.created_at desc)
      from (
        select * from public.users u
         where q = '' or u.email ilike '%' || q || '%' or u.full_name ilike '%' || q || '%'
         order by u.created_at desc
         limit lim offset off
      ) u
    ), '[]'::jsonb)
  );
end $$;

create or replace function public.admin_ai_usage(p_days integer default 30)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  actor uuid := public.require_admin('overview.read');
  days integer := greatest(1, least(coalesce(p_days, 30), 365));
  since timestamptz := now() - make_interval(days => days);
begin
  return jsonb_build_object(
    'window', jsonb_build_object('days', days, 'since', since),
    'totals', jsonb_build_object(
      'requests', (select count(*) from public.ai_requests r where r.created_at > since),
      'succeeded', (select count(*) from public.ai_requests r where r.created_at > since and r.status = 'ok'),
      'failed', (select count(*) from public.ai_requests r where r.created_at > since and r.status = 'error'),
      'cancelled', (select count(*) from public.ai_requests r where r.created_at > since and r.status = 'cancelled'),
      'inFlight', (select count(*) from public.ai_requests r where r.status = 'streaming'),
      'limitRejections', (select count(*) from public.ai_requests r where r.created_at > since
                            and r.error_code in ('quota_exceeded','daily_limit_reached','too_many_requests','budget_exhausted','shared_disabled')),
      'tokens', coalesce((select sum(r.total_tokens) from public.ai_requests r where r.created_at > since), 0),
      'costUsd', coalesce((select sum(r.cost_usd) from public.ai_requests r where r.created_at > since), 0),
      'estimatedCostUsd', coalesce((select sum(r.cost_usd) from public.ai_requests r where r.created_at > since and r.cost_basis = 'estimate'), 0),
      'reportedCostUsd', coalesce((select sum(r.cost_usd) from public.ai_requests r where r.created_at > since and r.cost_basis = 'provider'), 0),
      'pricedRequests', (select count(*) from public.ai_requests r where r.created_at > since and r.cost_usd is not null),
      'avgDurationMs', (
        select round(avg(r.duration_ms)) from public.ai_requests r
         where r.created_at > since and r.duration_ms is not null
      )
    ),
    'byModel', coalesce((
      select jsonb_agg(jsonb_build_object(
        'providerCode', t.provider_code, 'modelId', t.model_id,
        'requests', t.requests, 'failed', t.failed, 'tokens', t.tokens, 'costUsd', t.cost
      ) order by t.requests desc)
      from (
        select r.provider_code, r.model_id, count(*) as requests,
               count(*) filter (where r.status <> 'ok') as failed,
               coalesce(sum(r.total_tokens), 0) as tokens,
               coalesce(sum(r.cost_usd), 0) as cost
          from public.ai_requests r where r.created_at > since
         group by r.provider_code, r.model_id
      ) t
    ), '[]'::jsonb),
    'byProvider', coalesce((
      select jsonb_agg(jsonb_build_object(
        'providerCode', t.provider_code, 'requests', t.requests,
        'tokens', t.tokens, 'costUsd', t.cost
      ) order by t.requests desc)
      from (
        select r.provider_code, count(*) as requests,
               coalesce(sum(r.total_tokens), 0) as tokens,
               coalesce(sum(r.cost_usd), 0) as cost
          from public.ai_requests r where r.created_at > since
         group by r.provider_code
      ) t
    ), '[]'::jsonb),
    'byDay', coalesce((
      select jsonb_agg(jsonb_build_object(
        'day', t.day, 'requests', t.requests, 'failed', t.failed,
        'tokens', t.tokens, 'costUsd', t.cost
      ) order by t.day)
      from (
        select date_trunc('day', r.created_at)::date as day, count(*) as requests,
               count(*) filter (where r.status <> 'ok') as failed,
               coalesce(sum(r.total_tokens), 0) as tokens,
               coalesce(sum(r.cost_usd), 0) as cost
          from public.ai_requests r where r.created_at > since
         group by 1
      ) t
    ), '[]'::jsonb),
    'errors', coalesce((
      select jsonb_agg(jsonb_build_object('errorCode', t.error_code, 'count', t.count) order by t.count desc)
      from (
        select coalesce(r.error_code, 'unknown') as error_code, count(*) as count
          from public.ai_requests r
         where r.created_at > since and r.status <> 'ok'
         group by 1
      ) t
    ), '[]'::jsonb),
    'topConsumers', coalesce((
      select jsonb_agg(jsonb_build_object(
        'userId', t.user_id, 'requests', t.requests, 'tokens', t.tokens, 'costUsd', t.cost
      ) order by t.cost desc, t.tokens desc)
      from (
        select r.user_id, count(*) as requests,
               coalesce(sum(r.total_tokens), 0) as tokens,
               coalesce(sum(r.cost_usd), 0) as cost
          from public.ai_requests r where r.created_at > since
         group by r.user_id
         order by count(*) desc limit 20
      ) t
    ), '[]'::jsonb),
    'budget', public.ai_budget_state(),
    'shared', public.ai_shared_state()
  );
end $$;

-- ---------------------------------------------------------------------------
-- provider policy: the controls the provider table could not express
-- ---------------------------------------------------------------------------
create or replace function public.admin_set_provider_policy(
  p_code text,
  p_active boolean default null,
  p_spend_limit_usd numeric default null,
  p_docs_url text default null
) returns jsonb language plpgsql security definer set search_path = public as $$
declare actor uuid := public.require_admin('providers.write'); row_after public.ai_providers%rowtype;
begin
  update public.ai_providers
     set active = coalesce(p_active, active),
         spend_limit_usd = case when p_spend_limit_usd is not null then p_spend_limit_usd else spend_limit_usd end,
         docs_url = case when p_docs_url is not null then p_docs_url else docs_url end
   where code = p_code
   returning * into row_after;

  if row_after.id is null then
    raise exception 'provider_not_found' using errcode = 'P0002';
  end if;

  insert into public.audit_logs (actor_id, action, target, detail)
  values (actor, 'provider.policy', p_code,
          jsonb_build_object('active', row_after.active, 'spendLimitUsd', row_after.spend_limit_usd));

  return jsonb_build_object(
    'code', row_after.code, 'label', row_after.label, 'active', row_after.active,
    'spendLimitUsd', row_after.spend_limit_usd, 'docsUrl', row_after.docs_url
  );
end $$;

-- ---------------------------------------------------------------------------
-- OpenRouter: the shared provider. One company credential, held by the
-- deployment (`OPENROUTER_API_KEY`), never in the database and never sent to a
-- client.
--
-- Free variants carry OpenRouter's `:free` suffix. `default_allowed = true` on
-- them only: a model a plan does not include must never be reachable by
-- accident. Prices are the published list figures and are recorded with their
-- source so any cost derived from them can be labelled an estimate; when
-- OpenRouter reports `usage.cost` that value wins.
-- ---------------------------------------------------------------------------
insert into public.ai_providers (code, label, kind, base_url, api_key_env, sort, docs_url)
values ('openrouter', 'OpenRouter', 'openai-compatible', 'https://openrouter.ai/api/v1',
        'OPENROUTER_API_KEY', 5, 'https://openrouter.ai/docs')
on conflict (code) do update set
  base_url = excluded.base_url,
  api_key_env = excluded.api_key_env,
  docs_url = excluded.docs_url;

insert into public.ai_models
  (provider_id, model_id, label, capabilities, context_length, default_allowed, sort,
   cost_input_per_mtok, cost_output_per_mtok, price_source)
select pr.id, v.model_id, v.label, v.capabilities::jsonb, v.context_length, v.default_allowed, v.sort,
       v.cost_in, v.cost_out, 'OpenRouter published list price (snapshot)'
from public.ai_providers pr,
(values
  ('google/gemma-4-31b-it:free', 'Gemma 4 31B (free)', '{"streaming":true,"tools":false,"vision":false}', 32768, true, 100, 0, 0),
  ('liquid/lfm-2.5-2.6b:free', 'LFM 2.5 2.6B (free)', '{"streaming":true,"tools":false,"vision":false}', 32768, true, 101, 0, 0),
  ('nvidia/nemotron-3-super-120b-a12b:free', 'Nemotron 3 Super 120B (free)', '{"streaming":true,"tools":false,"vision":false}', 131072, true, 102, 0, 0),
  ('google/gemini-4-argon', 'Gemini 4 Argon', '{"streaming":true,"tools":true,"vision":true}', 1000000, false, 110, null, null),
  ('openai/gpt-5', 'GPT-5', '{"streaming":true,"tools":true,"vision":true}', 400000, false, 111, null, null),
  ('openai/gpt-4o-mini', 'GPT-4o mini', '{"streaming":true,"tools":true,"vision":true}', 128000, false, 112, null, null),
  ('anthropic/claude-sonnet-5', 'Claude Sonnet 5', '{"streaming":true,"tools":true,"vision":true}', 200000, false, 113, null, null),
  ('deepseek/deepseek-v4-pro', 'DeepSeek V4 Pro', '{"streaming":true,"tools":true,"vision":false}', 128000, false, 114, null, null),
  ('deepseek/deepseek-v4-flash', 'DeepSeek V4 Flash', '{"streaming":true,"tools":true,"vision":false}', 128000, false, 115, null, null),
  ('qwen/qwen3.8-flash', 'Qwen 3.8 Flash', '{"streaming":true,"tools":true,"vision":false}', 128000, false, 116, null, null),
  ('meta-llama/llama-4-maverick', 'Llama 4 Maverick', '{"streaming":true,"tools":true,"vision":false}', 1000000, false, 117, null, null)
) as v(model_id, label, capabilities, context_length, default_allowed, sort, cost_in, cost_out)
where pr.code = 'openrouter'
on conflict (provider_id, model_id) do update set
  label = excluded.label,
  capabilities = excluded.capabilities,
  context_length = excluded.context_length,
  default_allowed = excluded.default_allowed,
  cost_input_per_mtok = excluded.cost_input_per_mtok,
  cost_output_per_mtok = excluded.cost_output_per_mtok,
  price_source = excluded.price_source;

-- ---------------------------------------------------------------------------
-- entitlements: a free tier that can actually use shared inference, bounded by
-- our own allowances and by OpenRouter's much smaller account-level limits
-- ---------------------------------------------------------------------------
insert into public.plan_features (plan_id, feature, value)
select id, 'cloud_models', 'true'::jsonb from public.plans where code in ('free','developer')
on conflict (plan_id, feature) do update set value = excluded.value;

insert into public.plan_features (plan_id, feature, value)
select id, 'limit.tokens', '50000'::jsonb from public.plans where code = 'free'
on conflict (plan_id, feature) do update set value = excluded.value;
insert into public.plan_features (plan_id, feature, value)
select id, 'limit.requests_day', '10'::jsonb from public.plans where code = 'free'
on conflict (plan_id, feature) do update set value = excluded.value;

insert into public.plan_features (plan_id, feature, value)
select id, 'limit.requests_day', '200'::jsonb from public.plans where code = 'pro'
on conflict (plan_id, feature) do update set value = excluded.value;
insert into public.plan_features (plan_id, feature, value)
select id, 'limit.requests_day', '1000'::jsonb from public.plans where code = 'developer'
on conflict (plan_id, feature) do update set value = excluded.value;
insert into public.plan_features (plan_id, feature, value)
select id, 'limit.requests_day', '2000'::jsonb from public.plans where code = 'team'
on conflict (plan_id, feature) do update set value = excluded.value;

-- Paid (or unpriced) OpenRouter models are reachable only by plans the operator
-- grants them to; `default_allowed` stays false so a new plan cannot inherit
-- premium models by omission.
insert into public.model_plan_access (model_id, plan_id, allowed)
select m.id, pl.id, true
from public.ai_models m
join public.ai_providers pr on pr.id = m.provider_id
cross join public.plans pl
where pr.code = 'openrouter' and m.default_allowed is false
  and pl.code in ('pro','developer','team')
on conflict (model_id, plan_id) do update set allowed = excluded.allowed;

insert into public.model_plan_access (model_id, plan_id, allowed)
select m.id, pl.id, false
from public.ai_models m
join public.ai_providers pr on pr.id = m.provider_id
cross join public.plans pl
where pr.code = 'openrouter' and m.default_allowed is false
  and pl.code = 'free'
on conflict (model_id, plan_id) do update set allowed = excluded.allowed;
