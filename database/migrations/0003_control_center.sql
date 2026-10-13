-- ---------------------------------------------------------------------------
-- 0003: Admin Control Center data
--
-- Everything here answers a question the current admin RPCs cannot: real
-- metrics, a per-user detail view, session management, role changes, a security
-- overview, and download telemetry. Additive only — no existing object changes
-- shape, so the portal keeps working against the old functions too.
-- ---------------------------------------------------------------------------

-- What a download actually means for this product: a signed-in account asked for
-- the current installer. Recorded so "Downloads" is a real number, not a guess.
create table if not exists public.downloads (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.users(id) on delete cascade,
  release_id uuid references public.releases(id) on delete set null,
  version text,
  platform text,
  ip text,
  user_agent text,
  created_at timestamptz not null default now()
);
create index if not exists idx_downloads_created on public.downloads(created_at desc);
create index if not exists idx_downloads_user on public.downloads(user_id, created_at desc);

-- ---------------------------------------------------------------------------
-- metrics for the dashboard
-- ---------------------------------------------------------------------------
create or replace function public.admin_metrics()
returns jsonb language plpgsql security definer set search_path = public as $$
declare actor uuid := public.require_admin('overview.read');
begin
  return jsonb_build_object(
    'users', jsonb_build_object(
      'total', (select count(*) from public.users),
      'active', (select count(*) from public.users where status = 'active'),
      'suspended', (select count(*) from public.users where status = 'suspended'),
      'disabled', (select count(*) from public.users where status = 'disabled'),
      'new7d', (select count(*) from public.users where created_at > now() - interval '7 days'),
      'new30d', (select count(*) from public.users where created_at > now() - interval '30 days'),
      'signedIn7d', (select count(*) from public.users where last_sign_in_at > now() - interval '7 days'),
      'google', (select count(distinct user_id) from public.user_identities where provider = 'google'),
      'withPassword', (select count(*) from public.password_credentials)
    ),
    'admins', (select count(*) from public.admin_users),
    'sessions', jsonb_build_object(
      'active', (select count(*) from public.sessions where revoked_at is null and expires_at > now()),
      'total', (select count(*) from public.sessions)
    ),
    'downloads', jsonb_build_object(
      'total', (select count(*) from public.downloads),
      'last7d', (select count(*) from public.downloads where created_at > now() - interval '7 days'),
      'uniqueUsers', (select count(distinct user_id) from public.downloads)
    ),
    'releases', jsonb_build_object(
      'published', (select count(*) from public.releases where published),
      'latest', (select r.version from public.releases r where r.published
                  order by r.released_at desc limit 1)
    ),
    'providers', jsonb_build_object(
      'total', (select count(*) from public.ai_providers),
      'active', (select count(*) from public.ai_providers where active)
    ),
    'models', jsonb_build_object(
      'total', (select count(*) from public.ai_models),
      'active', (select count(*) from public.ai_models where active)
    ),
    'flags', jsonb_build_object(
      'total', (select count(*) from public.feature_flags),
      'enabled', (select count(*) from public.feature_flags where enabled)
    ),
    'plans', (select count(*) from public.plans),
    'subscriptions', jsonb_build_object(
      'active', (select count(*) from public.subscriptions where status in ('active','trialing')),
      'byPlan', coalesce((select jsonb_object_agg(pl.code, cnt) from (
                  select p.code, count(*) cnt from public.subscriptions s
                    join public.plans p on p.id = s.plan_id
                   where s.status in ('active','trialing') group by p.code) pl), '{}'::jsonb)
    ),
    'announcements', jsonb_build_object(
      'active', (select count(*) from public.announcements where active)
    ),
    'maintenance', coalesce((select value from public.system_settings where key = 'maintenance'), '{"active":false}'::jsonb),
    'audit', jsonb_build_object(
      'total', (select count(*) from public.audit_logs),
      'lastAt', (select max(created_at) from public.audit_logs)
    ),
    'serverTime', now()
  );
end $$;

