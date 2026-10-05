-- =============================================================================
-- Clock-In · Schritt 3: Regel-Engine
-- =============================================================================
-- Regeln (Werte in rule_settings, durch Admins änderbar)
--   * Zu früh eingestempelt   → Arbeitszeit zählt ab Schichtbeginn
--   * Bis 5 Min. zu spät      → gilt als pünktlich (zählt ab Schichtbeginn)
--   * Mehr als 5 Min. zu spät → echte Zeit zählt, Verspätung wird ausgewiesen
--   * Nach Schichtende (> 5 Min.) → Überstunden nur nach Freigabe (Tobias/Dominik, Telegram)
--   * Kein Ausstempeln        → Auto-Checkout zur geplanten Endzeit (abends)
--   * Pausen nach § 4 ArbZG   → jede Pause zählt mind. 15 Min.; > 6 Std. Arbeit: 30 Min.,
--                               > 9 Std.: 45 Min.; Fehlendes wird abgezogen
--   * Einstempeln ohne Schicht → Aushilfsschicht wird automatisch im Dienstplan eingetragen
--   * Ohne Schicht & ohne Stempelung → 18 Uhr Telegram-Frage: Krank / IST / Urlaub (je 6,5 Std.) / Frei
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Einstellungen (eine Zeile)
-- -----------------------------------------------------------------------------
create table public.rule_settings (
  id                         boolean primary key default true check (id),
  late_tolerance_minutes     integer not null default 5   check (late_tolerance_minutes between 0 and 60),
  overtime_threshold_minutes integer not null default 5   check (overtime_threshold_minutes between 0 and 120),
  min_break_minutes          integer not null default 15  check (min_break_minutes between 0 and 60),
  absence_credit_minutes     integer not null default 390 check (absence_credit_minutes between 0 and 720),  -- Krank/IST/Urlaub
  help_shift_minutes         integer not null default 390 check (help_shift_minutes between 60 and 720),     -- Länge Aushilfsschicht
  absence_check_hour         integer not null default 18  check (absence_check_hour between 0 and 23),
  auto_checkout_hour         integer not null default 23  check (auto_checkout_hour between 0 and 23),
  updated_at                 timestamptz not null default now()
);
insert into public.rule_settings default values;

create trigger set_updated_at before update on public.rule_settings
  for each row execute function private.set_updated_at();
create trigger audit after update on public.rule_settings
  for each row execute function private.audit_changes();

alter table public.rule_settings enable row level security;
create policy rule_settings_select on public.rule_settings for select to authenticated
  using ((select private.is_staff()) or (select private.current_kiosk_id()) is not null);
create policy rule_settings_update on public.rule_settings for update to authenticated
  using ((select private.is_admin())) with check ((select private.is_admin()));
revoke all on public.rule_settings from anon;
revoke truncate on public.rule_settings from authenticated;

-- -----------------------------------------------------------------------------
-- Anpassungen bestehender Tabellen
-- -----------------------------------------------------------------------------
-- Gutschrift gilt einheitlich über rule_settings; berechnet wird live (work_day_summary)
alter table public.employment_details drop column school_day_credit_minutes;
alter table public.time_logs drop column effective_at;

-- Überstunden-Freigabe am Ausstempeln
alter table public.time_logs
  add column overtime_status      text check (overtime_status in ('pending', 'approved', 'rejected')),
  add column overtime_reviewed_by uuid references public.users (id) on delete set null,
  add column overtime_reviewed_at timestamptz;
create index time_logs_overtime_pending_idx on public.time_logs (received_at) where overtime_status = 'pending';

-- -----------------------------------------------------------------------------
-- Hilfsfunktionen
-- -----------------------------------------------------------------------------
-- Pflichtpause (§ 4 ArbZG) für eine Anwesenheit in Minuten. Abzug höchstens so weit,
-- dass nicht unter 6 bzw. 9 Std. gekürzt wird (z. B. 6:10 Std. ohne Pause → 6:00 Std.).
create function private.required_break(p_presence integer) returns integer
language sql immutable set search_path = '' as $$
  select case
    when p_presence <= 360 then 0
    when p_presence <= 390 then p_presence - 360
    when p_presence <= 570 then 30
    when p_presence <= 585 then p_presence - 540
    else 45
  end
