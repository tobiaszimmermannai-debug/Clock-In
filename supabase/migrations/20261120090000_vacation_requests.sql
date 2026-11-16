-- =============================================================================
-- Clock-In · Urlaubsantrag in der App
-- =============================================================================
-- Ablauf: Mitarbeiter beantragt → Studioleitung des Heimatstudios stimmt zu → Freigeber (Dominik) gibt frei,
-- die anderen Admins werden nur informiert → Urlaub steht im Dienstplan, der Resturlaub sinkt.
-- Anträge von Studioleitungen (oder ohne Studioleitung) gehen direkt an den Freigeber.
-- Freigeber: rule_settings.vacation_approver_user_id; leer = aktiver Admin, dessen Vorname mit „Domi“ beginnt,
-- gibt es den nicht: jeder Admin. Geändert wird nur über die Funktionen unten. (Mehrfach ausführbar.)
-- Voraussetzung: 20261119090000_notifications.sql
-- =============================================================================

alter table public.rule_settings add column if not exists vacation_approver_user_id uuid references public.users (id) on delete set null;

create table if not exists public.vacation_requests (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references public.users (id) on delete cascade,
  from_day      date not null,
  to_day        date not null,
  days          integer not null check (days > 0),
  note          text,
  status        text not null default 'pending_lead'
                check (status in ('pending_lead', 'pending_final', 'approved', 'rejected', 'cancelled')),
  lead_by       uuid references public.users (id) on delete set null,
  lead_at       timestamptz,
  final_by      uuid references public.users (id) on delete set null,
  final_at      timestamptz,
  decision_note text,
  created_at    timestamptz not null default now(),
  check (to_day >= from_day)
);
create index if not exists vacation_requests_user_idx on public.vacation_requests (user_id, from_day);

alter table public.vacation_requests enable row level security;
drop policy if exists vacation_requests_select on public.vacation_requests;
create policy vacation_requests_select on public.vacation_requests for select to authenticated
  using (user_id = (select private.current_user_id()) or private.manages_user(user_id));
revoke all on public.vacation_requests from anon, authenticated;
grant select on public.vacation_requests to authenticated;

-- Wer gibt Urlaub endgültig frei? (null = jeder Admin)
create or replace function private.vacation_approver() returns uuid
language sql stable security definer set search_path = '' as $$
  select coalesce(
    (select r.vacation_approver_user_id from public.rule_settings r
     where exists (select 1 from public.users u where u.id = r.vacation_approver_user_id and u.is_active and u.role = 'admin')),
    (select u.id from public.users u where u.role = 'admin' and u.is_active and u.first_name ilike 'Domi%' order by u.first_name limit 1))
$$;

-- Urlaubstage eines Zeitraums: Mo–Fr; ein einzelner Tag zählt immer
create or replace function private.vacation_days(p_from date, p_to date) returns setof date
language sql immutable set search_path = '' as $$
  select d::date from generate_series(p_from, p_to, interval '1 day') d
  where p_from = p_to or extract(isodow from d) < 6
$$;

-- Resturlaub eines Jahres: Anspruch − genommen − eingetragen − offene Anträge
create or replace function private.vacation_left(p_user uuid, p_year integer, p_ignore uuid default null) returns numeric
language sql stable security definer set search_path = '' as $$
  select coalesce((select a.days from public.vacation_allowances a where a.user_id = p_user and a.year = p_year),
                  (select r.default_vacation_days from public.rule_settings r), 20)
       - (select count(distinct s.shift_date) from public.shifts s
          where s.user_id = p_user and s.shift_type = 'vacation'
            and s.shift_date >= make_date(p_year, 1, 1) and s.shift_date < make_date(p_year + 1, 1, 1))
       - coalesce((select sum(q.days) from public.vacation_requests q
                   where q.user_id = p_user and q.status in ('pending_lead', 'pending_final')
                     and extract(year from q.from_day) = p_year and q.id is distinct from p_ignore), 0)
$$;

