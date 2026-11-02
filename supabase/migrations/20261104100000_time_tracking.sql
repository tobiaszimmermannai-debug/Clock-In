-- =============================================================================
-- Clock-In · Personen ohne Zeiterfassung (z. B. Praktikanten)
-- =============================================================================
-- users.time_tracking = false: kann nicht stempeln (auch nicht nachgetragen), bekommt keine
-- „nicht eingestempelt“-Meldung, keine 18-Uhr-Abfrage und erscheint nicht im Wochenbericht.
-- Dienstplan, Aufgaben und Konto bleiben nutzbar. (Mehrfach ausführbar.)
-- =============================================================================

alter table public.users add column if not exists time_tracking boolean not null default true;

-- Stempeln für Personen ohne Zeiterfassung verhindern (alle Wege: Handy, Tablet, Nachtrag)
create or replace function private.time_logs_require_tracking() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from public.users u where u.id = new.user_id and not u.time_tracking) then
    raise exception 'Für diese Person ist keine Zeiterfassung vorgesehen.' using errcode = 'P0001';
  end if;
  return new;
end $$;

drop trigger if exists time_logs_require_tracking on public.time_logs;
create trigger time_logs_require_tracking before insert on public.time_logs
  for each row execute function private.time_logs_require_tracking();

-- „Nicht eingestempelt“-Meldung: nur Personen mit Zeiterfassung
create or replace function private.no_show_check() returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_settings public.rule_settings;
  v_shift    record;
  v_count    integer := 0;
begin
  select * into v_settings from public.rule_settings;
  for v_shift in
    select s.id, s.user_id, s.starts_at, s.is_acquisition, u.first_name, u.last_name, l.name as location
    from public.shifts s
    join public.users u on u.id = s.user_id and u.is_active and u.time_tracking
    join public.locations l on l.id = s.location_id
    where s.shift_type = 'work'
      and s.starts_at <= now() - make_interval(mins => v_settings.late_tolerance_minutes)
      and s.starts_at > now() - interval '2 hours'
      and s.ends_at > now()
      and s.created_at < s.starts_at                                    -- nachträglich geplant → keine Meldung
      and (s.note is null or s.note not like 'Aushilfsschicht%')        -- entsteht erst beim Einstempeln
      -- eingestempelt (ab 1 Std. vor Beginn) …
      and not exists (
        select 1 from public.time_logs t
        where t.user_id = s.user_id and t.event_type = 'clock_in' and t.approval_status <> 'rejected'
          and t.recorded_at >= s.starts_at - interval '1 hour')
      -- … oder noch von vorher anwesend
      and coalesce((
        select t.event_type <> 'clock_out' from public.time_logs t
        where t.user_id = s.user_id and t.approval_status <> 'rejected' and t.recorded_at > now() - interval '14 hours'
        order by t.recorded_at desc limit 1), false) = false
  loop
    insert into public.no_show_alerts (shift_id) values (v_shift.id) on conflict do nothing;
    continue when not found;
    perform private.call_telegram(jsonb_build_object(
      'type', 'not_checked_in',
      'name', v_shift.first_name || ' ' || v_shift.last_name,
      'location', v_shift.location,
      'start', to_char(v_shift.starts_at at time zone 'Europe/Berlin', 'HH24:MI'),
      'acquisition', v_shift.is_acquisition));
    v_count := v_count + 1;
  end loop;
  return v_count;
end $$;

-- 18-Uhr-Abfrage (Krank/Schule/Urlaub?): nur Personen mit Zeiterfassung
create or replace function public.absence_candidates(p_day date)
returns table (user_id uuid, first_name text, last_name text)
language sql stable security definer set search_path = '' as $$
  select u.id, u.first_name, u.last_name
  from public.users u
  left join public.employment_details e on e.user_id = u.id
  where u.is_active and u.role <> 'admin' and u.time_tracking
    and extract(isodow from p_day) <> 7  -- Sonntag: niemand eingeplant, keine Nachfrage
    and (e.employment_start is null or e.employment_start <= p_day)
    and (e.employment_end is null or e.employment_end >= p_day)
    and not exists (
      select 1 from public.shifts s
      where s.user_id = u.id and s.starts_at >= private.berlin_day_start(p_day) and s.starts_at < private.berlin_day_start(p_day + 1))
    and not exists (
      select 1 from public.time_logs t
      where t.user_id = u.id and t.approval_status <> 'rejected'
        and t.recorded_at >= private.berlin_day_start(p_day) and t.recorded_at < private.berlin_day_start(p_day + 1))
    and (
      select count(distinct s.shift_date) from public.shifts s
      where s.user_id = u.id
        and s.shift_date between date_trunc('week', p_day)::date and date_trunc('week', p_day)::date + 6
    ) < coalesce(e.work_days_per_week, 5)
    -- Samstag arbeitet meist nur eine Person: alle anderen automatisch frei (keine Frage) –
    -- außer im eigenen Studio hat an dem Tag niemand eingestempelt
    and not (
      extract(isodow from p_day) = 6
      and exists (
        select 1 from public.time_logs t
        where t.location_id = u.home_location_id and t.event_type = 'clock_in' and t.approval_status <> 'rejected'
          and t.recorded_at >= private.berlin_day_start(p_day) and t.recorded_at < private.berlin_day_start(p_day + 1)))
  order by u.last_name, u.first_name
$$;
revoke execute on function public.absence_candidates(date) from public, anon, authenticated;
grant execute on function public.absence_candidates(date) to service_role;

-- Wochenbericht: nur Personen mit Zeiterfassung
create or replace function public.weekly_report(p_from date, p_to date)
returns table (
  user_id                   uuid,
  first_name                text,
  last_name                 text,
  role                      public.user_role,
  target_minutes            integer,
  worked_minutes            integer,
  credit_minutes            integer,
  late_count                integer,
  late_minutes              integer,
  overtime_pending_minutes  integer,
  overtime_approved_minutes integer,
  open_days                 integer,
  forgotten_count           integer
)
language sql stable security definer set search_path = '' as $$
  select u.id, u.first_name, u.last_name, u.role,
         coalesce(e.weekly_target_minutes, 0),
         coalesce(sum(s.worked_minutes), 0)::integer,
         coalesce(sum(s.credit_minutes), 0)::integer,
         (count(*) filter (where s.late_minutes > 0))::integer,
         coalesce(sum(s.late_minutes), 0)::integer,
         coalesce(sum(s.overtime_pending_minutes), 0)::integer,
         coalesce(sum(s.overtime_approved_minutes), 0)::integer,
         (count(*) filter (where s.open_session))::integer,
         (select count(*) from public.time_logs t
          where t.user_id = u.id and t.source = 'auto_checkout'
            and t.recorded_at >= private.berlin_day_start(p_from)
            and t.recorded_at < private.berlin_day_start(p_to + 1))::integer
  from public.users u
  left join public.employment_details e on e.user_id = u.id
  cross join lateral public.work_day_summary(u.id, p_from, p_to) s
  where u.is_active and u.role <> 'admin' and u.time_tracking
  group by u.id, u.first_name, u.last_name, u.role, e.weekly_target_minutes
  order by u.last_name, u.first_name
$$;
revoke execute on function public.weekly_report(date, date) from public, anon, authenticated;
grant execute on function public.weekly_report(date, date) to service_role;

revoke execute on function private.time_logs_require_tracking() from public, anon, authenticated;
