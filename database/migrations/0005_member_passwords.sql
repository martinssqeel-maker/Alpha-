-- Member passwords, and proof of mailbox control.
--
-- Until this migration, public.password_credentials could only be written by
-- scripts/admin-password.mjs on the operator's machine: 0002_auth.sql says so in
-- a comment, and /auth/password additionally required an administrator role. An
-- email + password sign-up for members needs the first server-side write path to
-- that table, so the write is a SECURITY DEFINER function with its own checks
-- rather than ad-hoc SQL in the route.
--
-- It also adds the fact the download gate needs: whether this account has ever
-- proved it can receive mail at its address. A password proves knowledge, not
-- ownership — so an account created with a password is usable immediately but is
-- not handed an installer until the emailed code is confirmed.

alter table public.users add column if not exists email_verified_at timestamptz;

-- Accounts that exist today consumed an emailed code or signed in through a
-- provider that verifies mailboxes. Locking them out of downloads because of a
-- migration would be a regression of our own making, so they are marked verified
-- once, from evidence the row already carries.
update public.users
   set email_verified_at = coalesce(last_sign_in_at, created_at, now())
 where email_verified_at is null;

create or replace function public.set_password_credential(
  p_user uuid,
  p_hash text,
  p_algo text default 'scrypt'
)
returns void language plpgsql security definer set search_path = public as $$
begin
  if p_user is null then
    raise exception 'user_required' using errcode = '22023';
  end if;
  -- A real scrypt digest is ~140 characters; a truncated or empty value here
  -- would create an account nobody can sign in to, so refuse it loudly.
  if p_hash is null or length(p_hash) < 32 then
    raise exception 'invalid_credential' using errcode = '22023';
  end if;
  if not exists (select 1 from public.users u where u.id = p_user) then
    raise exception 'user_not_found' using errcode = 'P0002';
  end if;

  insert into public.password_credentials (user_id, password_hash, algo)
  values (p_user, p_hash, coalesce(nullif(p_algo, ''), 'scrypt'))
  on conflict (user_id) do update
    set password_hash = excluded.password_hash,
        algo = excluded.algo;
end $$;

-- Idempotent: the first proof of mailbox control wins and is never cleared by a
-- later sign-in, so one code is enough for the life of the account.
create or replace function public.mark_email_verified(p_user uuid)
returns void language sql security definer set search_path = public as $$
  update public.users
     set email_verified_at = coalesce(email_verified_at, now())
   where id = p_user
$$;

create or replace function public.email_is_verified(p_user uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select email_verified_at is not null from public.users where id = p_user), false)
$$;
