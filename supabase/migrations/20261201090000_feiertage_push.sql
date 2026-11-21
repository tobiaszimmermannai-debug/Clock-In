-- =============================================================================
-- Clock-In · Feiertage (Bayern) und Push-Nachrichten aufs Handy (mehrfach ausführbar, löscht nichts)
-- =============================================================================
-- Feiertage: Soll an Feiertagen (Mo–Fr) = 0; Urlaub/Krank an Feiertagen ohne Gutschrift (außer Krank statt einer
--   geplanten Schicht); Urlaubstage zählen Feiertage nicht. Gilt für Statistik, Wochenbericht und Stunden.
-- Push: Jede Mitteilung (Glocke) geht zusätzlich als Push ans Handy, wenn die Person Push eingeschaltet hat.
--   Versand über die Telegram-Funktion (type 'push'); die Schlüssel (VAPID) erzeugt die Funktion selbst.
-- =============================================================================

-- ---------------- Feiertage ----------------
create or replace function private.easter(p_year integer) returns date
language plpgsql immutable set search_path = '' as $$
declare
  a int := p_year % 19; b int := p_year / 100; c int := p_year % 100; d int := b / 4; e int := b % 4;
  f int := (b + 8) / 25; g int := (b - f + 1) / 3; h int := (19 * a + b - d - g + 15) % 30;
  i int := c / 4; k int := c % 4; l int := (32 + 2 * e + 2 * i - h - k) % 7; m int := (a + 11 * h + 22 * l) / 451;
begin
  return make_date(p_year, (h + l - 7 * m + 114) / 31, ((h + l - 7 * m + 114) % 31) + 1);
end $$;

-- Gesetzliche Feiertage in Bayern (Mariä Himmelfahrt gilt in allen Studio-Orten). Gleiche Liste wie app/src/lib/holidays.ts
create or replace function public.holiday_name(p_day date) returns text
language plpgsql immutable set search_path = '' as $$
declare
  e date := private.easter(extract(year from p_day)::int);
  md text := to_char(p_day, 'MM-DD');
begin
  return case
    when md = '01-01' then 'Neujahr'
    when md = '01-06' then 'Heilige Drei Könige'
    when p_day = e - 2 then 'Karfreitag'
    when p_day = e + 1 then 'Ostermontag'
    when md = '05-01' then 'Tag der Arbeit'
    when p_day = e + 39 then 'Christi Himmelfahrt'
    when p_day = e + 50 then 'Pfingstmontag'
    when p_day = e + 60 then 'Fronleichnam'
    when md = '08-15' then 'Mariä Himmelfahrt'
    when md = '10-03' then 'Tag der Deutschen Einheit'
    when md = '11-01' then 'Allerheiligen'
    when md = '12-25' then '1. Weihnachtstag'
    when md = '12-26' then '2. Weihnachtstag'
  end;
end $$;
grant execute on function public.holiday_name(date) to authenticated, service_role;

-- Urlaubstage: Feiertage zählen nicht
create or replace function private.vacation_days(p_from date, p_to date) returns setof date
language sql immutable set search_path = '' as $$
  select d::date from generate_series(p_from, p_to, interval '1 day') d
  where (p_from = p_to or extract(isodow from d) < 6) and public.holiday_name(d::date) is null
$$;

-- Tagesauswertung: Urlaub/Krank an Feiertagen ohne Gutschrift (Soll ist dort 0)
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
                      then least(count(*) filter (where not s.from_shift and s.shift_type::text in ('vacation', 'sick')
                                                  and not (s.shift_type::text = 'sick' and extract(isodow from v_day) >= 6)
                                                  and public.holiday_name(v_day) is null), 1)
                             * v_settings.absence_credit_minutes
                           + coalesce(sum(extract(epoch from s.ends_at - s.starts_at) / 60) filter (where s.from_shift), 0)
                      else least(coalesce(sum(s.credit_share) filter (where s.shift_type::text in ('vacation', 'sick')
                                    and not (s.shift_type::text = 'sick' and not s.from_shift and extract(isodow from v_day) >= 6)
                                    and not (not s.from_shift and public.holiday_name(v_day) is not null)), 0), 1)
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

-- Statistik: Soll ohne Feiertage
drop function if exists public.team_stats(date, date);
create function public.team_stats(p_from date, p_to date)
returns table (
  user_id uuid, first_name text, last_name text, role public.user_role, home_location_id uuid,
  weekly_target_minutes integer, target_minutes integer, worked_minutes integer, credit_minutes integer,
  late_count integer, late_minutes integer, overtime_pending_minutes integer, overtime_approved_minutes integer,
  open_days integer, forgotten_count integer, early_count integer, early_minutes integer,
  sick_days integer, vacation_days integer, school_days integer, work_shifts integer,
  counted_from date   -- ab hier zählt das Soll (null = noch nie gestempelt)
)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_to   date := least(p_to, (now() at time zone 'Europe/Berlin')::date - 1);  -- bis gestern (heute läuft noch)
  v_days integer;
  v_start date;
  u      record;
  s      record;
  v_from date;
  v_end  date;