$$;

-- Beginn eines Kalendertags in Berlin als Zeitpunkt
create function private.berlin_day_start(p_day date) returns timestamptz
language sql immutable set search_path = '' as $$
  select p_day::timestamp at time zone 'Europe/Berlin'
$$;

-- Aufruf der Edge Function "telegram" (asynchron, darf nie Fehler werfen)
create function private.call_telegram(p_body jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_url    text;
  v_secret text;
begin
  select decrypted_secret into v_url    from vault.decrypted_secrets where name = 'edge_functions_url';
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'notify_secret';
  if v_url is null or v_secret is null then
    return;
  end if;
  perform net.http_post(
    url     := v_url || '/telegram',
    body    := p_body,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-notify-secret', v_secret)
  );
exception when others then
  raise warning 'Telegram-Aufruf fehlgeschlagen: %', sqlerrm;
end $$;

-- -----------------------------------------------------------------------------
-- Buchung → Schicht zuordnen, Aushilfsschicht anlegen, Überstunden markieren
-- -----------------------------------------------------------------------------
create function private.time_logs_assign_shift() returns trigger
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
    order by abs(extract(epoch from starts_at - new.recorded_at))
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

-- Überstunden-Entscheidung protokollieren
create function private.time_logs_overtime_review() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.overtime_status is distinct from old.overtime_status then
    new.overtime_reviewed_by := coalesce(private.current_user_id(), new.overtime_reviewed_by);
    new.overtime_reviewed_at := now();
  end if;
  return new;
end $$;

create trigger assign_shift before insert on public.time_logs
  for each row execute function private.time_logs_assign_shift();
create trigger overtime_review before update on public.time_logs
  for each row execute function private.time_logs_overtime_review();

-- -----------------------------------------------------------------------------
-- Tagesauswertung (Soll/Ist-Basis für Handy-Portal und Wochenbericht)
-- -----------------------------------------------------------------------------
create function public.work_day_summary(p_user uuid, p_from date, p_to date)
returns table (
  day                       date,
  planned_minutes           integer,  -- geplante Arbeitsschichten
  worked_minutes            integer,  -- angerechnete Arbeitszeit (nach Kappung und Pausen)
  break_minutes             integer,  -- abgezogene Pausen
  credit_minutes            integer,  -- Gutschrift Krank / IST / Urlaub
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
begin
  -- eigene Daten, Leitung/Admin oder System (Service-Role)
  if auth.uid() is not null and p_user is distinct from private.current_user_id() and not private.manages_user(p_user) then
    raise exception 'Keine Berechtigung für diese Auswertung.';
  end if;
  if p_to - p_from > 92 then
    raise exception 'Zeitraum zu lang (max. 93 Tage).';
  end if;
  select * into v_settings from public.rule_settings;

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

    select s.shift_type into absence
    from public.shifts s
    where s.user_id = p_user and s.shift_type <> 'work' and s.starts_at >= v_from_ts and s.starts_at < v_to_ts
    limit 1;
    credit_minutes := case when absence is null then 0 else v_settings.absence_credit_minutes end;

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

-- -----------------------------------------------------------------------------
-- Abendliche Jobs
-- -----------------------------------------------------------------------------
-- Offene Einsätze nach Schichtende automatisch zur geplanten Endzeit ausstempeln
create function private.auto_checkout() returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_open  record;
  v_count integer := 0;
begin
  for v_open in
    select distinct on (t.user_id) t.user_id, t.event_type, t.recorded_at, t.location_id, t.shift_id, s.ends_at
    from public.time_logs t
    left join public.shifts s on s.id = t.shift_id
    where t.approval_status = 'approved' and t.recorded_at > now() - interval '20 hours'
    order by t.user_id, t.recorded_at desc
  loop
    continue when v_open.event_type = 'clock_out' or v_open.ends_at is null or v_open.ends_at > now();
    insert into public.time_logs (user_id, location_id, event_type, recorded_at, source, shift_id, note)
    values (v_open.user_id, v_open.location_id, 'clock_out', greatest(v_open.ends_at, v_open.recorded_at),
            'auto_checkout', v_open.shift_id, 'Automatisch zur geplanten Endzeit ausgestempelt');
    v_count := v_count + 1;
  end loop;
  return v_count;
end $$;

-- Wer hatte heute weder Schicht noch Abwesenheit noch Stempelung – obwohl die Woche
-- noch nicht voll verplant ist? (Regelmäßige freie Tage lösen so keine Frage aus.)
create function public.absence_candidates(p_day date)
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
  order by u.last_name, u.first_name
$$;

-- Antwort aus Telegram: Abwesenheit als Eintrag im Dienstplan (08:00 + Gutschrift)
create function public.record_absence(p_user uuid, p_day date, p_type public.shift_type, p_decided_by uuid)
returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  v_minutes integer;
  v_name    text;
begin
  if p_type = 'work' then
    raise exception 'Nur Krank, IST oder Urlaub.';
  end if;
  if exists (
    select 1 from public.shifts
    where user_id = p_user and starts_at >= private.berlin_day_start(p_day) and starts_at < private.berlin_day_start(p_day + 1)
  ) then
    return false;  -- bereits erfasst (z. B. vom anderen Admin)
  end if;
  select absence_credit_minutes into v_minutes from public.rule_settings;
  select first_name into v_name from public.users where id = p_decided_by;
  insert into public.shifts (user_id, location_id, shift_type, starts_at, ends_at, note, created_by)
  values (p_user, null, p_type, private.berlin_day_start(p_day) + interval '8 hours',
          private.berlin_day_start(p_day) + interval '8 hours' + make_interval(mins => v_minutes),
          'Per Telegram eingetragen' || coalesce(' von ' || v_name, ''), p_decided_by);
  return true;
end $$;

-- Stündlich aufgerufen; handelt zur eingestellten Berliner Uhrzeit (sommer-/winterzeitfest)
create function private.hourly_jobs() returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_settings public.rule_settings;
  v_hour     integer := extract(hour from now() at time zone 'Europe/Berlin');
begin
  select * into v_settings from public.rule_settings;
  if v_hour = v_settings.auto_checkout_hour then
    perform private.auto_checkout();
  end if;
  if v_hour = v_settings.absence_check_hour then
    perform private.call_telegram(jsonb_build_object(
      'type', 'absence_check', 'date', (now() at time zone 'Europe/Berlin')::date));
  end if;
end $$;

-- Nur für System (Telegram-Function mit Service-Role) bzw. Angemeldete
revoke execute on function public.absence_candidates(date) from public, anon, authenticated;
revoke execute on function public.record_absence(uuid, date, public.shift_type, uuid) from public, anon, authenticated;
grant execute on function public.absence_candidates(date) to service_role;
grant execute on function public.record_absence(uuid, date, public.shift_type, uuid) to service_role;
revoke execute on function public.work_day_summary(uuid, date, date) from public, anon;
grant execute on function public.work_day_summary(uuid, date, date) to authenticated, service_role;

revoke execute on all functions in schema private from public;
grant execute on all functions in schema private to authenticated, service_role;

-- Zeitplan (pg_cron): stündlich zur vollen Stunde
do $$
begin
  create extension if not exists pg_cron;
exception when others then
  raise notice 'pg_cron bitte unter Database → Extensions aktivieren: %', sqlerrm;
end $$;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    execute $job$select cron.schedule('clockin-hourly', '0 * * * *', 'select private.hourly_jobs()')$job$;
  end if;
end $$;
