-- =============================================================================
-- Clock-In · Krank höchstens 6,5 Std. am Tag · Sonntag ohne Planung und ohne Telegram
-- =============================================================================
-- * Krank und „Schicht + krank“: je Tag zählen Arbeitszeit + Krank-Gutschrift zusammen höchstens
--   6,5 Std. (rule_settings.sick_max_minutes). Gearbeitete Zeit wird nie gekürzt.
-- * Sonntag: keine 18-Uhr-Abfrage („Was war los?“), keine Meldungen „nicht eingestempelt“ /
--   „Studio nicht besetzt“, keine einfachen Stempel-Meldungen. Entscheidungen (Freigaben) kommen weiter.
-- (Mehrfach ausführbar.)
-- =============================================================================

alter table public.rule_settings add column if not exists sick_max_minutes integer not null default 390;
alter table public.rule_settings drop constraint if exists rule_settings_sick_max_minutes_check;
alter table public.rule_settings add constraint rule_settings_sick_max_minutes_check check (sick_max_minutes between 0 and 720);

-- Stunden je Tag – Krank-Deckel
create or replace function public.work_day_summary(p_user uuid, p_from date, p_to date)
returns table (
  day                       date,
  planned_minutes           integer,  -- geplante Arbeitsschichten
  worked_minutes            integer,  -- angerechnete Arbeitszeit (nach Kappung und Pausen)
  break_minutes             integer,  -- abgezogene Pausen
  credit_minutes            integer,  -- Gutschrift Krank / Schule / Urlaub (Frei: 0; Krank höchstens 6,5 Std. inkl. Arbeit)
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
  v_school   integer;
  v_absent   integer;
  v_sick     boolean;
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
           -- Schule: ganzer Tag pauschal 7 Std.; Teil-Tag (Schule/Prüfung + Schicht) mit der Dauer
           round(case when bool_or(s.shift_type::text = 'vocational_school' and not s.credit_by_time)
                      then v_settings.school_credit_minutes
                      else coalesce(sum(extract(epoch from s.ends_at - s.starts_at) / 60)
                                      filter (where s.shift_type::text = 'vocational_school' and s.credit_by_time), 0) end)::integer,
           -- Urlaub/Krank: Azubis Tagesanteil (höchstens ein Tag), sonst Pauschale bzw. Schichtdauer
           round(case when v_daily is null
                      then least(count(*) filter (where not s.from_shift and s.shift_type::text in ('vacation', 'sick')), 1)
                             * v_settings.absence_credit_minutes
                           + coalesce(sum(extract(epoch from s.ends_at - s.starts_at) / 60) filter (where s.from_shift), 0)
                      else least(coalesce(sum(s.credit_share) filter (where s.shift_type::text in ('vacation', 'sick')), 0), 1)
                             * v_daily end)::integer,
           coalesce(bool_or(s.shift_type::text = 'sick'), false)
      into absence, v_school, v_absent, v_sick
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

    -- Krank (auch „Schicht + krank“): Arbeitszeit + Krank-Gutschrift höchstens 6,5 Std. am Tag;
    -- tatsächlich Gearbeitetes wird nie gekürzt
    if v_sick then
      v_absent := least(v_absent, greatest(0, v_settings.sick_max_minutes - worked_minutes));
    end if;
    credit_minutes := v_school + v_absent;
    return next;
  end loop;
end $$;

-- 18-Uhr-Abfrage: Sonntag nie
create or replace function public.absence_candidates(p_day date)
returns table (user_id uuid, first_name text, last_name text)
language sql stable security definer set search_path = '' as $$
  select u.id, u.first_name, u.last_name
  from public.users u
  left join public.employment_details e on e.user_id = u.id
  where u.is_active and u.role <> 'admin'
    and extract(isodow from p_day) <> 7  -- Sonntag: niemand eingeplant, keine Nachfrage
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

-- Stündliche Aufgaben: 18-Uhr-Abfrage nicht am Sonntag
create or replace function private.hourly_jobs() returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_settings public.rule_settings;
  v_local    timestamp := now() at time zone 'Europe/Berlin';
  v_hour     integer := extract(hour from v_local);
begin
  select * into v_settings from public.rule_settings;
  if v_hour = v_settings.auto_checkout_hour then
    perform private.auto_checkout();
  end if;
  if v_hour = v_settings.absence_check_hour and extract(isodow from v_local) <> 7 then  -- Sonntag nie
    perform private.call_telegram(jsonb_build_object('type', 'absence_check', 'date', v_local::date));
  end if;
  if extract(isodow from v_local) = v_settings.weekly_report_dow and v_hour = v_settings.weekly_report_hour then
    perform private.call_telegram(jsonb_build_object(
      'type', 'weekly_report', 'from', date_trunc('week', v_local)::date, 'to', v_local::date));
  end if;
  if extract(day from v_local) = 1 and v_hour = v_settings.monthly_report_hour
     and coalesce(v_settings.monthly_report_email, '') <> '' then
    perform private.call_telegram(jsonb_build_object('type', 'monthly_report', 'month', date_trunc('month', v_local)::date));
  end if;
end $$;

-- Minuten-Prüfungen (Studio besetzt? / nicht eingestempelt): am Sonntag keine Meldungen
create or replace function private.minute_checks() returns void
language plpgsql security definer set search_path = '' as $$
begin
  if extract(isodow from now() at time zone 'Europe/Berlin') = 7 then
    return;
  end if;
  perform private.staffing_check();
  perform private.no_show_check();
end $$;

-- Stempel-Meldungen
create or replace function private.notify_time_log() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_url    text;
  v_secret text;
begin
  if current_setting('clockin.silent', true) = 'on' then
    return null;
  end if;
  -- Sonntag: nur Entscheidungen (Freigabe, Überstunden, früher gegangen), keine einfachen Meldungen
  if extract(isodow from new.recorded_at at time zone 'Europe/Berlin') = 7
     and new.approval_status <> 'pending'
     and new.overtime_status is distinct from 'pending'
     and new.early_status is distinct from 'pending' then
    return null;
  end if;
  select decrypted_secret into v_url    from vault.decrypted_secrets where name = 'edge_functions_url';
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'notify_secret';
  if v_url is null or v_secret is null then
    return null;  -- Telegram noch nicht eingerichtet
  end if;

  perform net.http_post(
    url     := v_url || '/telegram',
    body    := jsonb_build_object('type', 'time_log', 'id', new.id),
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-notify-secret', v_secret)
  );
  return null;
exception when others then
  raise warning 'Telegram-Benachrichtigung fehlgeschlagen: %', sqlerrm;
  return null;  -- Stempeln darf nie an Telegram scheitern
end $$;

revoke execute on all functions in schema private from public;
grant execute on all functions in schema private to authenticated, service_role;