-- ---------------------------------------------------------------------------
-- one user, in full
-- ---------------------------------------------------------------------------
create or replace function public.admin_get_user(p_user uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare actor uuid := public.require_admin('users.read');
begin
  if not exists (select 1 from public.users where id = p_user) then
    raise exception 'user_not_found' using errcode = 'P0002';
  end if;

  return jsonb_build_object(
    'account', (select jsonb_build_object(
        'id', u.id, 'email', u.email, 'fullName', u.full_name, 'status', u.status,
        'createdAt', u.created_at, 'lastSignInAt', u.last_sign_in_at,
        'isAdmin', public.is_admin(u.id),
        'roles', coalesce((select jsonb_agg(r.code) from public.admin_users a
                            join public.admin_roles r on r.id = a.role_id
                           where a.user_id = u.id), '[]'::jsonb),
        'hasPassword', exists (select 1 from public.password_credentials c where c.user_id = u.id),
        'identityProviders', coalesce((select jsonb_agg(distinct i.provider) from public.user_identities i
                                        where i.user_id = u.id), '[]'::jsonb)
      ) from public.users u where u.id = p_user),
    'plan', (select jsonb_build_object('code', p.code, 'name', p.name, 'status', s.status,
                                       'periodEnd', s.current_period_end)
               from public.subscriptions s join public.plans p on p.id = s.plan_id
              where s.user_id = p_user and s.status in ('active','trialing')
              order by s.created_at desc limit 1),
    'overrides', coalesce((select jsonb_agg(jsonb_build_object(
        'feature', o.feature, 'value', o.value, 'endsAt', o.ends_at, 'reason', o.reason))
        from public.entitlement_overrides o
       where o.user_id = p_user and (o.ends_at is null or o.ends_at > now())), '[]'::jsonb),
    'usage', coalesce((select jsonb_agg(jsonb_build_object('resource', c.resource, 'used', c.used,
        'periodStart', c.period_start)) from public.usage_counters c
       where c.user_id = p_user and c.period_start = date_trunc('month', now())::date), '[]'::jsonb),
    'devices', coalesce((select jsonb_agg(jsonb_build_object('platform', d.platform,
        'appVersion', d.app_version, 'firstSeenAt', d.first_seen_at, 'lastSeenAt', d.last_seen_at)
        order by d.last_seen_at desc) from public.devices d where d.user_id = p_user), '[]'::jsonb),
    'sessions', coalesce((select jsonb_agg(jsonb_build_object(
        'id', s.id, 'createdAt', s.created_at, 'lastUsedAt', s.last_used_at,
        'expiresAt', s.expires_at, 'revokedAt', s.revoked_at,
        'active', s.revoked_at is null and s.expires_at > now(),
        'userAgent', s.user_agent, 'ip', s.ip) order by s.created_at desc)
        from (select * from public.sessions where user_id = p_user order by created_at desc limit 20) s), '[]'::jsonb),
    'downloads', coalesce((select jsonb_agg(jsonb_build_object('version', d.version,
        'platform', d.platform, 'createdAt', d.created_at) order by d.created_at desc)
        from (select * from public.downloads where user_id = p_user order by created_at desc limit 20) d), '[]'::jsonb),
    'activity', coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'action', a.action,
        'actorId', a.actor_id, 'detail', a.detail, 'createdAt', a.created_at) order by a.created_at desc)
        from (select * from public.audit_logs
               where actor_id = p_user or target = p_user::text
               order by created_at desc limit 20) a), '[]'::jsonb)
  );
end $$;

-- ---------------------------------------------------------------------------
-- sessions
-- ---------------------------------------------------------------------------
create or replace function public.admin_list_sessions(p_user uuid default null, p_limit integer default 100)
returns jsonb language plpgsql security definer set search_path = public as $$
declare actor uuid := public.require_admin('users.read');
begin
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', s.id, 'userId', s.user_id, 'email', u.email,
      'createdAt', s.created_at, 'lastUsedAt', s.last_used_at,
      'expiresAt', s.expires_at, 'revokedAt', s.revoked_at,
      'active', s.revoked_at is null and s.expires_at > now(),
      'userAgent', s.user_agent, 'ip', s.ip) order by s.created_at desc)
      from (select * from public.sessions
             where p_user is null or user_id = p_user
             order by created_at desc limit greatest(1, least(coalesce(p_limit, 100), 500))) s
      join public.users u on u.id = s.user_id
  ), '[]'::jsonb);