-- Antrag stellen
create or replace function public.vacation_request_create(p_from date, p_to date, p_note text default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_me    public.users;
  v_today date := (now() at time zone 'Europe/Berlin')::date;
  v_days  integer;
  v_left  numeric;
  v_id    uuid;
  v_lead  boolean;
  v_text  text;
  m       record;
begin
  select * into v_me from public.users where id = private.current_user_id() and is_active;
  if v_me.id is null then
    raise exception 'Bitte im Mitarbeiter-Portal anmelden.';
  end if;
  if p_from is null or p_to is null or p_to < p_from then
    raise exception 'Urlaub: Bitte „von“ und „bis“ richtig angeben.';
  end if;
  if p_from < v_today then
    raise exception 'Urlaub: Der Zeitraum muss in der Zukunft liegen.';
  end if;
  if p_to - p_from > 62 then
    raise exception 'Urlaub: Höchstens 9 Wochen auf einmal.';
  end if;
  if extract(year from p_from) <> extract(year from p_to) then
    raise exception 'Urlaub über den Jahreswechsel: Bitte je Jahr einen eigenen Antrag stellen.';
  end if;
  -- nur Tage zählen, an denen noch kein Urlaub eingetragen ist
  select count(*) into v_days from private.vacation_days(p_from, p_to) d
  where not exists (select 1 from public.shifts s where s.user_id = v_me.id and s.shift_type = 'vacation' and s.shift_date = d);
  if v_days = 0 then
    raise exception 'Urlaub: In diesem Zeitraum ist kein freier Urlaubstag (Wochenende oder schon eingetragen).';
  end if;
  if exists (select 1 from public.vacation_requests q
             where q.user_id = v_me.id and q.status in ('pending_lead', 'pending_final')
               and q.from_day <= p_to and q.to_day >= p_from) then
    raise exception 'Urlaub: Für diesen Zeitraum läuft schon ein Antrag.';
  end if;
  v_left := private.vacation_left(v_me.id, extract(year from p_from)::integer);
  if v_days > v_left then
    raise exception 'Urlaub: % Tage beantragt, aber nur noch % übrig.', v_days, trim(to_char(greatest(v_left, 0), 'FM990.0'), '.0');
  end if;

  -- Studioleitung zuerst – außer man ist selbst Leitung/Admin oder das Heimatstudio hat keine (andere) Leitung
  v_lead := v_me.role not in ('manager', 'admin') and exists (
    select 1 from public.location_managers lm join public.users u on u.id = lm.user_id and u.is_active
    where lm.location_id = v_me.home_location_id and lm.user_id <> v_me.id);

  insert into public.vacation_requests (user_id, from_day, to_day, days, note, status)
  values (v_me.id, p_from, p_to, v_days, nullif(trim(coalesce(p_note, '')), ''), case when v_lead then 'pending_lead' else 'pending_final' end)
  returning id into v_id;

  v_text := v_me.first_name || ' ' || v_me.last_name || ': ' || to_char(p_from, 'DD.MM.') || '–' || to_char(p_to, 'DD.MM.YYYY')
            || ' (' || v_days || case when v_days = 1 then ' Tag)' else ' Tage)' end;
  if v_lead then
    for m in select lm.user_id from public.location_managers lm where lm.location_id = v_me.home_location_id and lm.user_id <> v_me.id loop
      perform private.notify_user(m.user_id, 'vacation', 'Urlaubsantrag wartet auf dich', v_text || ' – bitte zustimmen oder ablehnen (Mitteilungen oder Verwaltung → Freigaben).');
    end loop;
  else
    perform private.call_telegram(jsonb_build_object('type', 'vacation_request', 'id', v_id));
  end if;
  return v_id;
end $$;

-- Antrag zurückziehen (solange er offen ist)
create or replace function public.vacation_request_cancel(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  update public.vacation_requests set status = 'cancelled'
  where id = p_id and user_id = private.current_user_id() and status in ('pending_lead', 'pending_final');
  if not found then
    raise exception 'Urlaub: Dieser Antrag kann nicht mehr zurückgezogen werden.';
  end if;
end $$;

-- Entscheiden: Studioleitung (1. Schritt) bzw. Freigeber (endgültig). p_by nur für den Telegram-Bot (Service-Role).
create or replace function public.vacation_request_decide(p_id uuid, p_ok boolean, p_note text default null, p_by uuid default null)
returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_me       uuid := case when (select auth.uid()) is null then p_by else private.current_user_id() end;
  v_req      public.vacation_requests;
  v_user     public.users;
  v_approver uuid := private.vacation_approver();
  v_final    boolean;
  v_is_lead  boolean;
  v_note     text := nullif(trim(coalesce(p_note, '')), '');
  v_range    text;
  v_busy     text;
  v_count    integer;
  v_left     numeric;
begin
  select * into v_req from public.vacation_requests where id = p_id for update;
  if v_req.id is null then
    raise exception 'Urlaub: Antrag nicht gefunden.';
  end if;
  if v_req.status not in ('pending_lead', 'pending_final') then
    raise exception 'Urlaub: Antrag ist bereits abgeschlossen.';
  end if;
  if v_me is null or v_me = v_req.user_id then
    raise exception 'Urlaub: Eigene Anträge kann man nicht selbst freigeben.';
  end if;
  select * into v_user from public.users where id = v_req.user_id;
  v_range := to_char(v_req.from_day, 'DD.MM.') || '–' || to_char(v_req.to_day, 'DD.MM.YYYY');

  -- darf endgültig entscheiden: der Freigeber; ohne festgelegten Freigeber jeder Admin
  v_final := exists (select 1 from public.users a where a.id = v_me and a.is_active and a.role = 'admin'
                                                    and (v_approver is null or a.id = v_approver));
  v_is_lead := exists (select 1 from public.location_managers lm join public.users u on u.id = lm.user_id and u.is_active
                       where lm.user_id = v_me and lm.location_id = v_user.home_location_id);
  if not (v_final or (v_req.status = 'pending_lead' and v_is_lead)) then
    raise exception 'Urlaub: %', case when v_req.status = 'pending_lead'
      then 'Zuerst entscheidet die Studioleitung.'
      else 'Endgültig gibt ' || coalesce((select first_name from public.users where id = v_approver), 'ein Admin') || ' frei.' end;
  end if;

  if not p_ok then
    update public.vacation_requests
       set status = 'rejected', decision_note = v_note,
           lead_by = case when v_final then lead_by else v_me end, lead_at = case when v_final then lead_at else now() end,
           final_by = case when v_final then v_me end, final_at = case when v_final then now() end
     where id = p_id;
    perform private.notify_user(v_req.user_id, 'vacation', 'Urlaub abgelehnt', v_range || coalesce(' – ' || v_note, ''));
    perform private.call_telegram(jsonb_build_object('type', 'vacation_decided', 'id', p_id));
    return 'rejected';
  end if;

  if not v_final then  -- Studioleitung stimmt zu → weiter zum Freigeber
    update public.vacation_requests set status = 'pending_final', lead_by = v_me, lead_at = now() where id = p_id;
    perform private.notify_user(v_req.user_id, 'vacation', 'Urlaub: Studioleitung hat zugestimmt',
      v_range || ' – jetzt entscheidet ' || coalesce((select first_name from public.users where id = v_approver), 'die Geschäftsführung') || '.');
    perform private.call_telegram(jsonb_build_object('type', 'vacation_request', 'id', p_id));
    return 'pending_final';
  end if;

  -- Endgültige Freigabe: geplante Arbeitsschichten im Zeitraum müssen erst weg (nichts wird automatisch gelöscht)
  select string_agg(to_char(s.shift_date, 'DD.MM.'), ', ' order by s.shift_date) into v_busy
  from public.shifts s
  where s.user_id = v_req.user_id and s.shift_type = 'work' and s.shift_date in (select private.vacation_days(v_req.from_day, v_req.to_day));
  if v_busy is not null then
    raise exception 'Urlaub: % hat am % noch eine Schicht im Dienstplan. Bitte zuerst dort ändern.', v_user.first_name, v_busy;
  end if;
  select count(*) into v_count from private.vacation_days(v_req.from_day, v_req.to_day) d
  where not exists (select 1 from public.shifts s where s.user_id = v_req.user_id and s.shift_date = d);
  v_left := private.vacation_left(v_req.user_id, extract(year from v_req.from_day)::integer, p_id);
  if v_count > v_left then
    raise exception 'Urlaub: % Tage, aber nur noch % übrig.', v_count, trim(to_char(greatest(v_left, 0), 'FM990.0'), '.0');
  end if;

  perform set_config('clockin.silent', 'on', true);  -- eine Mitteilung statt einer je Tag
  insert into public.shifts (user_id, location_id, shift_type, starts_at, ends_at, note)
  select v_req.user_id, null, 'vacation',
         (d::timestamp + time '08:00') at time zone 'Europe/Berlin', (d::timestamp + time '14:30') at time zone 'Europe/Berlin',
         'Urlaubsantrag'
  from private.vacation_days(v_req.from_day, v_req.to_day) d
  where not exists (select 1 from public.shifts s where s.user_id = v_req.user_id and s.shift_date = d);
  perform set_config('clockin.silent', 'off', true);

  update public.vacation_requests
     set status = 'approved', days = greatest(v_count, 1), final_by = v_me, final_at = now(), decision_note = v_note
   where id = p_id;
  perform private.notify_user(v_req.user_id, 'vacation', 'Urlaub genehmigt 🎉',
    v_range || ' (' || v_count || case when v_count = 1 then ' Tag' else ' Tage' end || ') steht im Dienstplan.');
  perform private.call_telegram(jsonb_build_object('type', 'vacation_decided', 'id', p_id));
  return 'approved';
end $$;

-- Offene Anträge, die ich sehen darf – mit „darf ich jetzt entscheiden?“
create or replace function public.vacation_requests_open()
returns table (id uuid, user_id uuid, first_name text, last_name text, from_day date, to_day date, days integer,
               note text, status text, created_at timestamptz, left_after numeric, can_decide boolean, approver text)
language sql stable security definer set search_path = '' as $$
  select q.id, q.user_id, u.first_name, u.last_name, q.from_day, q.to_day, q.days, q.note, q.status, q.created_at,
         private.vacation_left(q.user_id, extract(year from q.from_day)::integer),
         q.user_id <> private.current_user_id() and (
           (private.is_admin() and (private.vacation_approver() is null or private.vacation_approver() = private.current_user_id()))
           or (q.status = 'pending_lead' and exists (
                 select 1 from public.location_managers lm
                 where lm.user_id = private.current_user_id() and lm.location_id = u.home_location_id))),
         (select a.first_name from public.users a where a.id = private.vacation_approver())
  from public.vacation_requests q
  join public.users u on u.id = q.user_id
  where q.status in ('pending_lead', 'pending_final')
    and (q.user_id = private.current_user_id() or private.manages_user(q.user_id))
  order by q.created_at
$$;

-- Zähler in der Verwaltung: + Urlaubsanträge, die ich jetzt entscheiden kann
create or replace function public.admin_open_counts() returns jsonb
language sql stable security invoker set search_path = '' as $$
  select jsonb_build_object(
    'approvals', (select count(*) from public.time_logs where approval_status = 'pending'),
    'overtime',  (select count(*) from public.time_logs where overtime_status = 'pending'),
    'early',     (select count(*) from public.time_logs where early_status = 'pending'),
    'swaps',     (select count(*) from public.swap_requests where status = 'pending' and target_accepted_at is not null),
    'vacation',  (select count(*) from public.vacation_requests_open() v where v.can_decide))
$$;

revoke execute on function public.vacation_request_create(date, date, text), public.vacation_request_cancel(uuid),
  public.vacation_request_decide(uuid, boolean, text, uuid), public.vacation_requests_open(), public.admin_open_counts() from public, anon;
grant execute on function public.vacation_request_create(date, date, text), public.vacation_request_cancel(uuid),
  public.vacation_requests_open(), public.admin_open_counts() to authenticated;
grant execute on function public.vacation_request_decide(uuid, boolean, text, uuid) to authenticated, service_role;

revoke execute on all functions in schema private from public;
grant execute on all functions in schema private to authenticated, service_role;
