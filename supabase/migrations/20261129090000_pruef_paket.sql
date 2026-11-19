-- =============================================================================
-- Clock-In · Prüf-Paket (mehrfach ausführbar)
-- =============================================================================
-- 1) Tausch: Zustimmen/Freigeben nur, solange keine der beiden Schichten begonnen hat.
-- 2) Tausch: offene Anfragen laufen automatisch ab, sobald die Schicht beginnt (Mitteilung an den Antragsteller).
-- 3) Testkonten: nicht im Freitags-Wochenbericht und nicht in den Zählern der Verwaltung.
-- 8) Tausch: Erinnerung, wenn eine Anfrage über 24 h unbeantwortet ist (Mitteilung + Telegram-Info an die Admins).
-- 11) Wissen: Wochen-Rangliste je Studio (nur Durchschnitt, keine Einzelnen).
-- 12) health_check(): Was hängt? (offene Anträge, vergessenes Ausstempeln, fehlende Vertragsdaten)
-- =============================================================================

-- ---------------- 1) Nicht für begonnene Schichten ----------------
create or replace function private.swap_requests_not_past() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if (new.status = 'approved' and old.status = 'pending')
     or (old.target_accepted_at is null and new.target_accepted_at is not null) then
    if exists (select 1 from public.shifts s
               where s.id in (old.requester_shift_id, old.target_shift_id) and s.starts_at <= now()) then
      raise exception 'Schichttausch: Die Schicht hat schon begonnen – Tausch nicht mehr möglich.';
    end if;
  end if;
  return new;
end $$;

drop trigger if exists not_past on public.swap_requests;
create trigger not_past before update on public.swap_requests
  for each row execute function private.swap_requests_not_past();

-- ---------------- 2) + 8) Ablauf und Erinnerung ----------------
create or replace function private.swap_housekeeping() returns void
language plpgsql security definer set search_path = '' as $$
declare
  r record;
  v_stale integer;
begin
  -- 2) abgelaufen: Schicht hat begonnen
  for r in
    select q.id, q.requester_id, (select first_name from public.users where id = q.target_user_id) as tgt,
           (select private.fmt_shift(s.starts_at, s.ends_at) from public.shifts s where s.id = q.requester_shift_id) as what
    from public.swap_requests q
    where q.status = 'pending'
      and exists (select 1 from public.shifts s where s.id in (q.requester_shift_id, q.target_shift_id) and s.starts_at <= now())
  loop
    update public.swap_requests set status = 'cancelled', decision_note = 'Abgelaufen: Die Schicht hat schon begonnen.' where id = r.id;
    perform private.notify_user(r.requester_id, 'swap', 'Tausch abgelaufen',
      'Schicht ' || coalesce(r.what, '?') || ' – ' || coalesce(r.tgt, 'die angefragte Person') || ' hat nicht rechtzeitig reagiert.');
  end loop;

  -- 8) Erinnerung nach 24 h ohne Antwort (je Anfrage einmal)
  v_stale := 0;
  for r in
    select q.id, q.target_user_id, (select first_name from public.users where id = q.requester_id) as req,
           (select private.fmt_shift(s.starts_at, s.ends_at) from public.shifts s where s.id = q.requester_shift_id) as what
    from public.swap_requests q
    where q.status = 'pending' and q.target_accepted_at is null and q.created_at < now() - interval '24 hours'
  loop
    if not exists (select 1 from public.job_runs j where j.job = 'swap_remind:' || r.id) then
      insert into public.job_runs (job, day) values ('swap_remind:' || r.id, current_date) on conflict do nothing;
      perform private.notify_user(r.target_user_id, 'swap', 'Erinnerung: ' || r.req || ' wartet auf deine Antwort',
        'Tausch ' || coalesce(r.what, '?') || ' – bitte zustimmen oder ablehnen.', 'remind:' || r.id::text);
      v_stale := v_stale + 1;
    end if;
  end loop;
  if v_stale > 0 then
    perform private.call_telegram(jsonb_build_object('type', 'swap_stale'));
  end if;
end $$;

create or replace function private.hourly_jobs() returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_settings public.rule_settings;
  v_local    timestamp := now() at time zone 'Europe/Berlin';
  v_day      date;
begin
  select * into v_settings from public.rule_settings;
  perform private.swap_housekeeping();
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

-- ---------------- 3) Testkonten raus ----------------
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
         coalesce(e.weekly_target_minutes, 0),
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

create or replace function public.admin_open_counts() returns jsonb
language sql stable security invoker set search_path = '' as $$
  select jsonb_build_object(
    'approvals', (select count(*) from public.time_logs t join public.users u on u.id = t.user_id where t.approval_status = 'pending' and not u.is_test),
    'overtime',  (select count(*) from public.time_logs t join public.users u on u.id = t.user_id where t.overtime_status = 'pending' and not u.is_test),
    'early',     (select count(*) from public.time_logs t join public.users u on u.id = t.user_id where t.early_status = 'pending' and not u.is_test),
    'swaps',     (select count(*) from public.swap_requests q join public.users u on u.id = q.requester_id
                  where q.status = 'pending' and q.target_accepted_at is not null and not u.is_test),
    'vacation',  (select count(*) from public.vacation_requests_open() v join public.users u on u.id = v.user_id where v.can_decide and not u.is_test))
