-- =============================================================================
-- Clock-In · Tausch mit Zustimmung, „wenig los“ = Minusstunden, sichereres Stempeln
-- =============================================================================
-- 1) Schichttausch: Die angefragte Person muss selbst zustimmen (swap_respond), erst dann geht der Antrag an die
--    Leitung (Telegram) und kann freigegeben werden. Offene alte Anträge gelten als zugestimmt.
-- 2) Früher gehen „wenig los“: keine Freigabe mehr – zählt immer als Minusstunden, die Admins bekommen nur eine Info.
--    „Krank“ bleibt mit Freigabe.
-- 3) Stempeln: zwei gleichzeitige Anfragen derselben Person laufen nacheinander (keine Doppelbuchung).
-- 4) Einstempeln ohne Schicht (anderes Handy, noch nicht freigegeben): Beim Freigeben wird die Aushilfsschicht
--    nachgetragen; „Ausstempeln vergessen“ greift auch ohne Schicht.
-- 5) Stündliche Aufgaben (Auto-Ausstempeln, 18-Uhr-Abfrage, Berichte): fällt ein Lauf aus, wird er bis 6 Std.
--    später nachgeholt – jede Aufgabe höchstens einmal pro Tag. (Mehrfach ausführbar.)
-- =============================================================================

-- ---------------- 1) Schichttausch ----------------
-- Spalte anlegen; beim ersten Mal gelten schon offene Anträge als zugestimmt (sonst könnten sie nie freigegeben werden)
do $$ begin
  if not exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'swap_requests' and column_name = 'target_accepted_at') then
    alter table public.swap_requests add column target_accepted_at timestamptz;
    update public.swap_requests set target_accepted_at = created_at where status = 'pending';
  end if;
end $$;

create or replace function private.swap_requests_validate() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_me     uuid := private.current_user_id();
  v_system boolean := auth.uid() is null;  -- Service-Role (Telegram-Button eines Admins)
  v_full   boolean;                         -- Admin/System: gibt für beide Studios frei
  v_own    boolean;
  v_other  boolean;
  v_req    public.shifts;
  v_tgt    public.shifts;
