-- =============================================================================
-- Aufgaben · nur eingecheckt: Mitarbeiter sehen ihre Aufgaben erst nach dem Einchecken im Studio
-- =============================================================================
-- * Geschäftsführung (Admin mit 2FA) und Studioleitung sehen weiterhin alles, was sie betreuen.
-- * Mitarbeiter: Bereich „Aufgaben“ nur, solange sie eingecheckt sind (letzte Buchung ist nicht „Gehen“).
-- * Personen ohne Zeiterfassung (z. B. Praktikanten, users.time_tracking = false) sehen ihre Aufgaben immer.
-- * Studio-PC: Team-Seiten wie bisher; die App zeigt die Reiter einzelner Personen erst nach deren Einchecken.
-- (Mehrfach ausführbar.) Voraussetzung: 20261103090000_notes_daily_telegram.sql
-- =============================================================================

-- Zeiterfassung pro Person (auch in ClockIns Migration 20261104080000_time_tracking.sql)
alter table public.users add column if not exists time_tracking boolean not null default true;

-- Gerade eingecheckt? Letzte gültige Buchung der letzten 16 Stunden ist nicht „Gehen“
create or replace function private.is_checked_in(p_user uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((
    select t.event_type <> 'clock_out'
    from public.time_logs t
    where t.user_id = p_user
      and t.approval_status <> 'rejected'
      and t.recorded_at > now() - interval '16 hours'
    order by t.recorded_at desc
    limit 1), false)
$$;

-- Darf die angemeldete Person gerade an ihre Aufgaben?
create or replace function private.note_gate_ok() returns boolean
language sql stable security definer set search_path = '' as $$
  select private.is_admin() or private.is_manager() or exists (
    select 1 from public.users u
    where u.auth_user_id = (select auth.uid())
      and u.is_active
      and (not u.time_tracking or private.is_checked_in(u.id))
  )
$$;

-- Zugriff: Leitung wie bisher (betreute Seiten), Mitarbeiter nur eingecheckt, Studio-PC Team-Seiten
create or replace function private.can_access_note(p_space public.note_space, p_owner uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select (private.is_staff() and (
            private.can_oversee_note(p_space, p_owner)
            or (private.note_gate_ok() and (p_owner = (select auth.uid()) or p_space = 'team'))))
      or (p_space = 'team' and private.is_studio_pc())
$$;

-- Eigene Rechte für die App – zusätzlich: gesperrt (nicht eingecheckt)
create or replace function public.note_access() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'oversee', private.is_admin() or private.is_manager(),
    'admin', private.is_admin(),
    'studio', private.is_studio_pc(),
    'studio_name', (select k.name from public.kiosk_devices k
                    where k.auth_user_id = (select auth.uid()) and k.is_active limit 1),
    'studio_location', (select k.location_id from public.kiosk_devices k
                        where k.auth_user_id = (select auth.uid()) and k.is_active limit 1),
    'locked', private.is_staff() and not private.note_gate_ok() and not private.is_studio_pc()
  )
$$;

-- Wer darf gerade an seine Aufgaben (für die Reiter am Studio-PC und in der Team-Übersicht)?
-- Sichtbar wie note_day_plan: selbst, betreute Personen, Studio-PC sein Studio, Server alle.
create or replace function public.note_unlocked() returns table (user_id uuid, unlocked boolean)
language sql stable security definer set search_path = '' as $$
  with pc as (
    select k.location_id from public.kiosk_devices k
    where k.auth_user_id = (select auth.uid()) and k.is_active and k.kind = 'pc'
    limit 1
  )
  select u.auth_user_id, (not u.time_tracking or private.is_checked_in(u.id))
  from public.users u
  where u.is_active
    and u.auth_user_id is not null
    and (
      (select auth.uid()) is null
      or u.auth_user_id = (select auth.uid())
      or private.manages_user(u.id)
      or u.home_location_id = (select pc.location_id from pc)
    )
$$;

revoke execute on function private.is_checked_in(uuid), private.note_gate_ok() from public, anon, authenticated;
revoke execute on function public.note_unlocked() from public, anon;
grant execute on function public.note_unlocked() to authenticated, service_role;
