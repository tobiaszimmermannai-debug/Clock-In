-- =============================================================================
-- Aufgaben · Tagesaufgaben mit Freigabe, Abwesenheiten aus dem Dienstplan, Telegram-Benachrichtigungen
-- =============================================================================
-- * note_day_plan(Tag): wer ist laut ClockIn-Dienstplan eingeplant und wer abwesend (Krank, Berufsschule,
--   Urlaub – Schicht beginnt am Berliner Kalendertag). Einzige Quelle für Abwesenheiten; liefert nur ja/nein,
--   nie den Grund. Sichtbar: selbst, betreute Personen (Leitung), Studio-PC für sein Studio, Server alles.
-- * Tagesaufgaben (props.__focus): Mitarbeiter tragen selbst ein → wartet auf Freigabe ("<Tag>:<Rang>:?");
--   Geschäftsführung/Studioleitung tragen direkt ein. note_focus_decide gibt frei oder lehnt ab.
-- * Neue Tagesaufgaben melden sich nach dem Speichern im Hintergrund bei der Edge Function "aufgaben"
--   (pg_net, wie die telegram-Funktion). Stündlicher Auslöser für die Tagesreminder (die Funktion prüft
--   selbst, ob in Berlin gerade 6/14/20 Uhr an einem Werktag ist).
-- (Mehrfach ausführbar.) Voraussetzung: 20261102090000_notes_streak_days.sql
-- =============================================================================

-- ---------------- Dienstplan des Tages ----------------
create or replace function public.note_day_plan(p_day date) returns table (user_id uuid, planned boolean, absent boolean)
language sql stable security definer set search_path = '' as $$
  with pc as (
    select k.location_id from public.kiosk_devices k
    where k.auth_user_id = (select auth.uid()) and k.is_active and k.kind = 'pc'
    limit 1
  ),
  visible as (
    select u.id, u.auth_user_id from public.users u
    where u.is_active
      and u.auth_user_id is not null
      and (
        (select auth.uid()) is null                      -- Server (service_role) bzw. SQL Editor
        or u.auth_user_id = (select auth.uid())
        or private.manages_user(u.id)
        or u.home_location_id = (select pc.location_id from pc)
      )
  ),
  day_shifts as (
    select s.user_id, s.shift_type::text as kind
    from public.shifts s
    where (s.starts_at at time zone 'Europe/Berlin')::date = p_day
  )
  select v.auth_user_id,
         exists (select 1 from day_shifts d where d.user_id = v.id and d.kind = 'work'),
         exists (select 1 from day_shifts d where d.user_id = v.id and d.kind in ('sick', 'vocational_school', 'vacation'))
  from visible v
  where exists (select 1 from day_shifts d where d.user_id = v.id and d.kind in ('work', 'sick', 'vocational_school', 'vacation'))
$$;

-- ---------------- Hintergrund-Aufruf der Edge Function ----------------
create or replace function private.call_aufgaben(p_body jsonb) returns void
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
    url     := v_url || '/aufgaben',
    body    := p_body,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-notify-secret', v_secret)
  );
exception when others then
  raise warning 'Aufgaben-Benachrichtigung fehlgeschlagen: %', sqlerrm;
end $$;

-- Leitung: Geschäftsführung (Admin mit 2FA) oder Studioleitung; ohne Anmeldung = Server/SQL Editor
create or replace function private.is_note_lead() returns boolean
language sql stable security definer set search_path = '' as $$
  select (select auth.uid()) is null or private.is_admin() or private.is_manager()
$$;

-- ---------------- Tagesaufgaben: Freigabe erzwingen ----------------
create or replace function private.note_pages_focus_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_new  jsonb := coalesce(new.props -> '__focus', '{}'::jsonb);
  v_old  jsonb := case when tg_op = 'UPDATE' then coalesce(old.props -> '__focus', '{}'::jsonb) else '{}'::jsonb end;
  v_lead boolean;
  v_out  jsonb := '{}'::jsonb;
  r      record;
  v_day  text;
  v_rank text;
  v_pend boolean;
  v_prev text;
