-- =============================================================================
-- Clock-In · Monatsbericht 2.0 (Daten)
-- =============================================================================
-- Zusätzlich zum Dienstplan der drei Monate liefert monthly_report jetzt die Auswertung des Vormonats:
-- je Mitarbeiter und Tag Ist/Gutschrift/Verspätung (wie im Portal, work_day_summary), Verspätungen der
-- letzten 3 Monate, Krankheitstage im Jahr, Vertragsdaten (Wochenstunden, Ein-/Austritt) und die Regeln.
-- Daraus baut die Telegram-Function Kennzahlen, Studio-Tabellen, Wochenübersicht und Excel-Stundenzettel.
-- (Mehrfach ausführbar.)
-- =============================================================================

create or replace function public.monthly_report(p_month date)
returns jsonb
language sql stable security definer set search_path = '' as $$
  with bounds as (
    select (date_trunc('month', p_month) - interval '1 month')::date as d_from,      -- Vormonat
           (date_trunc('month', p_month))::date - 1                as d_last,       -- letzter Tag Vormonat
           (date_trunc('month', p_month) - interval '3 months')::date as d_trend,   -- Trend: 3 Monate
           (date_trunc('month', p_month) + interval '2 months')::date as d_to,
           (now() at time zone 'Europe/Berlin')::date as today
  ),
  people as (
    select u.id, u.first_name, u.last_name, u.role, l.name as studio,
           e.weekly_target_minutes, e.work_days_per_week, e.employment_start, e.employment_end
    from public.users u
    left join public.locations l on l.id = u.home_location_id
    left join public.employment_details e on e.user_id = u.id
    where u.is_active and u.role <> 'admin'
  ),
  entries as (
    select s.user_id, s.shift_type::text as type, s.starts_at, s.ends_at, s.note, s.is_acquisition,
           coalesce(s.is_herold, false) as is_herold, l.name as studio,
           (s.starts_at at time zone 'Europe/Berlin')::date as day
    from public.shifts s
    join people p on p.id = s.user_id
    left join public.locations l on l.id = s.location_id, bounds b
    where s.starts_at >= private.berlin_day_start(b.d_from) and s.starts_at < private.berlin_day_start(b.d_to)
  ),
  -- Tagesauswertung der letzten 3 Monate (Detail nur Vormonat, davor nur für den Verspätungs-Trend)
  days as (
    select p.id as user_id, d.*
    from people p cross join bounds b
    cross join lateral public.work_day_summary(p.id, b.d_trend, b.d_last) d
  ),
  years as (
    select distinct extract(year from d)::integer as y
    from bounds b, generate_series(b.d_from, b.d_to - 1, interval '1 month') d
  ),
  vacation as (
    select p.id as user_id, y.y as year,
           coalesce(a.days, (select r.default_vacation_days from public.rule_settings r), 20) as allowance,
           count(distinct s.shift_date) filter (where s.shift_date <= b.today) as taken,
           count(distinct s.shift_date) filter (where s.shift_date > b.today) as planned
    from people p cross join years y cross join bounds b
    left join public.vacation_allowances a on a.user_id = p.id and a.year = y.y
    left join public.shifts s on s.user_id = p.id and s.shift_type = 'vacation'
          and s.shift_date >= make_date(y.y, 1, 1) and s.shift_date < make_date(y.y + 1, 1, 1)
    group by p.id, y.y, a.days
  ),
  sick_year as (
    select s.user_id, count(distinct s.shift_date) as days
    from public.shifts s cross join bounds b
    where s.shift_type = 'sick' and s.shift_date >= make_date(extract(year from b.d_last)::integer, 1, 1)
      and s.shift_date <= b.d_last
    group by s.user_id
  )
  select jsonb_build_object(
    'from', (select d_from from bounds),
    'to', (select d_to from bounds),
    'trend_from', (select d_trend from bounds),
    'today', (select today from bounds),
    'settings', (select jsonb_build_object('absence_credit_minutes', r.absence_credit_minutes,
                                           'absence_week_days', r.absence_week_days,
                                           'school_credit_minutes', r.school_credit_minutes,
                                           'late_tolerance_minutes', r.late_tolerance_minutes)
                 from public.rule_settings r),
    'people', coalesce((select jsonb_agg(to_jsonb(p) order by p.studio nulls last, p.first_name, p.last_name) from people p), '[]'),
    'entries', coalesce((select jsonb_agg(to_jsonb(e) order by e.starts_at) from entries e), '[]'),
    'days', coalesce((select jsonb_agg(jsonb_build_object(
               'user_id', d.user_id, 'day', d.day, 'planned', d.planned_minutes, 'worked', d.worked_minutes,
               'break', d.break_minutes, 'credit', d.credit_minutes, 'absence', d.absence, 'late', d.late_minutes,
               'ot_pending', d.overtime_pending_minutes, 'ot_approved', d.overtime_approved_minutes, 'open', d.open_session)
             order by d.user_id, d.day)
             from days d
             where d.planned_minutes > 0 or d.worked_minutes > 0 or d.credit_minutes > 0 or d.late_minutes > 0
                or d.absence is not null or d.open_session), '[]'),
    'vacation', coalesce((select jsonb_agg(to_jsonb(v) order by v.year) from vacation v), '[]'),
    'sick_year', coalesce((select jsonb_object_agg(s.user_id, s.days) from sick_year s), '{}')
  )
$$;
revoke execute on function public.monthly_report(date) from public, anon, authenticated;
grant execute on function public.monthly_report(date) to service_role;
