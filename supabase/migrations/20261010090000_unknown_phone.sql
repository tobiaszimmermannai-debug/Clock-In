-- =============================================================================
-- Clock-In · Anderes Handy: Buchung zur Freigabe statt Sperre
-- =============================================================================
-- Der Handy-Schlüssel liegt im Browser-Speicher. Beim iPhone haben die installierte App und Safari
-- (Kamera-Scan) getrennten Speicher; eine andere App-Adresse hat ebenfalls eigenen Speicher. Dann
-- wirkt das Handy „neu“. Statt zu sperren: Buchung wird gespeichert, wartet aber auf Freigabe
-- (Telegram ✅/❌ oder Verwaltung → Freigaben). Mit ✅ zählt sie und dieses Handy/dieser Browser wird
-- für die Person gemerkt (mehrere möglich); weitere offene Buchungen davon werden mit freigegeben.
-- Ein Handy, das einer anderen Person gehört, bleibt gesperrt. (Mehrfach ausführbar.)
-- =============================================================================

-- Mehrere Handys/Browser je Person
alter table public.stamp_phones drop constraint if exists stamp_phones_pkey;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'stamp_phones_key_pkey') then
    alter table public.stamp_phones add constraint stamp_phones_key_pkey primary key (key_hash);
  end if;
end $$;
create index if not exists stamp_phones_user_idx on public.stamp_phones (user_id);

alter table public.time_logs
  add column if not exists device_unverified boolean not null default false,
  add column if not exists device_key_hash text;

create or replace function private.time_logs_approval() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_me    uuid := private.current_user_id();
  v_today date := (now() at time zone 'Europe/Berlin')::date;
begin
  -- System / Service-Role (Auto-Checkout, Freigabe per Telegram-Bot): Werte wie übergeben
  if auth.uid() is null then
    if tg_op = 'UPDATE' and new.approval_status is distinct from old.approval_status then
      new.reviewed_at := now();
    end if;
    return new;
  end if;

  if tg_op = 'INSERT' then
    new.created_by  := v_me;
    new.reviewed_by := null;
    new.reviewed_at := null;
    new.review_note := null;
    if new.source = 'manual' and private.is_admin() then
      new.approval_status := 'approved';            -- Nachtrag Admin: sofort gültig
      new.reviewed_by := v_me;
      new.reviewed_at := now();
    elsif new.source = 'manual'
       or (new.recorded_at at time zone 'Europe/Berlin')::date < v_today then
      new.approval_status := 'pending';             -- Nachtrag Leitung / Offline-Sync vom Vortag
    elsif new.device_unverified then
      new.approval_status := 'pending';             -- anderes Handy/Browser: erst nach Freigabe
    else
      new.approval_status := 'approved';            -- Kiosk, selber Tag
    end if;
    return new;
  end if;

  -- UPDATE (per RLS nur Admin): Freigabe/Ablehnung protokollieren
  if new.approval_status is distinct from old.approval_status then
    new.reviewed_by := v_me;
    new.reviewed_at := now();
  end if;
  return new;
end $$;

drop function if exists private.stamp_context(text, text);
create function private.stamp_context(
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

create or replace function public.stamp_check(p_token text, p_phone_key text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_ctx   record;
  v_state record;
begin
  select * into v_ctx from private.stamp_context(p_token, p_phone_key);
  select * into v_state from private.stamp_state(v_ctx.o_user);
  return jsonb_build_object(
    'location', (select name from public.locations where id = v_ctx.o_location),
    'state', v_state.o_state, 'since', v_state.o_since, 'registered', v_ctx.o_registered,
    'unverified', v_ctx.o_unverified);
end $$;

create or replace function public.stamp(p_token text, p_event public.time_event_type, p_phone_key text) returns jsonb
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

  insert into public.time_logs (user_id, location_id, event_type, recorded_at, source, kiosk_device_id,
                                device_unverified, device_key_hash)
  values (v_ctx.o_user, v_ctx.o_location, p_event, now(), 'kiosk', v_ctx.o_device,
          v_ctx.o_unverified, case when v_ctx.o_unverified then v_ctx.o_key_hash end)
  returning * into v_log;

  return jsonb_build_object(
    'id', v_log.id, 'event_type', v_log.event_type, 'recorded_at', v_log.recorded_at,
    'pending', v_log.approval_status = 'pending',
    'location', (select name from public.locations where id = v_ctx.o_location));
end $$;

-- Freigabe einer „anderes Handy“-Buchung → Handy merken, weitere offene Buchungen davon freigeben
create or replace function private.time_logs_trust_device() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.approval_status = 'approved' and old.approval_status = 'pending'
     and new.device_unverified and new.device_key_hash is not null and new.source = 'kiosk' then
    insert into public.stamp_phones (user_id, key_hash) values (new.user_id, new.device_key_hash)
    on conflict do nothing;
    if pg_trigger_depth() = 1 then
      update public.time_logs
         set approval_status = 'approved', review_note = 'Handy freigegeben'
       where user_id = new.user_id and device_key_hash = new.device_key_hash
         and approval_status = 'pending' and id <> new.id;
    end if;
  end if;
  return null;
end $$;
drop trigger if exists trust_device on public.time_logs;
create trigger trust_device after update of approval_status on public.time_logs
  for each row execute function private.time_logs_trust_device();

revoke execute on function public.stamp_check(text, text) from public, anon;
revoke execute on function public.stamp(text, public.time_event_type, text) from public, anon;
grant execute on function public.stamp_check(text, text) to authenticated;
grant execute on function public.stamp(text, public.time_event_type, text) to authenticated;
revoke execute on all functions in schema private from public;
grant execute on all functions in schema private to authenticated, service_role;
