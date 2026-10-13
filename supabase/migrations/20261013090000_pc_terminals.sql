-- =============================================================================
-- Clock-In · PC als zweites Terminal je Studio · Stempeln nur mit dem eigenen Handy
-- =============================================================================
-- * Am PC die App öffnen → „PC als Terminal einrichten“ → mit dem eigenen Clock-In-Zugang anmelden, Studio
--   wählen → Anfrage. Tobias/Dominik sagen per Telegram-Button (oder in Einstellungen) „Ja, passt“ – dann
--   legt die Telegram-Function das Terminal-Konto an und der PC zeigt den QR-Code wie das Tablet.
--   Die persönliche Anmeldung am PC wird direkt nach der Anfrage wieder beendet.
-- * Stempeln nur noch vom Handy (Browser-Kennung „Mobile“/iPhone): Am Studio-PC oder -Tablet – auch per
--   Kamera auf den QR-Code des anderen Geräts – geht es nicht. Jeder nimmt sein eigenes Handy.
-- (Mehrfach ausführbar.)
-- =============================================================================

alter table public.kiosk_devices add column if not exists kind text not null default 'tablet';
alter table public.kiosk_devices drop constraint if exists kiosk_devices_kind;
alter table public.kiosk_devices add constraint kiosk_devices_kind check (kind in ('tablet', 'pc'));

-- Anfragen: Passwort nur bis zum Anlegen des Kontos, danach gelöscht. Kein direkter Zugriff (nur Funktionen).
create table if not exists public.terminal_requests (
  id           uuid primary key default gen_random_uuid(),
  name         text not null check (length(name) between 2 and 40),
  location_id  uuid not null references public.locations (id) on delete cascade,
  requested_by uuid references public.users (id) on delete set null,
  secret_hash  text not null,
  password     text,
  status       text not null default 'pending' check (status in ('pending', 'approved', 'ready', 'rejected')),
  username     text,
  device_id    uuid references public.kiosk_devices (id) on delete set null,
  decided_by   uuid references public.users (id) on delete set null,
  created_at   timestamptz not null default now(),
  decided_at   timestamptz
);
alter table public.terminal_requests enable row level security;
revoke all on public.terminal_requests from anon, authenticated;

-- Handy? (Browser-Kennung; ohne Kennung nicht sperren)
create or replace function private.is_phone() returns boolean
language sql stable set search_path = '' as $$
  select coalesce(lower(nullif(current_setting('request.headers', true), '')::jsonb ->> 'user-agent'), '') ~ '(mobi|iphone|ipod)'
      or coalesce(nullif(current_setting('request.headers', true), '')::jsonb ->> 'user-agent', '') = ''
$$;

create or replace function private.stamp_context(
  p_token text, p_phone_key text,
  out o_device uuid, out o_location uuid, out o_user uuid, out o_registered boolean,
  out o_unverified boolean, out o_key_hash text)
language plpgsql security definer set search_path = '' as $$
declare
  v_net    cidr := private.client_network();
  v_hash   text;
  v_tablet text;
begin
  o_user := private.current_user_id();
  if o_user is null or not exists (select 1 from public.users where id = o_user and is_active) then
    raise exception 'Bitte im Mitarbeiter-Portal anmelden.';
  end if;
  -- nur mit dem eigenen Handy – nicht am Studio-PC oder -Tablet (auch nicht mit deren Kamera)
  if not private.is_phone() then
    raise exception 'Stempeln geht nur mit deinem eigenen Handy – nicht am PC oder Tablet. (Am Handy? Dann im Browser „Desktop-Version“ ausschalten.)';
  end if;

  select q.device_id, q.location_id into o_device, o_location
  from public.kiosk_qr q
  join public.kiosk_devices k on k.id = q.device_id and k.is_active
  where (q.token = p_token and q.issued_at > now() - interval '90 seconds')
     or (q.prev_token = p_token and q.issued_at > now() - interval '30 seconds');
  if o_device is null then
    raise exception 'QR-Code abgelaufen – bitte den aktuellen Code am Tablet scannen.';
  end if;

  if v_net is null or not exists (
       select 1 from public.kiosk_networks n
       where n.device_id = o_device and private.same_network(n.network, v_net)
         and n.last_seen_at > now() - interval '12 hours') then
    select string_agg(host(n.network), ', ' order by n.last_seen_at desc) into v_tablet
    from public.kiosk_networks n where n.device_id = o_device and n.last_seen_at > now() - interval '12 hours';
    raise exception 'Dein Handy ist nicht im WLAN des Studios. Bitte mit dem Studio-WLAN verbinden (mobile Daten aus) und erneut scannen. [Handy %, Tablet %]',
      coalesce(host(v_net), '?'), coalesce(v_tablet, '?');
  end if;

  if coalesce(length(p_phone_key), 0) < 32 then
    raise exception 'Ungültiger Geräteschlüssel.';
  end if;
  v_hash := encode(extensions.digest(p_phone_key, 'sha256'), 'hex');
  o_key_hash := v_hash;
  o_registered := false;
  o_unverified := false;
  if exists (select 1 from public.stamp_phones where key_hash = v_hash and user_id <> o_user) then
    raise exception 'Dieses Handy ist bereits für eine andere Person registriert. Bitte mit deinem eigenen Handy stempeln.';
  end if;
  if not exists (select 1 from public.stamp_phones where user_id = o_user) then
    -- erstes Handy: automatisch registrieren, Admins bekommen eine Meldung
    insert into public.stamp_phones (user_id, key_hash) values (o_user, v_hash);
    o_registered := true;
    perform private.call_telegram(jsonb_build_object(
      'type', 'phone_registered',
      'name', (select first_name || ' ' || last_name from public.users where id = o_user),
      'location', (select name from public.locations where id = o_location)));
  elsif not exists (select 1 from public.stamp_phones where user_id = o_user and key_hash = v_hash) then
    -- anderes Handy/Browser (z. B. iPhone: Kamera-Scan öffnet Safari statt der App) → Buchung zur Freigabe
    o_unverified := true;
  end if;
