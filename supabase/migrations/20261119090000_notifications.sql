-- =============================================================================
-- Clock-In · Mitteilungen im Portal (Glocke)
-- =============================================================================
-- Mitarbeiter sehen im Portal, was sie betrifft: Tauschanfrage / Zustimmung / Entscheidung, Änderungen an eigenen
-- kommenden Schichten (je Tag höchstens eine ungelesene Mitteilung), Entscheidung zu Nachträgen und Überstunden.
-- Bewusst NICHT: „Früher gehen entschieden“. Wer selbst handelt, bekommt keine Mitteilung. (Mehrfach ausführbar.)
-- =============================================================================

create table if not exists public.notifications (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.users (id) on delete cascade,
  kind       text not null,
  ref        text,                       -- Bündelung (z. B. Tag bei Dienstplan-Änderungen)
  title      text not null,
  body       text,
  created_at timestamptz not null default now(),
  read_at    timestamptz
);
create index if not exists notifications_user_idx on public.notifications (user_id, created_at desc);

alter table public.notifications enable row level security;
drop policy if exists notifications_select on public.notifications;
drop policy if exists notifications_update on public.notifications;
create policy notifications_select on public.notifications for select to authenticated
  using (user_id = (select private.current_user_id()));
create policy notifications_update on public.notifications for update to authenticated
  using (user_id = (select private.current_user_id())) with check (user_id = (select private.current_user_id()));
revoke all on public.notifications from anon, authenticated;
grant select on public.notifications to authenticated;
grant update (read_at) on public.notifications to authenticated;

-- „Mo., 16.11. 09:00–15:00“
create or replace function private.fmt_shift(p_from timestamptz, p_to timestamptz) returns text
language sql stable set search_path = '' as $$
  select (array['Mo.', 'Di.', 'Mi.', 'Do.', 'Fr.', 'Sa.', 'So.'])[extract(isodow from p_from at time zone 'Europe/Berlin')::int]
         || ', ' || to_char(p_from at time zone 'Europe/Berlin', 'DD.MM. HH24:MI')
         || '–' || to_char(p_to at time zone 'Europe/Berlin', 'HH24:MI')
$$;

-- Mitteilung anlegen (nicht an sich selbst; mit p_ref höchstens eine ungelesene je Art und Bezug)
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
  delete from public.notifications where user_id = p_user and created_at < now() - interval '90 days';
exception when others then
  raise warning 'Mitteilung fehlgeschlagen: %', sqlerrm;  -- darf nie eine Buchung verhindern
end $$;

-- ---------------- Schichttausch ----------------
create or replace function private.swap_requests_inform() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_req  text := (select first_name from public.users where id = new.requester_id);
  v_tgt  text := (select first_name from public.users where id = new.target_user_id);
  v_what text := (select private.fmt_shift(s.starts_at, s.ends_at) from public.shifts s where s.id = new.requester_shift_id);
begin
  if tg_op = 'INSERT' then
    perform private.notify_user(new.target_user_id, 'swap', 'Tauschanfrage von ' || v_req,
      'Schicht ' || coalesce(v_what, '?') || ' – bitte unter Dienstplan → Schichttausch zustimmen oder ablehnen.');
  elsif old.target_accepted_at is null and new.target_accepted_at is not null and new.status = 'pending' then
    perform private.notify_user(new.requester_id, 'swap', v_tgt || ' hat dem Tausch zugestimmt',
      'Schicht ' || coalesce(v_what, '?') || ' – jetzt entscheidet die Studioleitung.');
  elsif old.status = 'pending' and new.status = 'approved' then
    perform private.notify_user(new.requester_id, 'swap', 'Tausch freigegeben', 'Schicht ' || coalesce(v_what, '?') || ' übernimmt ' || v_tgt || '.');
    perform private.notify_user(new.target_user_id, 'swap', 'Tausch freigegeben', 'Du übernimmst die Schicht ' || coalesce(v_what, '?') || ' von ' || v_req || '.');
  elsif old.status = 'pending' and new.status = 'rejected' then
    perform private.notify_user(new.requester_id, 'swap', 'Tausch abgelehnt',
      'Schicht ' || coalesce(v_what, '?') || coalesce(' – ' || nullif(new.decision_note, 'per Telegram'), ''));
    if old.target_accepted_at is not null then
      perform private.notify_user(new.target_user_id, 'swap', 'Tausch abgelehnt', 'Schicht ' || coalesce(v_what, '?') || ' von ' || v_req || '.');
    end if;
  end if;
  return null;
