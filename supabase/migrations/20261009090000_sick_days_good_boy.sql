-- =============================================================================
-- Clock-In · Krank-Tage durch die Studioleitung, „Good Boy“ am Tablet, „Noch nicht da“-Meldung
-- =============================================================================
-- * Studioleitung darf ihre Leute auch für ganze Tage ohne geplante Schicht krank eintragen.
--   Gutschrift dafür pauschal (6,5 Std. bzw. Azubis Wochenstunden ÷ 5,25) – unabhängig von den
--   eingetragenen Uhrzeiten, damit sich nichts „verlängern“ lässt.
-- * Krank statt Schicht (report_sick) wird markiert (from_shift) und zählt weiter mit der Schichtdauer;
--   setzen kann die Markierung nur report_sick bzw. ein Admin.
-- (Mehrfach ausführbar.)
-- * Tablet: beim Gehen spätestens zum Schichtende erscheint 3 Sekunden das „Good Boy“-Bild.
-- * Telegram: 5 Min. (Verspätungs-Toleranz) nach Schichtbeginn noch nicht eingestempelt → Meldung,
--   je Schicht einmal. Prüfung läuft jede Minute (Job clockin-staffing).
-- =============================================================================

alter table public.shifts add column if not exists from_shift boolean not null default false;
update public.shifts set from_shift = true where shift_type = 'sick' and note = 'Krank statt Schicht';

-- Krank-Einträge anlegen: Studioleitung und Admin; ändern weiterhin nur Admin (Studioleitung: löschen + neu)
drop policy if exists shifts_insert on public.shifts;
drop policy if exists shifts_update on public.shifts;
create policy shifts_insert on public.shifts for insert to authenticated
  with check (private.can_plan_shift(location_id, user_id, is_acquisition) and (not from_shift or private.is_admin()));
create policy shifts_update on public.shifts for update to authenticated
  using (private.can_plan_shift(location_id, user_id, is_acquisition) and (shift_type <> 'sick' or private.is_admin()))
  with check (private.can_plan_shift(location_id, user_id, is_acquisition) and (shift_type <> 'sick' or private.is_admin())
              and (not from_shift or private.is_admin()));

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
  -- Krank-Eintrag beim Studio der Schicht; Akquise oder fremdes Studio → beim Heimatstudio
  v_loc := case when v_shift.is_acquisition or not private.manages_location(v_shift.location_id)
                then null else v_shift.location_id end;

  if v_from = v_shift.starts_at then
    update public.shifts
       set shift_type = 'sick', is_acquisition = false, location_id = v_loc, note = 'Krank statt Schicht', credit_share = 1, from_shift = true
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

create or replace function public.work_day_summary(p_user uuid, p_from date, p_to date)
returns table (
  day                       date,
  planned_minutes           integer,  -- geplante Arbeitsschichten
  worked_minutes            integer,  -- angerechnete Arbeitszeit (nach Kappung und Pausen)
  break_minutes             integer,  -- abgezogene Pausen
  credit_minutes            integer,  -- Gutschrift Krank / Schule / Urlaub
  absence                   public.shift_type,
  late_minutes              integer,  -- Verspätung über der Toleranz
  overtime_pending_minutes  integer,
  overtime_approved_minutes integer,
  open_session              boolean   -- noch eingestempelt bzw. Ausstempeln fehlt
)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_settings public.rule_settings;
  v_day      date;
  v_from_ts  timestamptz;
  v_to_ts    timestamptz;
  ev         record;
  v_shift    public.shifts;
  v_in       timestamptz;
  v_break    timestamptz;
  v_breaks   integer;
  v_start    timestamptz;
  v_end      timestamptz;
  v_prev_end timestamptz;
  v_minutes  integer;
  v_presence integer;
  v_recorded integer;
  v_gaps     integer;
  v_extra    integer;
  v_started  uuid[];
  v_daily    numeric;
