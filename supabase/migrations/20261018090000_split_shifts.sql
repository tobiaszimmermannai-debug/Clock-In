-- =============================================================================
-- Clock-In · Split-Schichten: früher gehen (krank / wenig los), Schule/Prüfung + Schicht, Splitschicht
-- =============================================================================
-- * Gehen mehr als 30 Min. vor Schichtende (rule_settings.early_leave_minutes): das Handy fragt nach dem Grund
--   („wenig los / weniger Trainings“ oder „krank“), Tobias/Dominik entscheiden per Telegram:
--     krank        → ab dem Gehen „Krank statt Schicht“ (wie Krank ab Uhrzeit, Gutschrift für den Rest)
--     wenig los OK → zählt bis Schichtende
--     abgelehnt    → nur die gearbeitete Zeit zählt (Minusstunden)
-- * Schule/Nachprüfung + Schicht: Schul-Eintrag mit Uhrzeit (credit_by_time) zählt mit seiner Dauer statt
--   pauschal 7 Std.; Urlaub/Krank am selben Tag werden zusätzlich angerechnet.
-- * Splitschicht (zwei Zeiten im selben Studio) = zwei normale Schichten, je ein- und auschecken.
-- * Gesetzliche Pausen (§ 4 ArbZG) über den ganzen Tag: mehr als 6 Std. → 30 Min., mehr als 9 Std. → 45 Min.;
--   gestempelte Pausen und Lücken zwischen den Teilen zählen mit, Lücken aber erst ab 15 Min. am Stück.
-- (Mehrfach ausführbar.)
-- =============================================================================

alter table public.rule_settings
  add column if not exists early_leave_minutes integer not null default 30 check (early_leave_minutes between 5 and 240);

alter table public.time_logs
  add column if not exists early_reason text,
  add column if not exists early_status text,
  add column if not exists early_reviewed_by uuid references public.users (id) on delete set null,
  add column if not exists early_reviewed_at timestamptz;
alter table public.time_logs drop constraint if exists time_logs_early;
alter table public.time_logs add constraint time_logs_early
  check ((early_reason is null or early_reason in ('slow', 'sick'))
     and (early_status is null or early_status in ('pending', 'approved', 'sick', 'rejected')));

alter table public.shifts add column if not exists credit_by_time boolean not null default false;
alter table public.shifts drop constraint if exists shifts_credit_by_time;
alter table public.shifts add constraint shifts_credit_by_time check (not credit_by_time or shift_type::text = 'vocational_school');

