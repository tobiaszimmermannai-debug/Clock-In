-- =============================================================================
-- Clock-In · Akquise-Schichten
-- =============================================================================
-- * Schalter „Akquise“ beim Planen: normale Arbeitsschicht (Stempeln, Stunden, Pausen wie
--   immer), das Studio zeigt, wo die Akquise stattfindet.
-- * Studioleitung plant normale Schichten nur im eigenen Studio. Akquise-Schichten darf sie
--   für ihre eigenen Leute auch in anderen Studios planen (z. B. Moosach → Krailling).
-- * Akquise zählt nicht als „Studio besetzt“ (betreut keine Trainings).
-- =============================================================================

alter table public.shifts
  add column is_acquisition boolean not null default false,
  add constraint shifts_acquisition_work check (not is_acquisition or shift_type = 'work');

-- Darf planen? Wie bisher – zusätzlich: Akquise für eigene Leute in jedem Studio
create function private.can_plan_shift(p_location_id uuid, p_user_id uuid, p_acquisition boolean) returns boolean
language sql stable security definer set search_path = '' as $$
  select private.can_plan_shift(p_location_id, p_user_id)
      or (p_acquisition and p_location_id is not null and private.manages_user(p_user_id))
$$;

drop policy shifts_insert on public.shifts;
drop policy shifts_update on public.shifts;
drop policy shifts_delete on public.shifts;
create policy shifts_insert on public.shifts for insert to authenticated
  with check (private.can_plan_shift(location_id, user_id, is_acquisition));
create policy shifts_update on public.shifts for update to authenticated
  using (private.can_plan_shift(location_id, user_id, is_acquisition))
  with check (private.can_plan_shift(location_id, user_id, is_acquisition));
create policy shifts_delete on public.shifts for delete to authenticated
  using (private.can_plan_shift(location_id, user_id, is_acquisition));

-- Schichttausch-Freigaben: Studioleitung, die die Schicht planen darf
create or replace function private.manages_shift(p_shift_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.shifts s
    where s.id = p_shift_id and private.can_plan_shift(s.location_id, s.user_id, s.is_acquisition)
  )
$$;

-- Erstes Einstempeln des Tages im Studio – Akquise-Stempelungen zählen nicht
create or replace function public.is_first_checkin(p_log_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.time_logs me
    where me.id = p_log_id and me.event_type = 'clock_in' and me.approval_status = 'approved'
      and not exists (select 1 from public.shifts a where a.id = me.shift_id and a.is_acquisition)
      and not exists (
        select 1 from public.time_logs t
        where t.location_id = me.location_id and t.event_type = 'clock_in' and t.approval_status = 'approved'
          and t.id <> me.id
          and t.recorded_at >= private.berlin_day_start((me.recorded_at at time zone 'Europe/Berlin')::date)
          and t.recorded_at <= me.recorded_at
          and not exists (select 1 from public.shifts a where a.id = t.shift_id and a.is_acquisition)
      )
  )
$$;

-- Studio noch nicht besetzt? Nur Trainer-Schichten zählen, Akquise nicht
create or replace function private.staffing_check() returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_settings public.rule_settings;
  v_today    date := (now() at time zone 'Europe/Berlin')::date;
  v_plan     record;
  v_names    jsonb;
  v_count    integer := 0;
begin
  select * into v_settings from public.rule_settings;

  for v_plan in
    select s.location_id, l.name, min(s.starts_at) as first_start
    from public.shifts s
    join public.locations l on l.id = s.location_id and l.is_active
    where s.shift_type = 'work' and not s.is_acquisition
      and s.starts_at >= private.berlin_day_start(v_today)
      and s.starts_at < private.berlin_day_start(v_today + 1)
    group by s.location_id, l.name
  loop
    -- erst nach Toleranz + 5 Min. warnen, nicht mehr nach 3 Std.
    continue when now() < v_plan.first_start + make_interval(mins => v_settings.late_tolerance_minutes + 5)
               or now() > v_plan.first_start + interval '3 hours';
    continue when exists (
      select 1 from public.time_logs t
      where t.location_id = v_plan.location_id and t.event_type = 'clock_in' and t.approval_status = 'approved'
        and t.recorded_at >= private.berlin_day_start(v_today)
        and not exists (select 1 from public.shifts a where a.id = t.shift_id and a.is_acquisition));

    insert into public.staffing_alerts (location_id, day) values (v_plan.location_id, v_today)
    on conflict do nothing;
    continue when not found;  -- heute schon gewarnt

    select jsonb_agg(u.first_name || ' ' || u.last_name order by u.first_name) into v_names
    from public.shifts s join public.users u on u.id = s.user_id
    where s.location_id = v_plan.location_id and s.shift_type = 'work' and not s.is_acquisition
      and s.starts_at = v_plan.first_start;

    perform private.call_telegram(jsonb_build_object(
      'type', 'studio_unstaffed',
      'location', v_plan.name,
      'start', to_char(v_plan.first_start at time zone 'Europe/Berlin', 'HH24:MI'),
      'names', coalesce(v_names, '[]'::jsonb)));
    v_count := v_count + 1;
  end loop;
  return v_count;
end $$;

revoke execute on all functions in schema private from public;
grant execute on all functions in schema private to authenticated, service_role;