begin
  -- eigene Daten, Leitung/Admin oder System (Service-Role)
  if auth.uid() is not null and p_user is distinct from private.current_user_id() and not private.manages_user(p_user) then
    raise exception 'Keine Berechtigung für diese Auswertung.';
  end if;
  if p_to - p_from > 92 then
    raise exception 'Zeitraum zu lang (max. 93 Tage).';
  end if;
  select * into v_settings from public.rule_settings;
  -- Azubis: ein Abwesenheitstag = Wochenstunden ÷ 5,25; sonst bleibt v_daily leer (Dauer zählt)
  select e.weekly_target_minutes / v_settings.absence_week_days into v_daily
  from public.employment_details e join public.users u on u.id = e.user_id
  where e.user_id = p_user and u.role = 'trainee';

  for v_day in select generate_series(p_from, p_to, interval '1 day')::date loop
    v_from_ts := private.berlin_day_start(v_day);
    v_to_ts   := private.berlin_day_start(v_day + 1);
    day := v_day;
    late_minutes := 0; overtime_pending_minutes := 0; overtime_approved_minutes := 0; open_session := false;
    v_presence := 0; v_recorded := 0; v_gaps := 0; v_prev_end := null;
    v_in := null; v_break := null; v_breaks := 0; v_started := '{}';

    select coalesce(sum(extract(epoch from s.ends_at - s.starts_at) / 60), 0)::integer into planned_minutes
    from public.shifts s
    where s.user_id = p_user and s.shift_type = 'work' and s.starts_at >= v_from_ts and s.starts_at < v_to_ts;

    -- Gutschrift: Azubis Tagesanteil (höchstens ein Tag), sonst Pauschale bzw. Schichtdauer
    select (array_agg(s.shift_type order by s.starts_at))[1],
           round(case when v_daily is null
                      -- ganzer Tag pauschal (höchstens einmal), Krank statt Schicht mit der Schichtdauer
                      then least(count(*) filter (where not s.from_shift), 1) * v_settings.absence_credit_minutes
                           + coalesce(sum(extract(epoch from s.ends_at - s.starts_at) / 60) filter (where s.from_shift), 0)
                      else least(coalesce(sum(s.credit_share), 0), 1) * v_daily end)::integer
      into absence, credit_minutes
    from public.shifts s
    where s.user_id = p_user and s.shift_type <> 'work' and s.starts_at >= v_from_ts and s.starts_at < v_to_ts;

    for ev in
      select t.event_type, t.recorded_at, t.shift_id, t.overtime_status
      from public.time_logs t
      where t.user_id = p_user and t.approval_status = 'approved'
        and t.recorded_at >= v_from_ts and t.recorded_at < v_to_ts
      order by t.recorded_at
    loop
      if ev.event_type = 'clock_in' then
        v_in := ev.recorded_at; v_break := null; v_breaks := 0;
        select * into v_shift from public.shifts where id = ev.shift_id;
      elsif v_in is null then
        continue;  -- Pause/Gehen ohne Kommen: ignorieren
      elsif ev.event_type = 'break_start' then
        v_break := ev.recorded_at;
      elsif ev.event_type = 'break_end' and v_break is not null then
        v_minutes := ceil(extract(epoch from ev.recorded_at - v_break) / 60)::integer;
        v_breaks := v_breaks + greatest(v_minutes, v_settings.min_break_minutes);
        v_break := null;
      elsif ev.event_type = 'clock_out' then
        if v_break is not null then  -- Gehen während der Pause: Pause endet mit Gehen
          v_minutes := ceil(extract(epoch from ev.recorded_at - v_break) / 60)::integer;
          v_breaks := v_breaks + greatest(v_minutes, v_settings.min_break_minutes);
        end if;

        -- Beginn (nur beim ersten Einsatz der Schicht): zu früh → Schichtbeginn;
        -- bis Toleranz zu spät → Schichtbeginn; sonst echte Zeit und Verspätung
        v_start := v_in;
        if v_shift.id is not null and not (v_shift.id = any (v_started)) then
          v_started := v_started || v_shift.id;
          if v_in <= v_shift.starts_at + make_interval(mins => v_settings.late_tolerance_minutes) then
            v_start := v_shift.starts_at;
          else
            late_minutes := late_minutes + floor(extract(epoch from v_in - v_shift.starts_at) / 60)::integer;
          end if;
        end if;

        -- Ende: nach Schichtende nur mit Freigabe
        v_end := ev.recorded_at;
        if v_shift.id is not null and ev.recorded_at > v_shift.ends_at then
          v_minutes := floor(extract(epoch from ev.recorded_at - v_shift.ends_at) / 60)::integer;
          if ev.overtime_status = 'approved' then
            overtime_approved_minutes := overtime_approved_minutes + v_minutes;
          else
            v_end := v_shift.ends_at;
            if ev.overtime_status = 'pending' then
              overtime_pending_minutes := overtime_pending_minutes + v_minutes;
            end if;
          end if;
        end if;

        if v_end > v_start then
          v_presence := v_presence + floor(extract(epoch from v_end - v_start) / 60)::integer;
          v_recorded := v_recorded + v_breaks;
          if v_prev_end is not null and v_start > v_prev_end then
            v_gaps := v_gaps + floor(extract(epoch from v_start - v_prev_end) / 60)::integer;
          end if;
          v_prev_end := v_end;
        end if;
        v_in := null; v_break := null; v_breaks := 0;
      end if;
    end loop;
    open_session := v_in is not null;

    -- Pausen: gestempelt (je mind. 15 Min.) + Lücken zwischen Einsätzen; Fehlendes zur Pflichtpause abziehen
    v_recorded := least(v_recorded, v_presence);
    v_extra := greatest(0, private.required_break(v_presence) - v_recorded - v_gaps);
    break_minutes  := v_recorded + v_extra;
    worked_minutes := greatest(0, v_presence - break_minutes);
    return next;
  end loop;
