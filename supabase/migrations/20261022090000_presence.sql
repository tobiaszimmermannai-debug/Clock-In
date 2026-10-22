-- =============================================================================
-- Clock-In · „Wer ist da?“ – Live-Überblick für Admin und Studioleitung
-- =============================================================================
-- Eine Zeile pro Person mit Bezug zu heute (Stempelung, Arbeitsschicht oder Abwesenheit):
--   in      eingestempelt (arbeitet)            since = letztes Kommen/Pause Ende, clocked_in = Kommen
--           (sonst: clocked_in = erstes Kommen heute, last_out = letztes Gehen heute)
--   break   in Pause                            since = Pause Start
--   missing Schicht hat begonnen (+ Toleranz), noch nicht eingestempelt
--   later   Schicht kommt noch (z. B. Splitschicht, Herold + Schicht)
--   gone    heute schon gegangen                since = letztes Gehen
--   missed  Schicht ist vorbei, nie eingestempelt
--   absent  krank / Urlaub / Schule / frei      tag = Art
-- Nur für Admins.
-- (Mehrfach ausführbar.)
-- =============================================================================

drop function if exists public.presence_today();
create function public.presence_today()
returns table (user_id uuid, first_name text, last_name text, location_id uuid, state text,
               clocked_in timestamptz, since timestamptz, last_out timestamptz,
               shift_start timestamptz, shift_end timestamptz, late_minutes integer, tag text, pending boolean)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_today date := (now() at time zone 'Europe/Berlin')::date;
  v_from  timestamptz := private.berlin_day_start(v_today);
  v_to    timestamptz := private.berlin_day_start(v_today + 1);
  v_tol   integer;