$$;

-- ---------------- 11) Wissen: Wochen-Rangliste je Studio ----------------
create or replace function public.wissen_week_board(p_from date default null)
returns table (location_id uuid, name text, people integer, xp integer, avg_xp numeric, rank integer)
language sql stable security definer set search_path = '' as $$
  with w as (
    select coalesce(p_from, date_trunc('week', (now() at time zone 'Europe/Berlin'))::date) as d
  ), per as (
    select u.home_location_id as loc, u.id,
           coalesce((select sum(a.xp_earned) from public.wissen_attempts a, w
                     where a.user_id = u.auth_user_id
                       and a.created_at >= private.berlin_day_start(w.d)
                       and a.created_at < private.berlin_day_start(w.d + 7)), 0) as xp
    from public.users u
    where u.is_active and not u.is_test and u.role <> 'admin' and u.auth_user_id is not null and u.home_location_id is not null
  ), agg as (
    select l.id, l.name, count(per.id)::integer as people, coalesce(sum(per.xp), 0)::integer as xp,
           round(coalesce(sum(per.xp), 0)::numeric / greatest(count(per.id), 1), 1) as avg_xp
    from public.locations l join per on per.loc = l.id
    where l.is_active
    group by l.id, l.name
  )
  select id, name, people, xp, avg_xp, (rank() over (order by avg_xp desc))::integer from agg
  where (select auth.uid()) is null or private.current_user_id() is not null
  order by avg_xp desc, name
$$;
revoke execute on function public.wissen_week_board(date) from public, anon;
grant execute on function public.wissen_week_board(date) to authenticated, service_role;

-- ---------------- 12) Was hängt? ----------------
create or replace function public.health_check()
returns table (area text, items integer, hint text)
language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is not null and not private.is_admin() then
    raise exception 'Nur für Admins.';
  end if;
  return query
  with real_users as (select id from public.users where is_active and not is_test)
  select x.area, x.items, x.hint from (
    select 'Tauschanfragen ohne Antwort (> 2 Tage)' as area,
           (select count(*) from public.swap_requests q where q.status = 'pending' and q.target_accepted_at is null
              and q.created_at < now() - interval '2 days' and q.requester_id in (select id from real_users))::integer as items,
           'Kollege antwortet nicht – ansprechen oder Antrag stornieren lassen' as hint
    union all
    select 'Tausch wartet auf Freigabe (> 2 Tage)',
           (select count(*) from public.swap_requests q where q.status = 'pending' and q.target_accepted_at is not null
              and q.created_at < now() - interval '2 days' and q.requester_id in (select id from real_users))::integer,
           'Verwaltung → Freigaben'
    union all
    select 'Nachträge/Buchungen offen (> 3 Tage)',
           (select count(*) from public.time_logs t where t.approval_status = 'pending' and t.recorded_at < now() - interval '3 days'
              and t.user_id in (select id from real_users))::integer,
           'Verwaltung → Freigaben'
    union all
    select 'Überstunden offen (> 7 Tage)',
           (select count(*) from public.time_logs t where t.overtime_status = 'pending' and t.recorded_at < now() - interval '7 days'
              and t.user_id in (select id from real_users))::integer,
           'Verwaltung → Freigaben'
    union all
    select 'Früher gehen offen (> 3 Tage)',
           (select count(*) from public.time_logs t where t.early_status = 'pending' and t.recorded_at < now() - interval '3 days'
              and t.user_id in (select id from real_users))::integer,
           'Verwaltung → Freigaben'
    union all
    select 'Urlaubsanträge offen (> 7 Tage)',
           (select count(*) from public.vacation_requests v where v.status in ('pending_lead', 'pending_final')
              and v.created_at < now() - interval '7 days' and v.user_id in (select id from real_users))::integer,
           'Mitteilungen bzw. Freigaben → Urlaub'
    union all
    select 'Seit über 16 h eingestempelt',
           (select count(*) from real_users r
             where (select t.event_type::text from public.time_logs t where t.user_id = r.id and t.approval_status <> 'rejected'
                    order by t.recorded_at desc limit 1) in ('clock_in', 'break_start', 'break_end')
               and (select max(t.recorded_at) from public.time_logs t where t.user_id = r.id) < now() - interval '16 hours')::integer,
           'Ausstempeln vergessen – Verwaltung → Zeiten'
    union all
    select 'Mitarbeiter ohne Vertragsdaten',
           (select count(*) from public.users u where u.is_active and not u.is_test and u.role <> 'admin'
              and not exists (select 1 from public.employment_details e where e.user_id = u.id))::integer,
           'Verwaltung → Mitarbeiter → Wochenstunden eintragen'
  ) x where x.items > 0;
end $$;
revoke execute on function public.health_check() from public, anon;
grant execute on function public.health_check() to authenticated, service_role;