begin
  if auth.uid() is not null and not (private.is_admin() or private.is_manager()) then
    raise exception 'Statistik nur für Admins und Studioleitungen.';
  end if;
  if p_from is null or v_to < p_from then
    return;
  end if;
  if v_to - p_from > 366 then
    raise exception 'Zeitraum zu lang (höchstens ein Jahr).';
  end if;

  for u in
    select x.id, x.first_name, x.last_name, x.role, x.home_location_id, coalesce(e.weekly_target_minutes, 0) as weekly,
           e.employment_start,
           (select min((t.recorded_at at time zone 'Europe/Berlin')::date) from public.time_logs t
            where t.user_id = x.id and t.approval_status <> 'rejected') as first_stamp
    from public.users x
    left join public.employment_details e on e.user_id = x.id
    where x.is_active and not x.is_test and x.role <> 'admin' and x.time_tracking
      and (auth.uid() is null or private.manages_user(x.id))
    order by x.first_name, x.last_name
  loop
    user_id := u.id; first_name := u.first_name; last_name := u.last_name; role := u.role;
    home_location_id := u.home_location_id; weekly_target_minutes := u.weekly;
    -- Soll: Wochenstunden ÷ 5 je Werktag (Mo–Fr) ab Beginn der Zählung bis heute
    v_start := greatest(p_from, u.employment_start, u.first_stamp);
    counted_from := case when u.first_stamp is null then null else v_start end;
    select count(*) into v_days from generate_series(v_start, v_to, interval '1 day') d where extract(isodow from d) < 6 and public.holiday_name(d::date) is null;
    target_minutes := case when u.first_stamp is null then 0 else round(u.weekly / 5.0 * coalesce(v_days, 0)) end;
    worked_minutes := 0; credit_minutes := 0; late_count := 0; late_minutes := 0;
    overtime_pending_minutes := 0; overtime_approved_minutes := 0; open_days := 0;
    -- Stundenberechnung in Blöcken von 90 Tagen (work_day_summary erlaubt höchstens 93)
    v_from := p_from;
    while v_from <= v_to loop
      v_end := least(v_from + 89, v_to);
      for s in select * from public.work_day_summary(u.id, v_from, v_end) loop
        worked_minutes := worked_minutes + s.worked_minutes;
        credit_minutes := credit_minutes + s.credit_minutes;
        late_count := late_count + (s.late_minutes > 0)::int;
        late_minutes := late_minutes + s.late_minutes;
        overtime_pending_minutes := overtime_pending_minutes + s.overtime_pending_minutes;
        overtime_approved_minutes := overtime_approved_minutes + s.overtime_approved_minutes;
        open_days := open_days + (s.open_session and s.day < v_to)::int;
      end loop;
      v_from := v_end + 1;
    end loop;
    select count(*) filter (where t.source = 'auto_checkout')
      into forgotten_count
    from public.time_logs t
    where t.user_id = u.id and t.approval_status <> 'rejected'
      and t.recorded_at >= private.berlin_day_start(p_from) and t.recorded_at < private.berlin_day_start(v_to + 1);
    -- Früher gegangen: Minusstunden = Zeit bis Schichtende, wenn nicht „bis Schichtende angerechnet“ oder „krank“
    select count(*), coalesce(sum(floor(extract(epoch from sh.ends_at - t.recorded_at) / 60)), 0)::integer
      into early_count, early_minutes
    from public.time_logs t
    join public.shifts sh on sh.id = t.shift_id
    where t.user_id = u.id and t.event_type = 'clock_out' and t.approval_status <> 'rejected'
      and t.early_status is not null and t.early_status not in ('approved', 'sick')
      and t.recorded_at < sh.ends_at
      and t.recorded_at >= private.berlin_day_start(p_from) and t.recorded_at < private.berlin_day_start(v_to + 1);
    select count(distinct sh.shift_date) filter (where sh.shift_type = 'sick'),
           count(distinct sh.shift_date) filter (where sh.shift_type = 'vacation'),
           count(distinct sh.shift_date) filter (where sh.shift_type = 'vocational_school'),
           count(*) filter (where sh.shift_type = 'work')
      into sick_days, vacation_days, school_days, work_shifts
    from public.shifts sh
    where sh.user_id = u.id and sh.shift_date between p_from and v_to;
    return next;
  end loop;
end $$;

