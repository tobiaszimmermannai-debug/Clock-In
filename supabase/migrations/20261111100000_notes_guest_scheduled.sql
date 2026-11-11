-- =============================================================================
-- Aufgaben · Aushilfe zählt auch, wenn sie im Dienstplan für das Gaststudio eingetragen ist
-- =============================================================================
-- Bisher galt nur das Einstempeln im Gaststudio als „heute hier“. Wer laut Dienstplan heute als Aushilfe in einem
-- anderen Studio arbeitet (Schicht mit diesem Studio), erscheint jetzt schon vorher am Studio-PC des Gaststudios
-- (Reiter „Aushilfe“, bis zum Einstempeln mit „–“) und sieht nach dem Einstempeln dessen Team-Aufgaben – egal an
-- welchem Tablet gestempelt wurde. Eingestempelt hat weiterhin Vorrang vor dem Dienstplan. (Mehrfach ausführbar.)
-- Voraussetzung: 20261108100000_notes_studio_teams_prestige.sql
-- =============================================================================

-- Heute in diesem Studio: eingestempelt ODER laut Dienstplan heute dort (Arbeitsschicht)
create or replace function private.checked_in_today_at(p_user uuid, p_location uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.time_logs t
    where t.user_id = p_user and t.location_id = p_location and t.event_type = 'clock_in'
      and t.approval_status <> 'rejected'
      and t.recorded_at >= ((now() at time zone 'Europe/Berlin')::date)::timestamp at time zone 'Europe/Berlin')
  or exists (
    select 1 from public.shifts s
    where s.user_id = p_user and s.location_id = p_location and s.shift_type = 'work'
      and s.shift_date = (now() at time zone 'Europe/Berlin')::date)
$$;

-- Wo ist wer heute? Letztes Einstempeln von heute; wer noch nicht gestempelt hat, aber laut Dienstplan heute in
-- einem anderen als dem Heimatstudio arbeitet (Aushilfe), mit dem Studio dieser Schicht.
create or replace function public.note_here_today() returns table (user_id uuid, location_id uuid)
language sql stable security definer set search_path = '' as $$
  with stamped as (
    select distinct on (u.id) u.id, u.auth_user_id, t.location_id
    from public.time_logs t
    join public.users u on u.id = t.user_id and u.is_active and u.auth_user_id is not null
    where t.event_type = 'clock_in' and t.approval_status <> 'rejected' and t.location_id is not null
      and t.recorded_at >= ((now() at time zone 'Europe/Berlin')::date)::timestamp at time zone 'Europe/Berlin'
    order by u.id, t.recorded_at desc
  ),
  planned as (
    select distinct on (u.id) u.id, u.auth_user_id, s.location_id
    from public.shifts s
    join public.users u on u.id = s.user_id and u.is_active and u.auth_user_id is not null
    where s.shift_type = 'work' and s.location_id is not null
      and s.location_id is distinct from u.home_location_id
      and s.shift_date = (now() at time zone 'Europe/Berlin')::date
      and not exists (select 1 from stamped x where x.id = u.id)
    order by u.id, s.starts_at
  )
  select auth_user_id, location_id from stamped where private.is_note_user()
  union all
  select auth_user_id, location_id from planned where private.is_note_user()
$$;

revoke execute on function private.checked_in_today_at(uuid, uuid) from public, anon;
grant execute on function private.checked_in_today_at(uuid, uuid) to authenticated, service_role;
revoke execute on function public.note_here_today() from public, anon;
grant execute on function public.note_here_today() to authenticated;