end $$;

create or replace function public.kiosk_ping(p_location_id uuid default null, p_since timestamptz default null)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_device public.kiosk_devices;
  v_net    cidr := private.client_network();
  v_loc    uuid;
  v_qr     public.kiosk_qr;
  v_recent jsonb;
  v_grace  integer;
begin
  select * into v_device from public.kiosk_devices where auth_user_id = auth.uid() and is_active;
  if not found then
    raise exception 'Dieses Konto ist kein aktives Tablet.';
  end if;
  v_loc := coalesce(v_device.location_id, p_location_id);
  if not exists (select 1 from public.locations where id = v_loc and is_active) then
    raise exception 'Bitte am Tablet ein Studio wählen.';
  end if;

  if v_net is not null then
    insert into public.kiosk_networks (device_id, network) values (v_device.id, v_net)
    on conflict (device_id, network) do update set last_seen_at = now()
      where public.kiosk_networks.last_seen_at < now() - interval '1 minute';
  end if;

  select * into v_qr from public.kiosk_qr where device_id = v_device.id;
  if not found or v_qr.issued_at < now() - interval '30 seconds' or v_qr.location_id <> v_loc then
    insert into public.kiosk_qr (device_id, token, prev_token, issued_at, location_id, last_seen_at)
    values (v_device.id, encode(extensions.gen_random_bytes(12), 'hex'), null, now(), v_loc, now())
    on conflict (device_id) do update
      set prev_token = public.kiosk_qr.token, token = excluded.token, issued_at = now(),
          location_id = excluded.location_id, last_seen_at = now()
    returning * into v_qr;
  elsif v_qr.last_seen_at < now() - interval '1 minute' then
    update public.kiosk_qr set last_seen_at = now() where device_id = v_device.id;
  end if;

  -- on_time: Gehen spätestens zum Schichtende (+ Überstunden-Schwelle) → Tablet zeigt „Good Boy“
  select overtime_threshold_minutes into v_grace from public.rule_settings;
  select coalesce(jsonb_agg(jsonb_build_object(
           'first_name', u.first_name, 'event_type', t.event_type, 'recorded_at', t.recorded_at,
           'on_time', t.event_type = 'clock_out' and s.id is not null
                      and t.recorded_at <= s.ends_at + make_interval(mins => coalesce(v_grace, 5)))
           order by t.received_at), '[]'::jsonb)
    into v_recent
  from public.time_logs t
  join public.users u on u.id = t.user_id
  left join public.shifts s on s.id = t.shift_id
  where t.kiosk_device_id = v_device.id
    and t.received_at > greatest(coalesce(p_since, now()), now() - interval '1 minute');

  return jsonb_build_object('token', v_qr.token, 'location_id', v_loc, 'now', now(), 'recent', v_recent);
end $$;

-- -----------------------------------------------------------------------------
-- Noch nicht da? (je Schicht eine Telegram-Meldung)
-- -----------------------------------------------------------------------------
create table if not exists public.no_show_alerts (
  shift_id uuid primary key references public.shifts (id) on delete cascade,
  sent_at  timestamptz not null default now()
);
alter table public.no_show_alerts enable row level security;  -- nur intern (keine Policies)

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
    join public.users u on u.id = s.user_id and u.is_active
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

-- Jede Minute: Studio besetzt? + Wer ist noch nicht da?
create or replace function private.minute_checks() returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform private.staffing_check();
  perform private.no_show_check();
end $$;

revoke execute on all functions in schema private from public;
grant execute on all functions in schema private to authenticated, service_role;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    execute $job$select cron.schedule('clockin-staffing', '* * * * *', 'select private.minute_checks()')$job$;
  end if;
end $$;
