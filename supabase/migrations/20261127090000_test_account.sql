-- Testkonto: users.is_test. Taucht nicht in der Statistik (team_stats), der Aufgaben-Team-Wertung (note_week_active)
-- und den Kollegen-/Dienstplanlisten der Mitarbeiter auf. Admins sehen es mit „Test“-Markierung. Wiederholbar.
alter table public.users add column if not exists is_test boolean not null default false;

-- Aufgaben-Team-Wertung: Testkonten zählen nicht
create or replace function public.note_week_active(p_from date, p_to date) returns setof uuid
language sql stable security definer set search_path = '' as $$
  select u.auth_user_id
  from public.users u
  where u.is_active and not u.is_test and u.auth_user_id is not null
    and ((select auth.uid()) is null or private.is_note_user())
    and exists (select 1 from private.note_counting_days(u.id, p_from) as d where d < p_to)
$$;

-- Statistik „Stunden & Abwesenheit“: ohne Testkonten
drop function if exists public.team_stats(date, date);
create function public.team_stats(p_from date, p_to date)
returns table (
  user_id uuid, first_name text, last_name text, role public.user_role, home_location_id uuid,
  weekly_target_minutes integer, target_minutes integer, worked_minutes integer, credit_minutes integer,
  late_count integer, late_minutes integer, overtime_pending_minutes integer, overtime_approved_minutes integer,
  open_days integer, forgotten_count integer, early_count integer, early_minutes integer,
  sick_days integer, vacation_days integer, school_days integer, work_shifts integer,
  counted_from date   -- ab hier zählt das Soll (null = noch nie gestempelt)
)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_to   date := least(p_to, (now() at time zone 'Europe/Berlin')::date - 1);  -- bis gestern (heute läuft noch)
  v_days integer;
  v_start date;
  u      record;
  s      record;
  v_from date;
  v_end  date;
begin
  if auth.uid() is not null and not (private.is_admin() or private.is_manager()) then
    raise exception 'Statistik nur für Admins und Studioleitungen.';
  end if;
  if p_from is null or v_to < p_from then
    return;
  end if;
  if v_to - p_from > 366 then
    raise exception 'Zeitraum zu lang (höchstens ein Jahr).';
  end if;

  for u in
    select x.id, x.first_name, x.last_name, x.role, x.home_location_id, coalesce(e.weekly_target_minutes, 0) as weekly,
           e.employment_start,
           (select min((t.recorded_at at time zone 'Europe/Berlin')::date) from public.time_logs t
            where t.user_id = x.id and t.approval_status <> 'rejected') as first_stamp
    from public.users x
    left join public.employment_details e on e.user_id = x.id
    where x.is_active and not x.is_test and x.role <> 'admin' and x.time_tracking
      and (auth.uid() is null or private.manages_user(x.id))
    order by x.first_name, x.last_name
  loop
    user_id := u.id; first_name := u.first_name; last_name := u.last_name; role := u.role;
    home_location_id := u.home_location_id; weekly_target_minutes := u.weekly;
    -- Soll: Wochenstunden ÷ 5 je Werktag (Mo–Fr) ab Beginn der Zählung bis heute
    v_start := greatest(p_from, u.employment_start, u.first_stamp);
    counted_from := case when u.first_stamp is null then null else v_start end;
    select count(*) into v_days from generate_series(v_start, v_to, interval '1 day') d where extract(isodow from d) < 6;
    target_minutes := case when u.first_stamp is null then 0 else round(u.weekly / 5.0 * coalesce(v_days, 0)) end;
    worked_minutes := 0; credit_minutes := 0; late_count := 0; late_minutes := 0;
    overtime_pending_minutes := 0; overtime_approved_minutes := 0; open_days := 0;
    -- Stundenberechnung in Blöcken von 90 Tagen (work_day_summary erlaubt höchstens 93)
    v_from := p_from;
    while v_from <= v_to loop
      v_end := least(v_from + 89, v_to);
      for s in select * from public.work_day_summary(u.id, v_from, v_end) loop
        worked_minutes := worked_minutes + s.worked_minutes;
        credit_minutes := credit_minutes + s.credit_minutes;
        late_count := late_count + (s.late_minutes > 0)::int;
        late_minutes := late_minutes + s.late_minutes;
        overtime_pending_minutes := overtime_pending_minutes + s.overtime_pending_minutes;
        overtime_approved_minutes := overtime_approved_minutes + s.overtime_approved_minutes;
        open_days := open_days + (s.open_session and s.day < v_to)::int;
      end loop;
      v_from := v_end + 1;
    end loop;
    select count(*) filter (where t.source = 'auto_checkout')
      into forgotten_count
    from public.time_logs t
    where t.user_id = u.id and t.approval_status <> 'rejected'
      and t.recorded_at >= private.berlin_day_start(p_from) and t.recorded_at < private.berlin_day_start(v_to + 1);
    -- Früher gegangen: Minusstunden = Zeit bis Schichtende, wenn nicht „bis Schichtende angerechnet“ oder „krank“
    select count(*), coalesce(sum(floor(extract(epoch from sh.ends_at - t.recorded_at) / 60)), 0)::integer
      into early_count, early_minutes
    from public.time_logs t
    join public.shifts sh on sh.id = t.shift_id
    where t.user_id = u.id and t.event_type = 'clock_out' and t.approval_status <> 'rejected'
      and t.early_status is not null and t.early_status not in ('approved', 'sick')
      and t.recorded_at < sh.ends_at
      and t.recorded_at >= private.berlin_day_start(p_from) and t.recorded_at < private.berlin_day_start(v_to + 1);
    select count(distinct sh.shift_date) filter (where sh.shift_type = 'sick'),
           count(distinct sh.shift_date) filter (where sh.shift_type = 'vacation'),
           count(distinct sh.shift_date) filter (where sh.shift_type = 'vocational_school'),
           count(*) filter (where sh.shift_type = 'work')
      into sick_days, vacation_days, school_days, work_shifts
    from public.shifts sh
    where sh.user_id = u.id and sh.shift_date between p_from and v_to;
    return next;
  end loop;
end $$;

revoke execute on function public.team_stats(date, date) from public, anon;
grant execute on function public.team_stats(date, date) to authenticated, service_role;