end $$;

drop trigger if exists inform on public.swap_requests;
create trigger inform after insert or update on public.swap_requests
  for each row execute function private.swap_requests_inform();

-- ---------------- Dienstplan: eigene kommende Schichten ----------------
create or replace function private.shifts_inform() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  r    public.shifts;
  v_op text;
begin
  -- Folgeänderungen (Tausch, Aushilfsschicht beim Stempeln) und Importe melden sich nicht
  if pg_trigger_depth() > 1 or current_setting('clockin.silent', true) = 'on' then
    return null;
  end if;
  if tg_op = 'DELETE' then r := old; v_op := 'entfernt';
  elsif tg_op = 'INSERT' then r := new; v_op := 'neu';
  else
    r := new; v_op := 'geändert';
    if (new.user_id, new.starts_at, new.ends_at, new.location_id, new.shift_type)
       is not distinct from (old.user_id, old.starts_at, old.ends_at, old.location_id, old.shift_type) then
      return null;
    end if;
    if new.user_id is distinct from old.user_id and old.starts_at > now() then
      perform private.notify_user(old.user_id, 'plan', 'Dienstplan geändert',
        private.fmt_shift(old.starts_at, old.ends_at) || ' – nicht mehr bei dir eingetragen.', old.shift_date::text);
    end if;
  end if;
  if r.import_source is not null or r.starts_at <= now() or r.starts_at > now() + interval '60 days' then
    return null;
  end if;
  perform private.notify_user(r.user_id, 'plan', 'Dienstplan geändert',
    case r.shift_type::text when 'work' then 'Schicht' when 'vocational_school' then 'Schule' when 'vacation' then 'Urlaub'
                            when 'sick' then 'Krank' else 'Frei' end
    || ' ' || private.fmt_shift(r.starts_at, r.ends_at) || ' – ' || v_op || '. Bitte Dienstplan ansehen.',
    r.shift_date::text);
  return null;
end $$;

drop trigger if exists inform on public.shifts;
create trigger inform after insert or update or delete on public.shifts
  for each row execute function private.shifts_inform();

-- ---------------- Nachträge und Überstunden ----------------
create or replace function private.time_logs_inform() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_when text := to_char(new.recorded_at at time zone 'Europe/Berlin', 'DD.MM. HH24:MI');
begin
  if old.approval_status = 'pending' and new.approval_status in ('approved', 'rejected')
     and new.review_note is distinct from 'Handy freigegeben' then
    perform private.notify_user(new.user_id, 'booking',
      case when new.approval_status = 'approved' then 'Buchung freigegeben' else 'Buchung abgelehnt' end,
      'Buchung vom ' || v_when || coalesce(' – ' || new.review_note, ''));
  end if;
  if old.overtime_status = 'pending' and new.overtime_status in ('approved', 'rejected') then
    perform private.notify_user(new.user_id, 'overtime',
      case when new.overtime_status = 'approved' then 'Überstunden freigegeben' else 'Überstunden abgelehnt' end,
      'Gehen am ' || v_when || coalesce(' – ' || new.review_note, ''));
  end if;
  return null;
end $$;

drop trigger if exists inform on public.time_logs;
create trigger inform after update on public.time_logs
  for each row execute function private.time_logs_inform();

revoke execute on all functions in schema private from public;
grant execute on all functions in schema private to authenticated, service_role;