end $$;

create or replace function public.admin_revoke_session(p_session uuid, p_reason text default null)
returns boolean language plpgsql security definer set search_path = public as $$
declare actor uuid := public.require_admin('users.write'); owner uuid;
begin
  update public.sessions set revoked_at = now()
   where id = p_session and revoked_at is null
   returning user_id into owner;
  if owner is null then
    return false;
  end if;
  insert into public.audit_logs (actor_id, action, target, detail)
  values (actor, 'session.revoke', owner::text,
          jsonb_build_object('sessionId', p_session, 'reason', p_reason));
  return true;
end $$;

create or replace function public.admin_revoke_user_sessions(p_user uuid, p_reason text default null)
returns integer language plpgsql security definer set search_path = public as $$
declare actor uuid := public.require_admin('users.write'); n integer;
begin
  update public.sessions set revoked_at = now()
   where user_id = p_user and revoked_at is null;
  get diagnostics n = row_count;
  insert into public.audit_logs (actor_id, action, target, detail)
  values (actor, 'session.revoke_all', p_user::text, jsonb_build_object('count', n, 'reason', p_reason));
  return n;
end $$;

-- ---------------------------------------------------------------------------
-- roles
-- ---------------------------------------------------------------------------
create or replace function public.admin_set_user_admin(p_user uuid, p_admin boolean, p_role_code text default 'admin')
returns jsonb language plpgsql security definer set search_path = public as $$
declare actor uuid := public.require_admin('users.write'); rid uuid; codes jsonb;
begin
  -- Guard against an administrator locking the whole product out of itself.
  if p_user = actor and not p_admin then
    raise exception 'cannot_remove_own_admin' using errcode = '42501';
  end if;
  if p_user = actor and p_admin then
    raise exception 'already_admin' using errcode = '22023';
  end if;

  if p_admin then
    select id into rid from public.admin_roles where code = coalesce(nullif(p_role_code,''), 'admin') limit 1;
    if rid is null then
      raise exception 'unknown_role' using errcode = '22023';
    end if;
    -- The very last administrator may not be demoted by anyone, including itself.
    insert into public.admin_users (user_id, role_id) values (p_user, rid)
    on conflict (user_id) do update set role_id = excluded.role_id;
  else
    if (select count(*) from public.admin_users a
          join public.admin_roles r on r.id = a.role_id
         where r.code = 'owner') <= 1
       and exists (select 1 from public.admin_users a join public.admin_roles r on r.id = a.role_id
                    where a.user_id = p_user and r.code = 'owner') then
      raise exception 'cannot_remove_last_owner' using errcode = '42501';
    end if;
    delete from public.admin_users where user_id = p_user;
  end if;

  insert into public.audit_logs (actor_id, action, target, detail)
  values (actor, case when p_admin then 'admin.grant' else 'admin.revoke' end, p_user::text,
          jsonb_build_object('role', p_role_code));

  select coalesce(jsonb_agg(r.code), '[]'::jsonb) into codes
    from public.admin_users a join public.admin_roles r on r.id = a.role_id
   where a.user_id = p_user;
  return jsonb_build_object('isAdmin', public.is_admin(p_user), 'roles', codes);
end $$;

