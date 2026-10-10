-- =============================================================================
-- Clock-In · Samstag: automatisch frei
-- =============================================================================
-- 18-Uhr-Abfrage („Was war los?“): Am Samstag arbeitet meist nur eine Person je Studio. Wer am Samstag
-- weder Schicht noch Abwesenheit noch Stempelung hat, gilt automatisch als frei – es wird nur nachgefragt,
-- wenn im eigenen Studio an dem Tag niemand eingestempelt hat. (Mehrfach ausführbar.)
-- =============================================================================

create or replace function public.absence_candidates(p_day date)
returns table (user_id uuid, first_name text, last_name text)
language sql stable security definer set search_path = '' as $$
  select u.id, u.first_name, u.last_name
  from public.users u
  left join public.employment_details e on e.user_id = u.id
  where u.is_active and u.role <> 'admin'
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
