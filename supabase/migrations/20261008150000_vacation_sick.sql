-- =============================================================================
-- Clock-In · Urlaub, Krank, Schule
-- =============================================================================
-- * Urlaubsanspruch (Tage pro Jahr) im Arbeitsvertrag; Zähler je Person:
--   Anspruch, genommen (bis heute), geplant, übrig – für Admin, Studioleitung und die Person selbst
-- * Krank: Studioleitung/Admin tauscht eine geplante Schicht gegen eine Krankheitsschicht – ganz
--   oder ab Uhrzeit (davor Gearbeitetes bleibt Arbeitsschicht). Die Studioleitung darf das für
--   Schichten in ihrem Studio und für alle Schichten ihrer eigenen Leute (auch Aushilfe/Akquise woanders).
-- * Gutschrift:
--   - Azubis: je Urlaubs-, Krank- und Schultag Wochenstunden ÷ 5,25 (einstellbar in
--     rule_settings.absence_week_days); Krank ab Uhrzeit anteilig (Krank-Zeit ÷ Schichtlänge).
--   - Alle anderen: Dauer des Eintrags – Urlaub/Schule ganztags 6,5 Std., Krank statt Schicht
--     mit den Stunden der (restlichen) Schicht.
--   Gegen Missbrauch: keine Selbst-Krankmeldung durch Mitarbeiter; Krank-Einträge ohne geplante
--   Schicht anlegen oder verlängern nur Admin.
-- =============================================================================

alter table public.employment_details
  add column vacation_days_per_year numeric(4,1) check (vacation_days_per_year between 0 and 365);

alter table public.rule_settings
  add column absence_week_days numeric(3,2) not null default 5.25 check (absence_week_days between 1 and 7);

-- Anteil eines Abwesenheitstags für Azubis (1 = ganzer Tag; Krank ab Uhrzeit = Krank-Zeit ÷ Schichtlänge)
alter table public.shifts
  add column credit_share numeric(4,3) not null default 1 check (credit_share > 0 and credit_share <= 1);

-- Urlaubstage im Jahr: Anspruch, genommen (bis heute), noch geplant – ein Urlaubstag je Kalendertag
create function public.vacation_overview(p_year integer)
returns table (user_id uuid, allowance numeric, taken integer, planned integer)
language sql stable security definer set search_path = '' as $$
  select u.id, e.vacation_days_per_year,
         count(distinct s.shift_date) filter (where s.shift_date <= (now() at time zone 'Europe/Berlin')::date)::integer,
         count(distinct s.shift_date) filter (where s.shift_date > (now() at time zone 'Europe/Berlin')::date)::integer
  from public.users u
  left join public.employment_details e on e.user_id = u.id
  left join public.shifts s on s.user_id = u.id and s.shift_type = 'vacation'
        and s.shift_date >= make_date(p_year, 1, 1) and s.shift_date < make_date(p_year + 1, 1, 1)
  where u.is_active and (u.id = private.current_user_id() or private.manages_user(u.id))
  group by u.id, e.vacation_days_per_year
$$;

-- Krank-Einträge: anlegen/ändern nur Admin; Studioleitung nur über report_sick (Schicht tauschen)
drop policy shifts_insert on public.shifts;
drop policy shifts_update on public.shifts;
create policy shifts_insert on public.shifts for insert to authenticated
  with check (private.can_plan_shift(location_id, user_id, is_acquisition)
              and (shift_type <> 'sick' or private.is_admin()));
create policy shifts_update on public.shifts for update to authenticated
  using (private.can_plan_shift(location_id, user_id, is_acquisition) and (shift_type <> 'sick' or private.is_admin()))
  with check (private.can_plan_shift(location_id, user_id, is_acquisition) and (shift_type <> 'sick' or private.is_admin()));

-- Geplante Schicht gegen Krankheitsschicht tauschen: Leitung des Studios der Schicht, Leitung des
-- Heimatstudios der Person (auch die eigene Schicht) bzw. Admin.
-- p_from = krank ab; leer oder Schichtbeginn → ganze Schicht.
create function public.report_sick(p_shift_id uuid, p_from timestamptz default null) returns uuid
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
       set shift_type = 'sick', is_acquisition = false, location_id = v_loc, note = 'Krank statt Schicht', credit_share = 1
     where id = p_shift_id
    returning id into v_id;
  else
    update public.shifts set ends_at = v_from where id = p_shift_id;
    insert into public.shifts (user_id, location_id, shift_type, starts_at, ends_at, note, created_by, credit_share)
    values (v_shift.user_id, v_loc, 'sick', v_from, v_shift.ends_at, 'Krank statt Schicht', private.current_user_id(),
            round((extract(epoch from v_shift.ends_at - v_from) / extract(epoch from v_shift.ends_at - v_shift.starts_at))::numeric, 3))
    returning id into v_id;
  end if;
  return v_id;
end $$;

-- -----------------------------------------------------------------------------
-- Tagesauswertung: neue Gutschrift-Regel (sonst unverändert)
-- -----------------------------------------------------------------------------
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

    -- Gutschrift: Azubis Tagesanteil (höchstens ein Tag), sonst Dauer der Einträge
    select (array_agg(s.shift_type order by s.starts_at))[1],
           round(case when v_daily is null
                      then coalesce(sum(extract(epoch from s.ends_at - s.starts_at) / 60), 0)
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

revoke execute on function public.vacation_overview(integer) from public, anon;
revoke execute on function public.report_sick(uuid, timestamptz) from public, anon;
grant execute on function public.vacation_overview(integer) to authenticated;
grant execute on function public.report_sick(uuid, timestamptz) to authenticated;
