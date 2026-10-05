-- =============================================================================
-- Clock-In · Stempeln mit Handy + Tablet (ersetzt die Gesichtserkennung)
-- =============================================================================
-- Zwei Faktoren je Buchung:
--   1. das eigene, registrierte Handy des Mitarbeiters (angemeldet im Portal)
--   2. der QR-Code am Tablet vor Ort – wechselt alle 30 Sek., also nur vor Ort lesbar
-- Zusätzlich muss das Handy im selben Netz (Studio-WLAN) sein wie das Tablet:
-- verglichen wird die öffentliche Adresse (IPv4 bzw. IPv6-/64-Präfix), mit der beide
-- bei Supabase ankommen. Browser können den WLAN-Namen nicht auslesen.
-- =============================================================================

-- Gesichtserkennung wird nicht mehr genutzt → Einwilligungen beenden, Gesichtsdaten löschen
update public.biometric_consents set revoked_at = now() where revoked_at is null;
delete from public.face_embeddings;

-- Aktueller QR-Code je Tablet (eigene Tabelle: kein Audit-Eintrag alle 30 Sek.)
create table public.kiosk_qr (
  device_id    uuid primary key references public.kiosk_devices (id) on delete cascade,
  token        text not null,
  prev_token   text,
  issued_at    timestamptz not null default now(),
  location_id  uuid not null references public.locations (id) on delete cascade,
  last_seen_at timestamptz not null default now()
);

-- Netze, in denen ein Tablet online war (öffentliche IPv4 /32 bzw. IPv6 /64)
create table public.kiosk_networks (
  device_id    uuid not null references public.kiosk_devices (id) on delete cascade,
  network      cidr not null,
  last_seen_at timestamptz not null default now(),
  primary key (device_id, network)
);

-- Registriertes Stempel-Handy je Mitarbeiter (nur Hash des Geräteschlüssels).
-- Ein Konto stempelt nur mit seinem Handy, ein Handy gehört nur zu einem Konto:
-- Kollegen können niemanden mit dem eigenen Handy einstempeln.
create table public.stamp_phones (
  user_id       uuid primary key references public.users (id) on delete cascade,
  key_hash      text not null unique,
  registered_at timestamptz not null default now()
);

alter table public.kiosk_qr       enable row level security;
alter table public.kiosk_networks enable row level security;
alter table public.stamp_phones   enable row level security;

create policy kiosk_qr_select on public.kiosk_qr for select to authenticated
  using ((select private.is_admin()));
create policy kiosk_networks_select on public.kiosk_networks for select to authenticated
  using ((select private.is_admin()));
-- Handy-Registrierung: sehen die Person selbst und ihre Leitung; zurücksetzen nur Leitung/Admin
create policy stamp_phones_select on public.stamp_phones for select to authenticated
  using (user_id = (select private.current_user_id()) or private.manages_user(user_id));
create policy stamp_phones_delete on public.stamp_phones for delete to authenticated
  using (private.manages_user(user_id));

revoke all on public.kiosk_qr, public.kiosk_networks, public.stamp_phones from anon;
revoke insert, update, delete, truncate on public.kiosk_qr, public.kiosk_networks from authenticated;
revoke insert, update, truncate on public.stamp_phones from authenticated;

create trigger audit after insert or delete on public.stamp_phones
  for each row execute function private.audit_changes();


-- Öffentliche Adresse des Aufrufers als Netz (IPv4 /32, IPv6 /64)
create function private.client_network() returns cidr
language plpgsql stable set search_path = '' as $$
declare
  v_headers jsonb := coalesce(nullif(current_setting('request.headers', true), '')::jsonb, '{}'::jsonb);
  v_ip      inet;
begin
  begin
    v_ip := trim(coalesce(
      v_headers ->> 'cf-connecting-ip',
      v_headers ->> 'x-real-ip',
      split_part(v_headers ->> 'x-forwarded-for', ',', 1)))::inet;
  exception when others then
    return null;
  end;
  return network(set_masklen(v_ip, case when family(v_ip) = 6 then 64 else 32 end));
end $$;

-- Tablet meldet sich alle paar Sekunden: Netz merken, QR-Code erneuern,
-- neue Buchungen an diesem Tablet zurückgeben (für die Begrüßung am Bildschirm)
create function public.kiosk_ping(p_location_id uuid default null, p_since timestamptz default null)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_device public.kiosk_devices;
  v_net    cidr := private.client_network();
  v_loc    uuid;
  v_qr     public.kiosk_qr;
  v_recent jsonb;
begin
  select * into v_device from public.kiosk_devices where auth_user_id = auth.uid() and is_active;
  if not found then
    raise exception 'Dieses Konto ist kein aktives Tablet.';
  end if;
  v_loc := coalesce(v_device.location_id, p_location_id);
  if not exists (select 1 from public.locations where id = v_loc and is_active) then
    raise exception 'Bitte am Tablet ein Studio wählen.';
  end if;

  if v_net is not null then
    insert into public.kiosk_networks (device_id, network) values (v_device.id, v_net)
    on conflict (device_id, network) do update set last_seen_at = now()
      where public.kiosk_networks.last_seen_at < now() - interval '1 minute';
  end if;

  select * into v_qr from public.kiosk_qr where device_id = v_device.id;
  if not found or v_qr.issued_at < now() - interval '30 seconds' or v_qr.location_id <> v_loc then
    insert into public.kiosk_qr (device_id, token, prev_token, issued_at, location_id, last_seen_at)
    values (v_device.id, encode(extensions.gen_random_bytes(12), 'hex'), null, now(), v_loc, now())
    on conflict (device_id) do update
      set prev_token = public.kiosk_qr.token, token = excluded.token, issued_at = now(),
          location_id = excluded.location_id, last_seen_at = now()
    returning * into v_qr;
  elsif v_qr.last_seen_at < now() - interval '1 minute' then
    update public.kiosk_qr set last_seen_at = now() where device_id = v_device.id;
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'first_name', u.first_name, 'event_type', t.event_type, 'recorded_at', t.recorded_at)
           order by t.received_at), '[]'::jsonb)
    into v_recent
  from public.time_logs t
  join public.users u on u.id = t.user_id
  where t.kiosk_device_id = v_device.id
    and t.received_at > greatest(coalesce(p_since, now()), now() - interval '1 minute');

  return jsonb_build_object('token', v_qr.token, 'location_id', v_loc, 'now', now(), 'recent', v_recent);
