-- =============================================================================
-- Clock-In · Tag korrigieren (Admin) · mehrere Handys je Person erlauben
-- =============================================================================
-- * Admins können die Stempelungen eines Tages komplett neu erfassen: alle Buchungen des Tages werden
--   gelöscht und die neuen (Kommen/Pause/Gehen) in einem Schritt eingetragen – geprüfte Reihenfolge,
--   Grund Pflicht, alles im Änderungsprotokoll (audit_log). Pausen, Schicht-Zuordnung, Überstunden
--   rechnet die Datenbank danach wie bei normalen Stempelungen. Keine Telegram-Meldung je Buchung.
-- * Nachtragen durch Admins ohne 7-Tage-Grenze (Studioleitung weiter höchstens 7 Tage, mit Freigabe).
-- * users.any_phone: Person darf mit verschiedenen Handys/Browsern stempeln, ohne Freigabe.
-- (Mehrfach ausführbar.)
-- =============================================================================

alter table public.users add column if not exists any_phone boolean not null default false;

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
  elsif not exists (select 1 from public.stamp_phones where user_id = o_user and key_hash = v_hash)
        and not coalesce((select u.any_phone from public.users u where u.id = o_user), false) then
    -- anderes Handy/Browser (z. B. iPhone: Kamera-Scan öffnet Safari statt der App) → Buchung zur Freigabe
    -- (außer ein Admin hat für die Person „mehrere Handys erlauben“ eingeschaltet)
    o_unverified := true;
  end if;
end $$;

-- Nachtrag: Admin ohne Zeitgrenze in die Vergangenheit, Studioleitung höchstens 7 Tage
drop policy if exists time_logs_insert_manual on public.time_logs;
create policy time_logs_insert_manual on public.time_logs for insert to authenticated
  with check (
    source = 'manual' and kiosk_device_id is null
    and recorded_at <= now() + interval '5 minutes'
    and ((select private.is_admin())
         or (private.may_backdate(location_id) and recorded_at >= now() - interval '7 days'))
  );

-- Telegram-Meldung je Buchung – beim Neu-Erfassen eines Tages stumm (clockin.silent)
create or replace function private.notify_time_log() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_url    text;
  v_secret text;
begin
  if current_setting('clockin.silent', true) = 'on' then
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

-- Tag neu erfassen: p_events = [{"event": "clock_in", "at": "2026-10-19T07:00:00Z"}, …] (leer = Tag löschen)
create or replace function public.replace_day_logs(p_user uuid, p_day date, p_location uuid, p_events jsonb, p_note text)
returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_from  timestamptz := private.berlin_day_start(p_day);
  v_to    timestamptz := private.berlin_day_start(p_day + 1);
  v_state text := 'out';
  v_last  timestamptz;
  v_ev    jsonb;
  v_type  text;
  v_at    timestamptz;
  v_count integer := 0;
begin
  if not private.is_admin() then
    raise exception 'Nur Admins können Stempelzeiten neu erfassen.' using errcode = '42501';
  end if;
  if coalesce(length(trim(p_note)), 0) < 3 then
    raise exception 'Bitte einen Grund angeben (mind. 3 Zeichen).';
  end if;
  if jsonb_typeof(coalesce(p_events, '[]'::jsonb)) <> 'array' or jsonb_array_length(coalesce(p_events, '[]'::jsonb)) > 20 then
    raise exception 'Ungültige Buchungen.';
  end if;
  if jsonb_array_length(coalesce(p_events, '[]'::jsonb)) > 0
     and not exists (select 1 from public.locations where id = p_location) then
    raise exception 'Bitte ein Studio wählen.';
  end if;

  -- Reihenfolge prüfen: Kommen → (Pause Start → Pause Ende)* → Gehen, Zeiten aufsteigend, alles an diesem Tag
  for v_ev in select * from jsonb_array_elements(coalesce(p_events, '[]'::jsonb)) loop
    v_type := v_ev ->> 'event';
    v_at := (v_ev ->> 'at')::timestamptz;
    if v_at < v_from or v_at >= v_to then
      raise exception 'Alle Zeiten müssen am % liegen.', to_char(p_day, 'DD.MM.YYYY');
    end if;
    if v_at > now() + interval '5 minutes' then
      raise exception 'Zeiten in der Zukunft sind nicht möglich.';
    end if;
    if v_last is not null and v_at <= v_last then
      raise exception 'Die Zeiten müssen aufsteigend sein (%).', to_char(v_at at time zone 'Europe/Berlin', 'HH24:MI');
    end if;
    v_state := case
      when v_state = 'out'   and v_type = 'clock_in'    then 'in'
      when v_state = 'in'    and v_type = 'break_start' then 'break'
      when v_state = 'break' and v_type = 'break_end'   then 'in'
      when v_state = 'in'    and v_type = 'clock_out'   then 'out'
      else null end;
    if v_state is null then
      raise exception 'Reihenfolge stimmt nicht bei % Uhr: Kommen → Pause Start → Pause Ende → Gehen.',
        to_char(v_at at time zone 'Europe/Berlin', 'HH24:MI');
    end if;
    v_last := v_at;
  end loop;
  if v_state = 'break' or (v_state = 'in' and p_day < (now() at time zone 'Europe/Berlin')::date) then
    raise exception 'Am Ende fehlt noch „Gehen“ (bzw. „Pause Ende“).';
  end if;

  perform set_config('clockin.silent', 'on', true);
  delete from public.time_logs where user_id = p_user and recorded_at >= v_from and recorded_at < v_to;
  for v_ev in select * from jsonb_array_elements(coalesce(p_events, '[]'::jsonb)) loop
    insert into public.time_logs (user_id, location_id, event_type, recorded_at, source, note)
    values (p_user, p_location, (v_ev ->> 'event')::public.time_event_type, (v_ev ->> 'at')::timestamptz, 'manual',
            'Korrigiert: ' || trim(p_note));
    v_count := v_count + 1;
  end loop;
  perform set_config('clockin.silent', 'off', true);
  return v_count;
end $$;
revoke execute on function public.replace_day_logs(uuid, date, uuid, jsonb, text) from public, anon;
grant execute on function public.replace_day_logs(uuid, date, uuid, jsonb, text) to authenticated;

revoke execute on all functions in schema private from public;
grant execute on all functions in schema private to authenticated, service_role;