begin
  -- interne Folge-Updates (Auto-Storno aus swap_requests_apply) nicht erneut prüfen
  if pg_trigger_depth() > 1 then
    return new;
  end if;

  select * into v_req from public.shifts where id = new.requester_shift_id;
  if new.target_shift_id is not null then
    select * into v_tgt from public.shifts where id = new.target_shift_id;
  end if;

  if tg_op = 'INSERT' then
    new.status := 'pending';
    new.decided_by := null; new.decided_at := null; new.decision_note := null;
    new.approved_own_by := null; new.approved_other_by := null;
    new.target_accepted_at := null;  -- die Zielperson stimmt erst selbst zu (swap_respond)
    -- anderes Studio = Studio der Gegenschicht bzw. Heimatstudio der übernehmenden Person
    new.other_location_id := coalesce(
      v_tgt.location_id,
      (select home_location_id from public.users where id = new.target_user_id));
    new.is_cross_studio := new.other_location_id is not null
                           and new.other_location_id is distinct from v_req.location_id;
    if not new.is_cross_studio then
      new.other_location_id := null;
    end if;

    if v_req.user_id is distinct from new.requester_id then
      raise exception 'Schichttausch: Die angegebene Schicht gehört nicht dem Antragsteller.';
    end if;
    if v_req.shift_type <> 'work' or v_req.starts_at <= now() then
      raise exception 'Schichttausch: Nur zukünftige Arbeitsschichten können getauscht werden.';
    end if;
    if not exists (select 1 from public.users where id = new.target_user_id and is_active) then
      raise exception 'Schichttausch: Ziel-Mitarbeiter ist nicht aktiv.';
    end if;
    if new.target_shift_id is not null and (
         v_tgt.user_id is distinct from new.target_user_id
         or v_tgt.shift_type <> 'work' or v_tgt.starts_at <= now()) then
      raise exception 'Schichttausch: Ungültige Gegenschicht.';
    end if;
    return new;
  end if;

  -- UPDATE
  if (new.requester_id, new.requester_shift_id, new.target_user_id, new.target_shift_id, new.created_at,
      new.is_cross_studio, new.other_location_id)
     is distinct from
     (old.requester_id, old.requester_shift_id, old.target_user_id, old.target_shift_id, old.created_at,
      old.is_cross_studio, old.other_location_id) then
    raise exception 'Schichttausch: Antragsdaten sind unveränderlich.';
  end if;
  -- Zustimmung der Zielperson nur über swap_respond (nicht durch Antragsteller oder Leitung setzbar)
  if new.target_accepted_at is distinct from old.target_accepted_at
     and coalesce(current_setting('clockin.swap_respond', true), '') <> 'on' then
    raise exception 'Schichttausch: Zustimmen kann nur die angefragte Person selbst.';
  end if;
  if old.status <> 'pending' then
    raise exception 'Schichttausch: Antrag ist bereits abgeschlossen (%).', old.status;
  end if;

  case new.status
    when 'pending' then
      new.decided_by := null; new.decided_at := null;
      new.approved_own_by := old.approved_own_by; new.approved_other_by := old.approved_other_by;

    when 'cancelled' then
      if not v_system and v_me is distinct from old.requester_id and not private.is_admin() then
        raise exception 'Schichttausch: Nur der Antragsteller kann stornieren.';
      end if;

    else  -- approved / rejected
      -- Ablehnung durch die Zielperson selbst (swap_respond)
      if new.status = 'rejected' and current_setting('clockin.swap_respond', true) = 'on' then
        new.decided_by := v_me; new.decided_at := now();
        return new;
      end if;
      if new.status = 'approved' and old.target_accepted_at is null then
        raise exception 'Schichttausch: % hat noch nicht zugestimmt.',
          coalesce((select first_name from public.users where id = old.target_user_id), 'Die angefragte Person');
      end if;
      v_full := v_system or private.is_admin();
      v_own := v_full or private.manages_location(v_req.location_id);
      v_other := v_full or (old.is_cross_studio and private.manages_location(old.other_location_id));
      if not (v_own or v_other) then
        raise exception 'Schichttausch: Freigabe nur durch die beteiligte Studioleitung oder Admin.';
      end if;
      if not v_system and v_me = old.requester_id and not private.is_admin() then
        raise exception 'Schichttausch: Eigene Anträge können nicht selbst freigegeben werden.';
      end if;

      -- Freigabe pro Studio vermerken; studioübergreifend erst komplett, wenn beide zugestimmt haben
      if new.status = 'approved' then
        new.approved_own_by   := coalesce(old.approved_own_by, case when v_own then coalesce(v_me, new.decided_by) end);
        new.approved_other_by := coalesce(old.approved_other_by, case when v_other then coalesce(v_me, new.decided_by) end);
        if old.is_cross_studio and (new.approved_own_by is null or new.approved_other_by is null) then
          new.status := 'pending';
          new.decided_by := null;
          new.decided_at := null;
          return new;
        end if;
      end if;

      if new.status = 'approved' and (
           v_req.user_id <> old.requester_id or v_req.starts_at <= now()
           or (new.target_shift_id is not null
               and (v_tgt.user_id <> old.target_user_id or v_tgt.starts_at <= now()))) then
        raise exception 'Schichttausch: Schichten haben sich zwischenzeitlich geändert.';
      end if;
      new.decided_by := coalesce(v_me, new.decided_by);
      new.decided_at := now();
  end case;

  return new;
end $$;

-- Zielperson: zustimmen oder ablehnen
create or replace function public.swap_respond(p_id uuid, p_accept boolean) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_me  uuid := private.current_user_id();
  v_req public.swap_requests;
begin
  select * into v_req from public.swap_requests where id = p_id for update;
  if v_req.id is null or v_req.target_user_id is distinct from v_me then
    raise exception 'Schichttausch: Dieser Antrag ist nicht an dich gerichtet.';
  end if;
  if v_req.status <> 'pending' then
    raise exception 'Schichttausch: Antrag ist bereits abgeschlossen.';
  end if;
  if v_req.target_accepted_at is not null then
    return 'accepted';
  end if;
  perform set_config('clockin.swap_respond', 'on', true);
  if p_accept then
    update public.swap_requests set target_accepted_at = now() where id = p_id;
  else
    update public.swap_requests set status = 'rejected', decision_note = 'Von der angefragten Person abgelehnt' where id = p_id;
  end if;
  perform set_config('clockin.swap_respond', 'off', true);
  return case when p_accept then 'accepted' else 'rejected' end;
end $$;

revoke execute on function public.swap_respond(uuid, boolean) from public, anon;
grant execute on function public.swap_respond(uuid, boolean) to authenticated;

