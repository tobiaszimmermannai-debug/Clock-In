-- =============================================================================
-- Aufgaben · Serie: freie Tage, Schule, Urlaub und Krank unterbrechen nie
-- =============================================================================
-- Ein Tag zählt für Blitzis Serie nur, wenn die Person an dem Tag eingestempelt hat ("Kommen") und für den
-- Tag weder Berufsschule noch Urlaub, Krank oder frei im Dienstplan steht. Alle anderen Tage (nicht eingeplant,
-- z. B. Samstag ohne Schicht, Schule …) sind neutral; Sonntag ist in der App immer neutral.
-- note_team_work_days liefert diese Tage auch für andere – nur so weit man sie ohnehin betreut:
-- Admin alle, Studioleitung ihr Studio, Studio-PC die Mitarbeiter seines Studios, sonst nur sich selbst.
-- (Mehrfach ausführbar.) Voraussetzung: 20261101090000_notes_roles_gamification.sql
-- =============================================================================

create or replace function private.note_counting_days(p_user uuid, p_since date) returns setof date
language sql stable security definer set search_path = '' as $$
  select (t.recorded_at at time zone 'Europe/Berlin')::date
  from public.time_logs t
  where t.user_id = p_user
    and t.event_type = 'clock_in'
    and t.recorded_at >= p_since
  except
  select s.shift_date
  from public.shifts s
  where s.user_id = p_user
    and s.shift_type::text in ('vocational_school', 'vacation', 'sick', 'day_off')
    and s.shift_date >= p_since
$$;

-- Eigene Tage (ältere App-Versionen)
create or replace function public.note_work_days(p_since date) returns setof date
language sql stable security definer set search_path = '' as $$
  select d from private.note_counting_days(private.current_user_id(), p_since) as d
$$;

-- Tage aller Personen, die man betreut (für Studio-PC, Team-Übersicht und Feier)
create or replace function public.note_team_work_days(p_since date) returns table (user_id uuid, day date)
language sql stable security definer set search_path = '' as $$
  with pc as (
    select k.location_id from public.kiosk_devices k
    where k.auth_user_id = (select auth.uid()) and k.is_active and k.kind = 'pc'
    limit 1
  ),
  visible as (
    select u.id, u.auth_user_id from public.users u
    where u.is_active
      and u.auth_user_id is not null
      and (
        u.auth_user_id = (select auth.uid())
        or private.manages_user(u.id)
        or u.home_location_id = (select pc.location_id from pc)
      )
  )
  select v.auth_user_id, d
  from visible v
  cross join lateral private.note_counting_days(v.id, p_since) as d
$$;

revoke execute on function private.note_counting_days(uuid, date) from public, anon, authenticated;
revoke execute on function public.note_work_days(date), public.note_team_work_days(date) from public, anon;
grant execute on function public.note_work_days(date), public.note_team_work_days(date) to authenticated;