begin
  if jsonb_typeof(v_new) <> 'object' or v_new = v_old then
    return new;
  end if;
  v_lead := private.is_note_lead();
  for r in select key, value from jsonb_each_text(v_new) loop
    v_day  := split_part(r.value, ':', 1);
    v_rank := split_part(r.value, ':', 2);
    v_pend := split_part(r.value, ':', 3) = '?';
    v_prev := v_old ->> r.key;
    if not v_lead then
      if v_prev is not null and split_part(v_prev, ':', 1) = v_day then
        v_pend := split_part(v_prev, ':', 3) = '?';   -- nur umsortiert: Freigabe-Stand bleibt
      else
        v_pend := true;                                -- neu von Mitarbeitern: wartet auf Freigabe
      end if;
    end if;
    v_out := v_out || jsonb_build_object(r.key, v_day || ':' || v_rank || case when v_pend then ':?' else '' end);
  end loop;
  new.props := jsonb_set(coalesce(new.props, '{}'::jsonb), '{__focus}', v_out);
  return new;
end $$;

drop trigger if exists note_pages_focus_guard on public.note_pages;
create trigger note_pages_focus_guard before insert or update of props on public.note_pages
  for each row execute function private.note_pages_focus_guard();

-- ---------------- Neue Tagesaufgabe melden (nur Neuanlagen) ----------------
create or replace function private.note_pages_focus_notify() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_new jsonb := coalesce(new.props -> '__focus', '{}'::jsonb);
  v_old jsonb := case when tg_op = 'UPDATE' then coalesce(old.props -> '__focus', '{}'::jsonb) else '{}'::jsonb end;
  r     record;
  v_prev text;
begin
  if jsonb_typeof(v_new) <> 'object' or v_new = v_old or new.deleted_at is not null then
    return null;
  end if;
  for r in select key, value from jsonb_each_text(v_new) loop
    v_prev := v_old ->> r.key;
    -- neu = vorher nicht angepinnt oder an einem anderen Tag; Umsortieren, Freigeben, Entfernen melden nichts
    if v_prev is null or split_part(v_prev, ':', 1) <> split_part(r.value, ':', 1) then
      perform private.call_aufgaben(jsonb_build_object(
        'action', 'focus_new',
        'page_id', new.id,
        'user_id', r.key,
        'day', split_part(r.value, ':', 1),
        'rank', split_part(r.value, ':', 2)::int,
        'pending', split_part(r.value, ':', 3) = '?',
        'actor', (select auth.uid())
      ));
    end if;
  end loop;
  return null;
end $$;

drop trigger if exists note_pages_focus_notify on public.note_pages;
create trigger note_pages_focus_notify after insert or update of props on public.note_pages
  for each row execute function private.note_pages_focus_notify();

-- ---------------- Freigeben / Ablehnen ----------------
-- App (Leitung) und Telegram-Knöpfe (über den Server) benutzen dieselbe Funktion.
create or replace function public.note_focus_decide(p_page uuid, p_user uuid, p_ok boolean) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_val text;
begin
  if not private.is_note_lead() then
    raise exception 'Nur die Leitung kann Tagesaufgaben freigeben' using errcode = '42501';
  end if;
  select props -> '__focus' ->> p_user::text into v_val from public.note_pages where id = p_page and deleted_at is null for update;
  if v_val is null then
    return 'gone';
  end if;
  if split_part(v_val, ':', 3) <> '?' then
    return 'already';
  end if;
  if p_ok then
    update public.note_pages
       set props = jsonb_set(props, array['__focus', p_user::text], to_jsonb(split_part(v_val, ':', 1) || ':' || split_part(v_val, ':', 2)))
     where id = p_page;
    return 'approved';
  end if;
  update public.note_pages set props = props #- array['__focus', p_user::text] where id = p_page;
  return 'rejected';
end $$;

-- ---------------- Reminder nur einmal je Tag und Art ----------------
create table if not exists public.note_notify_log (
  kind    text not null,
  day     date not null,
  sent_at timestamptz not null default now(),
  primary key (kind, day)
);
alter table public.note_notify_log enable row level security;   -- nur der Server (service_role) schreibt
revoke all on public.note_notify_log from anon, authenticated;

revoke execute on function private.call_aufgaben(jsonb), private.is_note_lead(), private.note_pages_focus_guard(), private.note_pages_focus_notify()
  from public, anon, authenticated;
revoke execute on function public.note_day_plan(date), public.note_focus_decide(uuid, uuid, boolean) from public, anon;
grant execute on function public.note_day_plan(date), public.note_focus_decide(uuid, uuid, boolean) to authenticated, service_role;

-- Stündlicher Auslöser (pg_cron, UTC) – die Funktion entscheidet nach Berliner Zeit
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    execute $job$select cron.schedule('aufgaben-hourly', '0 * * * *', $cmd$select private.call_aufgaben('{"action":"tick"}'::jsonb)$cmd$)$job$;
  end if;
end $$;