-- Telegram an die Leitung erst nach der Zustimmung
create or replace function private.notify_swap_request() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.status = 'pending' and new.target_accepted_at is not null
     and (tg_op = 'INSERT' or old.target_accepted_at is null) then
    perform private.call_telegram(jsonb_build_object('type', 'swap_request', 'id', new.id));
  end if;
  return null;
end $$;

drop trigger if exists notify_telegram on public.swap_requests;
create trigger notify_telegram after insert or update of target_accepted_at on public.swap_requests
  for each row execute function private.notify_swap_request();

-- Zähler in der Verwaltung: nur Tauschanträge, denen die angefragte Person zugestimmt hat
create or replace function public.admin_open_counts() returns jsonb
language sql stable security invoker set search_path = '' as $$
  select jsonb_build_object(
    'approvals', (select count(*) from public.time_logs where approval_status = 'pending'),
    'overtime',  (select count(*) from public.time_logs where overtime_status = 'pending'),
    'early',     (select count(*) from public.time_logs where early_status = 'pending'),
    'swaps',     (select count(*) from public.swap_requests where status = 'pending' and target_accepted_at is not null))
$$;
revoke execute on function public.admin_open_counts() from public, anon;
grant execute on function public.admin_open_counts() to authenticated;

-- ---------------- 2) Früher gehen ----------------
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
      -- „wenig los“: keine Freigabe, zählt immer als Minusstunden (nur Info an die Admins)
      new.early_status := case when new.early_reason = 'slow' then 'rejected' else 'pending' end;
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

-- offene „wenig los“-Entscheidungen: gelten als Minusstunden
update public.time_logs set early_status = 'rejected' where early_status = 'pending' and early_reason = 'slow';

-- ---------------- 3) Stempeln ----------------
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
  perform pg_advisory_xact_lock(hashtextextended(v_ctx.o_user::text, 42));  -- je Person nacheinander
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

-- ---------------- 4) Ohne Schicht eingestempelt ----------------
-- Freigabe eines „Kommen“ ohne Schicht: passende Schicht suchen, sonst Aushilfsschicht nachtragen
create or replace function private.time_logs_shift_on_approval() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_shift public.shifts;
begin
  if not (new.event_type = 'clock_in' and new.shift_id is null
          and old.approval_status = 'pending' and new.approval_status = 'approved') then
    return new;
  end if;
  select * into v_shift from public.shifts
  where user_id = new.user_id and shift_type = 'work'
    and new.recorded_at >= starts_at - interval '3 hours' and new.recorded_at < ends_at
  order by (location_id is not distinct from new.location_id) desc, abs(extract(epoch from starts_at - new.recorded_at))
  limit 1;
  if v_shift.id is null then
    begin
      insert into public.shifts (user_id, location_id, shift_type, starts_at, ends_at, note)
      values (new.user_id, new.location_id, 'work', new.recorded_at,
              new.recorded_at + make_interval(mins => (select help_shift_minutes from public.rule_settings)),
              'Aushilfsschicht (automatisch eingetragen)')
      returning * into v_shift;
    exception when exclusion_violation then
      return new;  -- überschneidet sich mit einem anderen Eintrag → ohne Schicht lassen
    end;
  end if;
  new.shift_id := v_shift.id;
  -- Pause/Gehen derselben Anwesenheit hängen an derselben Schicht
  update public.time_logs t set shift_id = v_shift.id
  where t.user_id = new.user_id and t.shift_id is null and t.event_type <> 'clock_in'
    and t.recorded_at > new.recorded_at and t.recorded_at < new.recorded_at + interval '16 hours'
    and not exists (select 1 from public.time_logs c
                    where c.user_id = new.user_id and c.event_type = 'clock_in' and c.id <> new.id
                      and c.recorded_at > new.recorded_at and c.recorded_at <= t.recorded_at);
  return new;
end $$;

drop trigger if exists shift_on_approval on public.time_logs;
create trigger shift_on_approval before update of approval_status on public.time_logs
  for each row execute function private.time_logs_shift_on_approval();

create or replace function private.auto_checkout() returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_open  record;
  v_count integer := 0;
  v_help  integer := (select help_shift_minutes from public.rule_settings);
  v_end   timestamptz;