-- Neuer optionaler Grund beim Gehen (alte App-Versionen rufen weiter mit 3 Werten auf)
drop function if exists public.stamp(text, public.time_event_type, text);
create or replace function public.stamp(p_token text, p_event public.time_event_type, p_phone_key text,
                                        p_early_reason text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_ctx   record;
  v_state record;
  v_seit  text;
  v_log   public.time_logs;
begin
  select * into v_ctx from private.stamp_context(p_token, p_phone_key);
  select * into v_state from private.stamp_state(v_ctx.o_user);
  v_seit := coalesce(' (seit ' || to_char(v_state.o_since at time zone 'Europe/Berlin', 'HH24:MI') || ')', '');

  if p_event = 'clock_in' and v_state.o_state = 'in' then
    raise exception 'Du bist bereits eingestempelt%.', v_seit;
  elsif p_event = 'clock_in' and v_state.o_state = 'break' then
    raise exception 'Du bist gerade in der Pause%. Bitte „Pause Ende“ wählen.', v_seit;
  elsif p_event = 'break_start' and v_state.o_state = 'out' then
    raise exception 'Du bist nicht eingestempelt. Bitte zuerst „Kommen“ wählen.';
  elsif p_event = 'break_start' and v_state.o_state = 'break' then
    raise exception 'Du bist bereits in der Pause%.', v_seit;
  elsif p_event = 'break_end' and v_state.o_state <> 'break' then
    raise exception 'Du bist gerade nicht in der Pause.';
  elsif p_event = 'clock_out' and v_state.o_state = 'out' then
    raise exception 'Du bist nicht eingestempelt.';
  end if;

  insert into public.time_logs (user_id, location_id, event_type, recorded_at, source, kiosk_device_id,
                                device_unverified, device_key_hash, early_reason)
  values (v_ctx.o_user, v_ctx.o_location, p_event, now(), 'kiosk', v_ctx.o_device,
          v_ctx.o_unverified, case when v_ctx.o_unverified then v_ctx.o_key_hash end,
          case when p_event = 'clock_out' and p_early_reason in ('slow', 'sick') then p_early_reason end)
  returning * into v_log;

  return jsonb_build_object(
    'id', v_log.id, 'event_type', v_log.event_type, 'recorded_at', v_log.recorded_at,
    'pending', v_log.approval_status = 'pending',
    'early', v_log.early_status = 'pending',
    'location', (select name from public.locations where id = v_ctx.o_location));
end $$;

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
    new.early_status := null;
    new.early_reason := null;
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

  -- Gehen deutlich vor Schichtende (Handy/Tablet) → Freigabe: krank, wenig los oder Minusstunden
  new.early_status := null;
  if new.event_type = 'clock_out' and new.shift_id is not null and new.source in ('kiosk', 'offline_sync') then
    select * into v_shift from public.shifts where id = new.shift_id;
    if v_shift.shift_type = 'work'
       and new.recorded_at < v_shift.ends_at - make_interval(mins => v_settings.early_leave_minutes) then
      new.early_status := 'pending';
    end if;
  end if;
  if new.early_status is null then
    new.early_reason := null;
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

create or replace function public.work_day_summary(p_user uuid, p_from date, p_to date)
returns table (
  day                       date,
  planned_minutes           integer,  -- geplante Arbeitsschichten
  worked_minutes            integer,  -- angerechnete Arbeitszeit (nach Kappung und Pausen)
  break_minutes             integer,  -- abgezogene Pausen
  credit_minutes            integer,  -- Gutschrift Krank / Schule / Urlaub (Frei: 0)
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

    -- Gutschrift: Schule pauschal (7 Std., für alle); sonst Azubis Tagesanteil (höchstens ein Tag),
    -- sonst Pauschale bzw. Schichtdauer. „Frei“ zählt nichts.
    select (array_agg(s.shift_type order by s.starts_at))[1],
           round(
             -- Schule: ganzer Tag pauschal 7 Std.; Teil-Tag (Schule/Prüfung + Schicht) mit der Dauer
             case when bool_or(s.shift_type::text = 'vocational_school' and not s.credit_by_time)
                  then v_settings.school_credit_minutes
                  else coalesce(sum(extract(epoch from s.ends_at - s.starts_at) / 60)
                                  filter (where s.shift_type::text = 'vocational_school' and s.credit_by_time), 0) end
             -- Urlaub/Krank: Azubis Tagesanteil (höchstens ein Tag), sonst Pauschale bzw. Schichtdauer
             + case when v_daily is null
                    then least(count(*) filter (where not s.from_shift and s.shift_type::text in ('vacation', 'sick')), 1)
                           * v_settings.absence_credit_minutes
                         + coalesce(sum(extract(epoch from s.ends_at - s.starts_at) / 60) filter (where s.from_shift), 0)
                    else least(coalesce(sum(s.credit_share) filter (where s.shift_type::text in ('vacation', 'sick')), 0), 1)
                           * v_daily end)::integer
      into absence, credit_minutes
    from public.shifts s
    where s.user_id = p_user and s.shift_type <> 'work' and s.starts_at >= v_from_ts and s.starts_at < v_to_ts;

    for ev in
      select t.event_type, t.recorded_at, t.shift_id, t.overtime_status, t.early_status
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
        -- früher gegangen, freigegeben („wenig los“) → zählt bis Schichtende
        if v_shift.id is not null and ev.early_status = 'approved' and ev.recorded_at < v_shift.ends_at then
          v_end := v_shift.ends_at;
        end if;
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
          -- Lücke zwischen zwei Einsätzen (Splitschicht, Herold + Schicht …) zählt als Pause,
          -- aber nur ab 15 Min. am Stück (Ruhepause nach § 4 ArbZG)
          if v_prev_end is not null and v_start > v_prev_end then
            v_minutes := floor(extract(epoch from v_start - v_prev_end) / 60)::integer;
            if v_minutes >= v_settings.min_break_minutes then
              v_gaps := v_gaps + v_minutes;
            end if;
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

-- Entscheidung (Telegram-Function mit Service-Role oder Admin in der App)
create or replace function public.decide_early_leave(p_log_id uuid, p_decision text, p_reviewer uuid default null)
returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_log   public.time_logs;
  v_shift public.shifts;
  v_by    uuid := coalesce(private.current_user_id(), p_reviewer);
begin
  if auth.uid() is not null and not private.is_admin() then
    raise exception 'Nur Admins entscheiden über früheres Gehen.' using errcode = '42501';
  end if;
  if p_decision not in ('approved', 'sick', 'rejected') then
    raise exception 'Unbekannte Entscheidung.';
  end if;
  select * into v_log from public.time_logs where id = p_log_id for update;
  if not found then
    raise exception 'Buchung nicht gefunden.';
  end if;
  if v_log.early_status is distinct from 'pending' then
    return 'already';
  end if;

  if p_decision = 'sick' then
    select * into v_shift from public.shifts where id = v_log.shift_id for update;
    if v_shift.id is not null and v_shift.shift_type = 'work' and v_log.recorded_at < v_shift.ends_at then
      update public.shifts set ends_at = v_log.recorded_at where id = v_shift.id;
      insert into public.shifts (user_id, location_id, shift_type, starts_at, ends_at, note, created_by, credit_share, from_shift)
      values (v_shift.user_id,
              case when v_shift.is_acquisition or coalesce(v_shift.is_herold, false) then null else v_shift.location_id end,
              'sick', v_log.recorded_at, v_shift.ends_at, 'Krank statt Schicht (früher gegangen)', v_by,
              round((extract(epoch from v_shift.ends_at - v_log.recorded_at)
                     / extract(epoch from v_shift.ends_at - v_shift.starts_at))::numeric, 3), true);
    end if;
  end if;

  update public.time_logs
     set early_status = p_decision, early_reviewed_by = v_by, early_reviewed_at = now()
   where id = p_log_id;
  return p_decision;
end $$;
revoke execute on function public.decide_early_leave(uuid, text, uuid) from public, anon;
grant execute on function public.decide_early_leave(uuid, text, uuid) to authenticated, service_role;

revoke execute on function public.stamp(text, public.time_event_type, text, text) from public, anon;
grant execute on function public.stamp(text, public.time_event_type, text, text) to authenticated;
revoke execute on all functions in schema private from public;
grant execute on all functions in schema private to authenticated, service_role;