end $$;

-- Gemeinsame Prüfung für Handy-Stempelungen: Anmeldung, QR-Code, Netz, registriertes Handy
create function private.stamp_context(
  p_token text, p_phone_key text,
  out o_device uuid, out o_location uuid, out o_user uuid, out o_registered boolean)
language plpgsql security definer set search_path = '' as $$
declare
  v_net    cidr := private.client_network();
  v_hash   text;
  v_known  text;
  v_tablet text;
begin
  o_user := private.current_user_id();
  if o_user is null or not exists (select 1 from public.users where id = o_user and is_active) then
    raise exception 'Bitte im Mitarbeiter-Portal anmelden.';
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
       where n.device_id = o_device and n.network = v_net and n.last_seen_at > now() - interval '12 hours') then
    select string_agg(host(n.network), ', ' order by n.last_seen_at desc) into v_tablet
    from public.kiosk_networks n where n.device_id = o_device and n.last_seen_at > now() - interval '12 hours';
    raise exception 'Dein Handy ist nicht im WLAN des Studios. Bitte mit dem Studio-WLAN verbinden (mobile Daten aus) und erneut scannen. [Handy %, Tablet %]',
      coalesce(host(v_net), '?'), coalesce(v_tablet, '?');
  end if;

  if coalesce(length(p_phone_key), 0) < 32 then
    raise exception 'Ungültiger Geräteschlüssel.';
  end if;
  v_hash := encode(extensions.digest(p_phone_key, 'sha256'), 'hex');
  select key_hash into v_known from public.stamp_phones where user_id = o_user;
  o_registered := false;
  if v_known is null then
    if exists (select 1 from public.stamp_phones where key_hash = v_hash) then
      raise exception 'Dieses Handy ist bereits für eine andere Person registriert. Bitte mit deinem eigenen Handy stempeln.';
    end if;
    insert into public.stamp_phones (user_id, key_hash) values (o_user, v_hash);
    o_registered := true;
    perform private.call_telegram(jsonb_build_object(
      'type', 'phone_registered',
      'name', (select first_name || ' ' || last_name from public.users where id = o_user),
      'location', (select name from public.locations where id = o_location)));
  elsif v_known <> v_hash then
    raise exception 'Stempeln geht nur mit deinem registrierten Handy. Neues Handy? Bitte Tobias oder Dominik, die Registrierung zurückzusetzen.';
  end if;
end $$;

-- Aktueller Stempelstatus: out / in / break (ältere offene Zustände gelten als vergessen)
create function private.stamp_state(p_user uuid, out o_state text, out o_since timestamptz)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_last public.time_logs;
begin
  select * into v_last from public.time_logs t
  where t.user_id = p_user and t.approval_status <> 'rejected' and t.recorded_at > now() - interval '16 hours'
  order by t.recorded_at desc limit 1;
  o_state := case v_last.event_type when 'clock_in' then 'in' when 'break_end' then 'in'
                                    when 'break_start' then 'break' else 'out' end;
  o_since := case when o_state <> 'out' then v_last.recorded_at end;
end $$;

-- Nach dem Scannen: prüfen (und Handy beim ersten Mal registrieren), Status zurückgeben
create function public.stamp_check(p_token text, p_phone_key text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_ctx   record;
  v_state record;
begin
  select * into v_ctx from private.stamp_context(p_token, p_phone_key);
  select * into v_state from private.stamp_state(v_ctx.o_user);
  return jsonb_build_object(
    'location', (select name from public.locations where id = v_ctx.o_location),
    'state', v_state.o_state, 'since', v_state.o_since, 'registered', v_ctx.o_registered);
end $$;

-- Buchen: Kommen / Pause Start / Pause Ende / Gehen – Zeitpunkt setzt der Server
create function public.stamp(p_token text, p_event public.time_event_type, p_phone_key text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_ctx   record;
  v_state record;
  v_seit  text;
  v_log   public.time_logs;
begin
  select * into v_ctx from private.stamp_context(p_token, p_phone_key);
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

  insert into public.time_logs (user_id, location_id, event_type, recorded_at, source, kiosk_device_id)
  values (v_ctx.o_user, v_ctx.o_location, p_event, now(), 'kiosk', v_ctx.o_device)
  returning * into v_log;

  return jsonb_build_object(
    'id', v_log.id, 'event_type', v_log.event_type, 'recorded_at', v_log.recorded_at,
    'location', (select name from public.locations where id = v_ctx.o_location));
end $$;

revoke execute on function public.kiosk_ping(uuid, timestamptz) from public, anon;
revoke execute on function public.stamp_check(text, text) from public, anon;
revoke execute on function public.stamp(text, public.time_event_type, text) from public, anon;
grant execute on function public.kiosk_ping(uuid, timestamptz) to authenticated;
grant execute on function public.stamp_check(text, text) to authenticated;
grant execute on function public.stamp(text, public.time_event_type, text) to authenticated;

revoke execute on all functions in schema private from public;
grant execute on all functions in schema private to authenticated, service_role;