begin
  if not private.is_admin() then
    raise exception 'Dafür fehlt die Berechtigung.' using errcode = '42501';
  end if;
  select r.late_tolerance_minutes into v_tol from public.rule_settings r;

  return query
  with logs as (
    select t.* from public.time_logs t
    where t.approval_status <> 'rejected' and t.recorded_at > least(v_from, now() - interval '16 hours')
  ),
  last_log as (  -- aktueller Status (wie beim Stempeln: letzte Buchung der letzten 16 Std.)
    select distinct on (l.user_id) l.* from logs l
    where l.recorded_at > now() - interval '16 hours'
    order by l.user_id, l.recorded_at desc
  ),
  last_in as (
    select distinct on (l.user_id) l.* from logs l
    where l.event_type = 'clock_in' and l.recorded_at > now() - interval '16 hours'
    order by l.user_id, l.recorded_at desc
  ),
  today as (
    select l.user_id,
           min(l.recorded_at) filter (where l.event_type = 'clock_in')  as first_in,
           max(l.recorded_at) filter (where l.event_type = 'clock_out') as last_out,
           bool_or(l.approval_status = 'pending')                        as pending
    from logs l where l.recorded_at >= v_from
    group by l.user_id
  ),
  work as (
    select s.* from public.shifts s
    where s.shift_type = 'work' and s.starts_at < v_to and s.ends_at > v_from
  ),
  open_shift as (  -- nächste Schicht, die noch läuft oder kommt und noch nicht angetreten ist
    select distinct on (w.user_id) w.* from work w
    where w.ends_at > now()
      and not exists (select 1 from logs l where l.shift_id = w.id and l.event_type = 'clock_in')
    order by w.user_id, w.starts_at
  ),
  missed as (  -- vorbei und nie angetreten
    select distinct on (w.user_id) w.* from work w
    where w.ends_at <= now()
      and not exists (select 1 from logs l where l.shift_id = w.id and l.event_type = 'clock_in')
    order by w.user_id, w.starts_at
  ),
  absent as (
    select distinct on (s.user_id) s.* from public.shifts s
    where s.shift_type::text in ('sick', 'vacation', 'vocational_school', 'day_off')
      and s.starts_at < v_to and s.ends_at > v_from
    order by s.user_id, s.starts_at
  ),
  base as (
    select u.id as uid, u.first_name as fn, u.last_name as ln, u.home_location_id as home,
           ll.event_type as ev, ll.recorded_at as ev_at, li.recorded_at as in_at, li.location_id as in_loc,
           cs.starts_at as cs_start, cs.ends_at as cs_end, cs.is_herold as cs_herold, cs.is_acquisition as cs_acq,
           os.location_id as os_loc, os.starts_at as os_start, os.ends_at as os_end,
           os.is_herold as os_herold, os.is_acquisition as os_acq,
           ms.location_id as ms_loc, ms.starts_at as ms_start, ms.ends_at as ms_end,
           ab.location_id as ab_loc, ab.starts_at as ab_start, ab.ends_at as ab_end, ab.shift_type::text as ab_type,
           td.first_in as t_first, td.last_out as t_out, coalesce(td.pending, false) as t_pending
    from public.users u
    left join last_log ll on ll.user_id = u.id
    left join last_in li on li.user_id = u.id
    left join public.shifts cs on cs.id = li.shift_id
    left join open_shift os on os.user_id = u.id
    left join missed ms on ms.user_id = u.id
    left join absent ab on ab.user_id = u.id
    left join today td on td.user_id = u.id
    where u.is_active
  ),
  classified as (
    select r.*,
           case
             when r.ev in ('clock_in', 'break_end') then 'in'
             when r.ev = 'break_start' then 'break'
             when r.os_start is not null and now() >= r.os_start + make_interval(mins => v_tol) then 'missing'
             when r.os_start is not null then 'later'
             when r.t_first is not null then 'gone'
             when r.ms_start is not null then 'missed'
             when r.ab_start is not null then 'absent'
           end as st
    from base r
  ),
  shaped as (
    select c.uid, c.fn, c.ln, c.st, c.home, c.t_out, c.t_pending,
           case when c.st in ('in', 'break') then c.in_at else c.t_first end as clk,
           case
             when c.st in ('in', 'break', 'gone') then coalesce(c.in_loc, c.home)
             when c.st in ('missing', 'later') then coalesce(c.os_loc, c.home)
             when c.st = 'missed' then coalesce(c.ms_loc, c.home)
             else coalesce(c.ab_loc, c.home)
           end as loc,
           case when c.st in ('in', 'break') then c.ev_at when c.st = 'gone' then c.t_out end as at,
           case when c.st in ('in', 'break', 'gone') then c.cs_start
                when c.st in ('missing', 'later') then c.os_start
                when c.st = 'missed' then c.ms_start else c.ab_start end as s_start,
           case when c.st in ('in', 'break', 'gone') then c.cs_end
                when c.st in ('missing', 'later') then c.os_end
                when c.st = 'missed' then c.ms_end else c.ab_end end as s_end,
           case when c.st in ('in', 'break', 'gone')
                     and c.in_at > c.cs_start + make_interval(mins => v_tol)
                  then (extract(epoch from c.in_at - c.cs_start) / 60)::integer
                when c.st = 'missing' then (extract(epoch from now() - c.os_start) / 60)::integer
           end as late,
           case when c.st = 'absent' then c.ab_type
                when c.st in ('in', 'break', 'gone') and c.cs_herold
                  or c.st in ('missing', 'later') and c.os_herold then 'herold'
                when c.st in ('in', 'break', 'gone') and c.cs_acq
                  or c.st in ('missing', 'later') and c.os_acq then 'acquisition'
           end as tg
    from classified c
    where c.st is not null
  )
  select s.uid, s.fn, s.ln, s.loc, s.st, s.clk, s.at, s.t_out, s.s_start, s.s_end, s.late, s.tg, s.t_pending
  from shaped s
  order by s.fn, s.ln;
end $$;
revoke execute on function public.presence_today() from public, anon;
grant execute on function public.presence_today() to authenticated;
