-- =============================================================================
-- Clock-In · Ausstempeln vergessen = nur mit Freigabe
-- =============================================================================
-- Wer nicht ausstempelt, wird weiterhin automatisch zur geplanten Endzeit ausgestempelt –
-- die Zeit zählt aber erst, wenn Tobias oder Dominik per Telegram zustimmen.
-- Wer früher geht, ohne zu stempeln, bekommt so nicht automatisch bis Schichtende bezahlt.
-- Der Wochenbericht zeigt, wie oft jemand nicht ausgestempelt hat.
-- =============================================================================

create or replace function private.auto_checkout() returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_open  record;
  v_count integer := 0;
begin
  -- letzte nicht abgelehnte Buchung je Person (offene Freigaben zählen mit → keine Doppel-Einträge)
  for v_open in
    select distinct on (t.user_id) t.user_id, t.event_type, t.recorded_at, t.location_id, t.shift_id, s.ends_at
    from public.time_logs t
    left join public.shifts s on s.id = t.shift_id
    where t.approval_status <> 'rejected' and t.recorded_at > now() - interval '20 hours'
    order by t.user_id, t.recorded_at desc
  loop
    continue when v_open.event_type = 'clock_out' or v_open.ends_at is null or v_open.ends_at > now();
    insert into public.time_logs (user_id, location_id, event_type, recorded_at, source, shift_id, note, approval_status)
    values (v_open.user_id, v_open.location_id, 'clock_out', greatest(v_open.ends_at, v_open.recorded_at),
            'auto_checkout', v_open.shift_id, 'Ausstempeln vergessen – automatisch zur geplanten Endzeit eingetragen',
            'pending');
    v_count := v_count + 1;
  end loop;
  return v_count;
end $$;

-- Wochenbericht: zusätzlich Anzahl „nicht ausgestempelt“
drop function public.weekly_report(date, date);
create function public.weekly_report(p_from date, p_to date)
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
  where u.is_active and u.role <> 'admin'
  group by u.id, u.first_name, u.last_name, u.role, e.weekly_target_minutes
  order by u.last_name, u.first_name
$$;
revoke execute on function public.weekly_report(date, date) from public, anon, authenticated;
grant execute on function public.weekly_report(date, date) to service_role;

revoke execute on all functions in schema private from public;
grant execute on all functions in schema private to authenticated, service_role;