begin
  -- letzte nicht abgelehnte Buchung je Person (offene Freigaben zählen mit → keine Doppel-Einträge)
  for v_open in
    select distinct on (t.user_id) t.user_id, t.event_type, t.recorded_at, t.location_id, t.shift_id, s.ends_at
    from public.time_logs t
    left join public.shifts s on s.id = t.shift_id
    where t.approval_status <> 'rejected' and t.recorded_at > now() - interval '20 hours'
    order by t.user_id, t.recorded_at desc
  loop
    continue when v_open.event_type = 'clock_out';
    -- ohne Schicht (z. B. anderes Handy, keine geplante Schicht): Ende = Kommen + Länge einer Aushilfsschicht
    v_end := coalesce(v_open.ends_at, (
      select max(c.recorded_at) from public.time_logs c
      where c.user_id = v_open.user_id and c.event_type = 'clock_in' and c.approval_status <> 'rejected'
        and c.recorded_at <= v_open.recorded_at and c.recorded_at > now() - interval '20 hours'
    ) + make_interval(mins => v_help));
    continue when v_end is null or v_end > now();
    insert into public.time_logs (user_id, location_id, event_type, recorded_at, source, shift_id, note, approval_status)
    values (v_open.user_id, v_open.location_id, 'clock_out', greatest(v_end, v_open.recorded_at),
            'auto_checkout', v_open.shift_id, 'Ausstempeln vergessen – automatisch zur geplanten Endzeit eingetragen',
            'pending');
    v_count := v_count + 1;
  end loop;
  return v_count;
end $$;

-- ---------------- 5) Stündliche Aufgaben nachholen ----------------
create table if not exists public.job_runs (
  job text not null,
  day date not null,
  ran_at timestamptz not null default now(),
  primary key (job, day)
);
alter table public.job_runs enable row level security;  -- nur intern
revoke all on public.job_runs from anon, authenticated;

-- Fällig? Gibt den Tag zurück, für den die Aufgabe jetzt (einmalig) laufen soll – sonst null.
-- Fenster: ab der eingestellten Stunde bis 6 Std. danach (auch über Mitternacht).
create or replace function private.job_due(p_job text, p_hour integer, p_local timestamp) returns date
language plpgsql security definer set search_path = '' as $$
declare
  v_day date := (p_local - make_interval(hours => p_hour))::date;
begin
  if p_local - (v_day::timestamp + make_interval(hours => p_hour)) >= interval '6 hours' then
    return null;
  end if;
  insert into public.job_runs (job, day) values (p_job, v_day) on conflict do nothing;
  if not found then
    return null;
  end if;
  return v_day;
end $$;

create or replace function private.hourly_jobs() returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_settings public.rule_settings;
  v_local    timestamp := now() at time zone 'Europe/Berlin';
  v_day      date;
begin
  select * into v_settings from public.rule_settings;
  delete from public.job_runs where day < v_local::date - 60;

  if private.job_due('auto_checkout', v_settings.auto_checkout_hour, v_local) is not null then
    perform private.auto_checkout();
  end if;
  v_day := private.job_due('absence_check', v_settings.absence_check_hour, v_local);
  if v_day is not null and extract(isodow from v_day) <> 7 then  -- Sonntag nie
    perform private.call_telegram(jsonb_build_object('type', 'absence_check', 'date', v_day));
  end if;
  v_day := private.job_due('weekly_report', v_settings.weekly_report_hour, v_local);
  if v_day is not null and extract(isodow from v_day) = v_settings.weekly_report_dow then
    perform private.call_telegram(jsonb_build_object(
      'type', 'weekly_report', 'from', date_trunc('week', v_day)::date, 'to', v_day));
  end if;
  -- Erste Woche im Monat (erster Montag, 9 Uhr): Erinnerung an Tobias, die Schultermine (IST) zu aktualisieren
  v_day := private.job_due('school_reminder', 9, v_local);
  if v_day is not null and extract(isodow from v_day) = 1 and extract(day from v_day) <= 7 then
    perform private.call_telegram(jsonb_build_object(
      'type', 'school_reminder',
      'user_id', (select u.id from public.users u
                  where u.role = 'admin' and u.is_active and u.first_name ilike 'Tobi%'
                  order by u.first_name limit 1)));
  end if;
  v_day := private.job_due('monthly_report', v_settings.monthly_report_hour, v_local);
  if v_day is not null and extract(day from v_day) = 1 and coalesce(v_settings.monthly_report_email, '') <> '' then
    perform private.call_telegram(jsonb_build_object('type', 'monthly_report', 'month', date_trunc('month', v_day)::date));
  end if;
end $$;

revoke execute on all functions in schema private from public;
grant execute on all functions in schema private to authenticated, service_role;