end $$;

-- PC fragt an (angemeldete Person, egal welche Rolle); Admins bekommen die Anfrage per Telegram
create or replace function public.request_terminal(p_name text, p_location_id uuid, p_secret text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_me uuid := private.current_user_id();
  v_id uuid;
begin
  if v_me is null or not exists (select 1 from public.users where id = v_me and is_active) then
    raise exception 'Bitte mit deinem Clock-In-Zugang anmelden.';
  end if;
  if coalesce(length(p_secret), 0) < 32 then
    raise exception 'Ungültiger Geräteschlüssel.';
  end if;
  if not exists (select 1 from public.locations where id = p_location_id and is_active) then
    raise exception 'Studio nicht gefunden.';
  end if;
  if (select count(*) from public.terminal_requests where status = 'pending' and created_at > now() - interval '1 day') >= 10 then
    raise exception 'Zu viele offene Anfragen – bitte erst freigeben oder ablehnen lassen.';
  end if;
  insert into public.terminal_requests (name, location_id, requested_by, secret_hash, password)
  values (trim(p_name), p_location_id, v_me, encode(extensions.digest(p_secret, 'sha256'), 'hex'), p_secret)
  returning id into v_id;
  perform private.call_telegram(jsonb_build_object('type', 'terminal_request', 'id', v_id));
  return v_id;
end $$;
revoke execute on function public.request_terminal(text, uuid, text) from public, anon;
grant execute on function public.request_terminal(text, uuid, text) to authenticated;

-- PC fragt nach (ohne Anmeldung, nur mit seinem Schlüssel)
create or replace function public.terminal_request_status(p_id uuid, p_secret text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('status', r.status, 'username', case when r.status = 'ready' then r.username end,
                            'location', l.name, 'name', r.name)
  from public.terminal_requests r join public.locations l on l.id = r.location_id
  where r.id = p_id and r.secret_hash = encode(extensions.digest(coalesce(p_secret, ''), 'sha256'), 'hex')
$$;
revoke execute on function public.terminal_request_status(uuid, text) from public;
grant execute on function public.terminal_request_status(uuid, text) to anon, authenticated;

-- Offene Anfragen (Admin, Einstellungen)
create or replace function public.open_terminal_requests()
returns table (id uuid, name text, location_id uuid, location_name text, requested_by text, created_at timestamptz, status text)
language sql stable security definer set search_path = '' as $$
  select r.id, r.name, r.location_id, l.name, u.first_name || ' ' || u.last_name, r.created_at, r.status
  from public.terminal_requests r
  join public.locations l on l.id = r.location_id
  left join public.users u on u.id = r.requested_by
  where private.is_admin() and r.status in ('pending', 'approved') and r.created_at > now() - interval '7 days'
  order by r.created_at
$$;
revoke execute on function public.open_terminal_requests() from public, anon;
grant execute on function public.open_terminal_requests() to authenticated;

-- Admin entscheidet in der App: Ja → Konto legt die Telegram-Function an; Nein → Anfrage verworfen
create or replace function public.decide_terminal_request(p_id uuid, p_approve boolean) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not private.is_admin() then
    raise exception 'Nur Admins können Terminals freigeben.' using errcode = '42501';
  end if;
  update public.terminal_requests
     set status = case when p_approve then 'approved' else 'rejected' end,
         password = case when p_approve then password end,
         decided_by = private.current_user_id(), decided_at = now()
   where id = p_id and status = 'pending';
  if not found then
    raise exception 'Anfrage ist schon entschieden.';
  end if;
  if p_approve then
    perform private.call_telegram(jsonb_build_object('type', 'terminal_create', 'id', p_id));
  end if;
end $$;
revoke execute on function public.decide_terminal_request(uuid, boolean) from public, anon;
grant execute on function public.decide_terminal_request(uuid, boolean) to authenticated;

revoke execute on all functions in schema private from public;
grant execute on all functions in schema private to authenticated, service_role;