revoke execute on function public.team_stats(date, date) from public, anon;
grant execute on function public.team_stats(date, date) to authenticated, service_role;

-- Freitags-Wochenbericht: Soll ohne Feiertage
create or replace function public.weekly_report(p_from date, p_to date)
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
         round(coalesce(e.weekly_target_minutes, 0) / 5.0 * (select count(*) from generate_series(p_from, p_to, interval '1 day') d
                where extract(isodow from d) < 6 and public.holiday_name(d::date) is null))::integer,
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
  where u.is_active and not u.is_test and u.role <> 'admin' and u.time_tracking
  group by u.id, u.first_name, u.last_name, u.role, e.weekly_target_minutes
  order by u.last_name, u.first_name
$$;

-- ---------------- Push ----------------
create table if not exists public.push_subscriptions (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.users (id) on delete cascade,
  endpoint   text not null unique,
  p256dh     text not null,
  auth       text not null,
  created_at timestamptz not null default now()
);
create index if not exists push_subscriptions_user_idx on public.push_subscriptions (user_id);
alter table public.push_subscriptions enable row level security;
drop policy if exists push_subscriptions_select on public.push_subscriptions;
create policy push_subscriptions_select on public.push_subscriptions for select to authenticated
  using (user_id = (select private.current_user_id()));
revoke all on public.push_subscriptions from anon, authenticated;
grant select on public.push_subscriptions to authenticated;

-- Schlüssel für Web-Push (VAPID): nur die Telegram-Funktion (Service-Role) liest/schreibt; keine Policies = kein Zugriff
create table if not exists public.push_config (
  id          integer primary key default 1 check (id = 1),
  public_key  text,
  private_key text,
  subject     text,
  updated_at  timestamptz not null default now()
);
alter table public.push_config enable row level security;
revoke all on public.push_config from anon, authenticated;

-- Öffentlicher Schlüssel fürs Handy; fehlt er, erzeugt die Funktion ihn (nächster Aufruf liefert ihn)
create or replace function public.push_public_key(p_origin text default null) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_key text;
begin
  if private.current_user_id() is null then
    raise exception 'Nicht angemeldet.';
  end if;
  select public_key into v_key from public.push_config where id = 1;
  if v_key is null then
    if p_origin ~ '^https://' then
      insert into public.push_config (id, subject) values (1, p_origin) on conflict (id) do update set subject = coalesce(public.push_config.subject, excluded.subject);
    end if;
    perform private.call_telegram(jsonb_build_object('type', 'push_init'));
  end if;
  return v_key;
end $$;

create or replace function public.push_subscribe(p_endpoint text, p_p256dh text, p_auth text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_me uuid := private.current_user_id();
begin
  if v_me is null then
    raise exception 'Nicht angemeldet.';
  end if;
  insert into public.push_subscriptions (user_id, endpoint, p256dh, auth) values (v_me, p_endpoint, p_p256dh, p_auth)
  on conflict (endpoint) do update set user_id = v_me, p256dh = excluded.p256dh, auth = excluded.auth, created_at = now();
end $$;

create or replace function public.push_unsubscribe(p_endpoint text) returns void
language sql security definer set search_path = '' as $$
  delete from public.push_subscriptions where endpoint = p_endpoint and user_id = private.current_user_id();
$$;

revoke execute on function public.push_public_key(text) from public, anon;
grant execute on function public.push_public_key(text) to authenticated;
revoke execute on function public.push_subscribe(text, text, text) from public, anon;
grant execute on function public.push_subscribe(text, text, text) to authenticated;
revoke execute on function public.push_unsubscribe(text) from public, anon;
grant execute on function public.push_unsubscribe(text) to authenticated;

-- Mitteilung → zusätzlich Push (nur wenn die Person Push eingeschaltet hat)
create or replace function private.notify_user(p_user uuid, p_kind text, p_title text, p_body text default null, p_ref text default null)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if p_user is null or p_user is not distinct from private.current_user_id() then
    return;
  end if;
  if p_ref is not null and exists (
       select 1 from public.notifications n
       where n.user_id = p_user and n.kind = p_kind and n.ref = p_ref and n.read_at is null) then
    return;
  end if;
  insert into public.notifications (user_id, kind, ref, title, body) values (p_user, p_kind, p_ref, p_title, p_body);
  if exists (select 1 from public.push_subscriptions ps where ps.user_id = p_user) then
    perform private.call_telegram(jsonb_build_object('type', 'push', 'user_id', p_user, 'kind', p_kind, 'title', p_title, 'body', p_body));
  end if;
  delete from public.notifications where user_id = p_user and created_at < now() - interval '90 days';
exception when others then
  raise warning 'Mitteilung fehlgeschlagen: %', sqlerrm;  -- darf nie eine Buchung verhindern
end $$;

