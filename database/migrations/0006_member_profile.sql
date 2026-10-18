-- Profile fields collected by the member sign-up form.
--
-- full_name already exists (0001_platform.sql); phone does not. It is nullable
-- because every account that exists today was created by an emailed code or a
-- provider and never filled a form — a migration must not invent contact details
-- for those people.
--
-- The number is stored as typed, normalized to a leading `+` and digits by the
-- API. It is contact information, not a second factor: nothing here sends SMS,
-- so there is deliberately no verified flag that would imply an SMS check took
-- place.

alter table public.users add column if not exists phone text;
