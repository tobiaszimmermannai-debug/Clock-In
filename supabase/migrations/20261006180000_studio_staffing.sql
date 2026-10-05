-- =============================================================================
-- Clock-In · Studio besetzt? Morgendliche Telegram-Meldungen
-- =============================================================================
-- * Erstes Einstempeln des Tages je Studio → "🟢 Studio Nord ist besetzt"
-- * 10 Min. nach der ersten geplanten Schicht noch niemand da → "🔴 noch nicht besetzt"
-- * Je Admin abschaltbar (Bot-Befehl /kurz bzw. /alle steuert Einzelmeldungen)
-- =============================================================================

alter table public.telegram_links
  add column notify_studio_status boolean not null default true;

-- Bereits gesendete Warnungen (höchstens eine je Studio und Tag)
create table public.staffing_alerts (
  location_id uuid not null references public.locations (id) on delete cascade,
  day         date not null,
  sent_at     timestamptz not null default now(),
  primary key (location_id, day)
);
alter table public.staffing_alerts enable row level security;
create policy staffing_alerts_select on public.staffing_alerts for select to authenticated
  using ((select private.is_admin()));
revoke all on public.staffing_alerts from anon;
revoke insert, update, delete, truncate on public.staffing_alerts from authenticated;

-- Ist diese Buchung das erste Einstempeln des Tages im Studio? (für die Telegram-Function)
create function public.is_first_checkin(p_log_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.time_logs me
    where me.id = p_log_id and me.event_type = 'clock_in' and me.approval_status = 'approved'
      and not exists (
        select 1 from public.time_logs t
        where t.location_id = me.location_id and t.event_type = 'clock_in' and t.approval_status = 'approved'
          and t.id <> me.id
          and t.recorded_at >= private.berlin_day_start((me.recorded_at at time zone 'Europe/Berlin')::date)
          and t.recorded_at <= me.recorded_at
      )
  )
$$;
revoke execute on function public.is_first_checkin(uuid) from public, anon, authenticated;
grant execute on function public.is_first_checkin(uuid) to service_role;

-- Alle 5 Min.: Studios mit geplanter Schicht, aber ohne Einstempeln → Warnung (einmal pro Tag)
create function private.staffing_check() returns integer
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
    where s.shift_type = 'work'
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
        and t.recorded_at >= private.berlin_day_start(v_today));

    insert into public.staffing_alerts (location_id, day) values (v_plan.location_id, v_today)
    on conflict do nothing;
    continue when not found;  -- heute schon gewarnt

    select jsonb_agg(u.first_name || ' ' || u.last_name order by u.first_name) into v_names
    from public.shifts s join public.users u on u.id = s.user_id
    where s.location_id = v_plan.location_id and s.shift_type = 'work' and s.starts_at = v_plan.first_start;

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

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    execute $job$select cron.schedule('clockin-staffing', '*/5 * * * *', 'select private.staffing_check()')$job$;
  end if;
end $$;