-- ---------------------------------------------------------------------------
-- security overview
-- ---------------------------------------------------------------------------
create or replace function public.admin_security_overview(p_hours integer default 24)
returns jsonb language plpgsql security definer set search_path = public as $$
declare actor uuid := public.require_admin('audit.read'); since timestamptz;
begin
  since := now() - make_interval(hours => greatest(1, least(coalesce(p_hours, 24), 720)));
  return jsonb_build_object(
    'window', jsonb_build_object('hours', greatest(1, least(coalesce(p_hours, 24), 720)), 'since', since),
    'adminLogins', coalesce((select jsonb_agg(jsonb_build_object(
        'id', a.id, 'actorId', a.actor_id, 'action', a.action, 'detail', a.detail,
        'createdAt', a.created_at) order by a.created_at desc)
        from (select * from public.audit_logs
               where action in ('auth.admin_password','auth.password_set','admin.grant','admin.revoke')
                 and created_at > since
               order by created_at desc limit 50) a), '[]'::jsonb),
    'failedAttempts', coalesce((select jsonb_agg(jsonb_build_object(
        'scope', t.scope, 'key', t.key, 'attempts', t.attempts, 'lastAt', t.last_at)
        order by t.attempts desc)
        from (select scope, key, count(*)::int as attempts, max(created_at) as last_at
                from public.auth_attempts
               where not succeeded and created_at > since
               group by scope, key order by count(*) desc limit 50) t), '[]'::jsonb),
    'activeSessions', coalesce((select jsonb_agg(jsonb_build_object(
        'id', s.id, 'email', u.email, 'createdAt', s.created_at, 'lastUsedAt', s.last_used_at,
        'ip', s.ip) order by s.last_used_at desc)
        from (select * from public.sessions where revoked_at is null and expires_at > now()
               order by last_used_at desc limit 50) s
        join public.users u on u.id = s.user_id), '[]'::jsonb),
    'admins', coalesce((select jsonb_agg(jsonb_build_object(
        'id', u.id, 'email', u.email, 'status', u.status, 'roles', r.codes,
        'lastSignInAt', u.last_sign_in_at) order by u.email)
        from public.admin_users a
        join public.users u on u.id = a.user_id
        join lateral (select coalesce(jsonb_agg(rr.code), '[]'::jsonb) codes
                        from public.admin_users aa join public.admin_roles rr on rr.id = aa.role_id
                       where aa.user_id = u.id) r on true), '[]'::jsonb),
    'suspendedAccounts', (select count(*) from public.users where status <> 'active')
  );
end $$;

-- ---------------------------------------------------------------------------
-- downloads list
-- ---------------------------------------------------------------------------
create or replace function public.admin_list_downloads(p_limit integer default 200)
returns jsonb language plpgsql security definer set search_path = public as $$
declare actor uuid := public.require_admin('overview.read');
begin
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', d.id, 'userId', d.user_id, 'email', u.email, 'version', d.version,
      'platform', d.platform, 'createdAt', d.created_at) order by d.created_at desc)
      from (select * from public.downloads order by created_at desc
             limit greatest(1, least(coalesce(p_limit, 200), 1000))) d
      join public.users u on u.id = d.user_id
  ), '[]'::jsonb);
end $$;

-- ---------------------------------------------------------------------------
-- system status (database-side facts; the API adds the environment facts it
-- alone can see)
-- ---------------------------------------------------------------------------
create or replace function public.admin_system_status()
returns jsonb language plpgsql security definer set search_path = public as $$
declare actor uuid := public.require_admin('overview.read'); t0 timestamptz := clock_timestamp();
begin
  return jsonb_build_object(
    'database', jsonb_build_object(
      'connected', true,
      'latencyMs', round(extract(milliseconds from clock_timestamp() - t0)::numeric, 2),
      'serverTime', now(),
      'sizeBytes', pg_database_size(current_database()),
      'migration', (select max(name) from public.schema_migrations)
    ),
    'maintenance', coalesce((select value from public.system_settings where key = 'maintenance'), '{"active":false}'::jsonb),
    'settings', coalesce((select jsonb_object_agg(key, value) from public.system_settings), '{}'::jsonb),
    'providers', coalesce((select jsonb_agg(jsonb_build_object(
        'code', p.code, 'label', p.label, 'kind', p.kind, 'active', p.active,
        'apiKeyEnv', p.api_key_env,
        'models', (select count(*) from public.ai_models m where m.provider_id = p.id and m.active))
        order by p.sort, p.code) from public.ai_providers p), '[]'::jsonb),
    'releases', coalesce((select jsonb_agg(jsonb_build_object(
        'version', r.version, 'channel', r.channel, 'platform', r.platform,
        'published', r.published, 'size', r.installer_size, 'notes', r.notes,
        'minimumSupportedVersion', r.minimum_supported_version,
        'releasedAt', r.released_at) order by r.released_at desc) from public.releases r), '[]'::jsonb),
    'posts', jsonb_build_object('sessionsActive', (select count(*) from public.sessions
        where revoked_at is null and expires_at > now()))
  );
end $$;
