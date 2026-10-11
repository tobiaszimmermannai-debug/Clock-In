-- =============================================================================
-- Clock-In · Schichttyp „Herold + Schicht“
-- =============================================================================
-- Zwei Teile an einem Tag: erst Herold im Studio Krailling (dort ein- und auschecken), danach die Schicht
-- im eigenen Studio (dort noch einmal ein- und auschecken). Beide Teile sind normale Arbeitsschichten;
-- der Krailling-Teil ist als Herold markiert. Studioleitung trägt beides für ihre Leute ein.
-- * Herold zählt – wie Akquise – nicht als Besetzung des Studios Krailling.
-- * Einstempeln wird bevorzugt der Schicht im selben Studio zugeordnet (auch bei Verspätung).
-- * Krank statt Herold: Eintrag beim Heimatstudio.
-- (Mehrfach ausführbar.)
-- =============================================================================

alter table public.shifts add column if not exists is_herold boolean not null default false;
alter table public.shifts drop constraint if exists shifts_herold_work;
alter table public.shifts add constraint shifts_herold_work
  check (not is_herold or (shift_type = 'work' and not is_acquisition));

-- Einstempeln → passende Schicht: zuerst im selben Studio, dann die mit dem nächsten Beginn
create or replace function private.time_logs_assign_shift() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_settings public.rule_settings;
  v_shift    public.shifts;
  v_clock_in public.time_logs;
begin
  select * into v_settings from public.rule_settings;

  if new.event_type = 'clock_in' then
    -- passende Arbeitsschicht: Beginn bis 3 Std. später als jetzt, noch nicht vorbei
    select * into v_shift from public.shifts
    where user_id = new.user_id and shift_type = 'work'
      and new.recorded_at >= starts_at - interval '3 hours' and new.recorded_at < ends_at
    order by (location_id is not distinct from new.location_id) desc,
             abs(extract(epoch from starts_at - new.recorded_at))
    limit 1;

    -- keine Schicht → Aushilfsschicht im Dienstplan eintragen (nur für gültige Buchungen)
    if v_shift.id is null and new.approval_status = 'approved' then
      begin
        insert into public.shifts (user_id, location_id, shift_type, starts_at, ends_at, note)
        values (new.user_id, new.location_id, 'work', new.recorded_at,
                new.recorded_at + make_interval(mins => v_settings.help_shift_minutes),
                'Aushilfsschicht (automatisch eingetragen)')
        returning * into v_shift;
      exception when exclusion_violation then
        v_shift := null;  -- überschneidet sich mit anderer Schicht → ohne Schicht buchen
      end;
    end if;
    new.shift_id := coalesce(new.shift_id, v_shift.id);
    return new;
  end if;

  -- Pause/Gehen gehören zur Schicht des letzten Einstempelns
  if new.shift_id is null then
    select * into v_clock_in from public.time_logs
    where user_id = new.user_id and event_type = 'clock_in' and approval_status <> 'rejected'
      and recorded_at <= new.recorded_at and recorded_at > new.recorded_at - interval '16 hours'
    order by recorded_at desc
    limit 1;
    new.shift_id := v_clock_in.shift_id;
  end if;

  -- Gehen deutlich nach Schichtende → Überstunden brauchen Freigabe
  if new.event_type = 'clock_out' and new.shift_id is not null and new.source <> 'auto_checkout' then
    select * into v_shift from public.shifts where id = new.shift_id;
    if new.recorded_at > v_shift.ends_at + make_interval(mins => v_settings.overtime_threshold_minutes) then
      new.overtime_status := case when new.source = 'manual' and private.is_admin() then 'approved' else 'pending' end;
    else
      new.overtime_status := null;
    end if;
  end if;
  return new;
end $$;

-- Erstes Einstempeln des Tages im Studio – Akquise- und Herold-Stempelungen zählen nicht
create or replace function public.is_first_checkin(p_log_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.time_logs me
    where me.id = p_log_id and me.event_type = 'clock_in' and me.approval_status = 'approved'
      and not exists (select 1 from public.shifts a where a.id = me.shift_id and (a.is_acquisition or a.is_herold))
      and not exists (
        select 1 from public.time_logs t
        where t.location_id = me.location_id and t.event_type = 'clock_in' and t.approval_status = 'approved'
          and t.id <> me.id
          and t.recorded_at >= private.berlin_day_start((me.recorded_at at time zone 'Europe/Berlin')::date)
          and t.recorded_at <= me.recorded_at
          and not exists (select 1 from public.shifts a where a.id = t.shift_id and (a.is_acquisition or a.is_herold))
      )
  )
$$;

-- Studio noch nicht besetzt? Nur Trainer-Schichten zählen, Akquise und Herold nicht
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
    where s.shift_type = 'work' and not s.is_acquisition and not s.is_herold
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
        and not exists (select 1 from public.shifts a where a.id = t.shift_id and (a.is_acquisition or a.is_herold)));

    insert into public.staffing_alerts (location_id, day) values (v_plan.location_id, v_today)
    on conflict do nothing;
    continue when not found;  -- heute schon gewarnt

    select jsonb_agg(u.first_name || ' ' || u.last_name order by u.first_name) into v_names
    from public.shifts s join public.users u on u.id = s.user_id
    where s.location_id = v_plan.location_id and s.shift_type = 'work' and not s.is_acquisition and not s.is_herold
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

-- Krank statt Schicht: Herold-Markierung entfällt, Eintrag (wie bei Akquise) beim Heimatstudio
create or replace function public.report_sick(p_shift_id uuid, p_from timestamptz default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_shift public.shifts;
  v_from  timestamptz;
  v_loc   uuid;
  v_id    uuid;
begin
  select * into v_shift from public.shifts where id = p_shift_id for update;
  if not found or v_shift.shift_type <> 'work' then
    raise exception 'Nur geplante Schichten können gegen Krank getauscht werden.';
  end if;
  if not (private.can_plan_shift(v_shift.location_id, v_shift.user_id, v_shift.is_acquisition)
          or private.manages_user(v_shift.user_id)) then
    raise exception 'Dafür fehlt die Berechtigung.' using errcode = '42501';
  end if;
  v_from := greatest(coalesce(p_from, v_shift.starts_at), v_shift.starts_at);
  if v_from >= v_shift.ends_at then
    raise exception '„Krank ab“ muss vor dem Schichtende liegen.';
  end if;
  -- Krank-Eintrag beim Studio der Schicht; Akquise, Herold oder fremdes Studio → beim Heimatstudio
  v_loc := case when v_shift.is_acquisition or v_shift.is_herold or not private.manages_location(v_shift.location_id)
                then null else v_shift.location_id end;

  if v_from = v_shift.starts_at then
    update public.shifts
       set shift_type = 'sick', is_acquisition = false, is_herold = false, location_id = v_loc,
           note = 'Krank statt Schicht', credit_share = 1, from_shift = true
     where id = p_shift_id
    returning id into v_id;
  else
    update public.shifts set ends_at = v_from where id = p_shift_id;
    insert into public.shifts (user_id, location_id, shift_type, starts_at, ends_at, note, created_by, credit_share, from_shift)
    values (v_shift.user_id, v_loc, 'sick', v_from, v_shift.ends_at, 'Krank statt Schicht', private.current_user_id(),
            round((extract(epoch from v_shift.ends_at - v_from) / extract(epoch from v_shift.ends_at - v_shift.starts_at))::numeric, 3), true)
    returning id into v_id;
  end if;
  return v_id;
end $$;

revoke execute on all functions in schema private from public;
grant execute on all functions in schema private to authenticated, service_role;
