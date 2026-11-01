-- =============================================================================
-- Clock-In · Weniger Logs und Datenverkehr (Supabase Free Plan)
-- =============================================================================
-- * Cron „clockin-staffing“: alle 5 Min. statt jede Minute und nur 6–22 Uhr Berliner Zeit
--   (UTC-Fenster 4–21 Uhr deckt Sommer- und Winterzeit ab; die Funktion prüft die Berliner Stunde).
--   Meldungen „Studio nicht besetzt“ / „nicht eingestempelt“ kommen dadurch höchstens ~5 Min. später;
--   doppelt kommt nichts (staffing_alerts / no_show_alerts merken sich, was schon gemeldet wurde).
-- * cron.job_run_details: täglicher Job löscht Einträge älter als 3 Tage.
-- * Tablet: kiosk_ping liefert den letzten Scan (scanned_at) – nach einem Scan fragt das Tablet kurz
--   schneller nach. Buchungen der letzten 3 Min. statt 1 Min. (Tablet pingt nachts nur jede Minute).
-- * Admin-Zähler: eine Abfrage (admin_open_counts) statt vier einzelner Zählungen.
-- (Mehrfach ausführbar.)
-- =============================================================================

alter table public.kiosk_qr add column if not exists scanned_at timestamptz;

-- Tablet-Ping
create or replace function public.kiosk_ping(p_location_id uuid default null, p_since timestamptz default null)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_device public.kiosk_devices;
  v_net    cidr := private.client_network();
  v_loc    uuid;
  v_qr     public.kiosk_qr;
  v_recent jsonb;
  v_grace  integer;
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

  -- on_time: Gehen spätestens zum Schichtende (+ Überstunden-Schwelle) → Tablet zeigt „Good Boy“
  select overtime_threshold_minutes into v_grace from public.rule_settings;
  select coalesce(jsonb_agg(jsonb_build_object(
           'first_name', u.first_name, 'event_type', t.event_type, 'recorded_at', t.recorded_at,
           'on_time', t.event_type = 'clock_out' and s.id is not null
                      and t.recorded_at <= s.ends_at + make_interval(mins => coalesce(v_grace, 5)))
           order by t.received_at), '[]'::jsonb)
    into v_recent
  from public.time_logs t
  join public.users u on u.id = t.user_id
  left join public.shifts s on s.id = t.shift_id
  where t.kiosk_device_id = v_device.id
    and t.received_at > greatest(coalesce(p_since, now()), now() - interval '3 minutes');

  return jsonb_build_object('token', v_qr.token, 'location_id', v_loc, 'now', now(), 'recent', v_recent,
                            'scanned_at', v_qr.scanned_at);
end $$;

-- Scan am Handy
create or replace function public.stamp_check(p_token text, p_phone_key text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_ctx   record;
  v_state record;
begin
  select * into v_ctx from private.stamp_context(p_token, p_phone_key);
  -- Scan merken: das Tablet fragt dann kurz schneller nach, damit die Begrüßung sofort erscheint
  update public.kiosk_qr set scanned_at = now() where device_id = v_ctx.o_device;
  select * into v_state from private.stamp_state(v_ctx.o_user);
  return jsonb_build_object(
    'location', (select name from public.locations where id = v_ctx.o_location),
    'state', v_state.o_state, 'since', v_state.o_since, 'registered', v_ctx.o_registered,
    'unverified', v_ctx.o_unverified);
end $$;

-- Minuten-Prüfungen: nur 6–22 Uhr Berliner Zeit und nicht am Sonntag
create or replace function private.minute_checks() returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_local timestamp := now() at time zone 'Europe/Berlin';
begin
  if extract(isodow from v_local) = 7 or extract(hour from v_local) not between 6 and 22 then
    return;
  end if;
  perform private.staffing_check();
  perform private.no_show_check();
end $$;

-- Offene Freigaben für die Navigation (Nachträge, Überstunden, früher gegangen, Schichttausch) in einer
-- Abfrage. security invoker: es zählt genau, was die angemeldete Person auch bisher sehen durfte (RLS).
create or replace function public.admin_open_counts() returns jsonb
language sql stable security invoker set search_path = '' as $$
  select jsonb_build_object(
    'approvals', (select count(*) from public.time_logs where approval_status = 'pending'),
    'overtime',  (select count(*) from public.time_logs where overtime_status = 'pending'),
    'early',     (select count(*) from public.time_logs where early_status = 'pending'),
    'swaps',     (select count(*) from public.swap_requests where status = 'pending'))
$$;
revoke execute on function public.admin_open_counts() from public, anon;
grant execute on function public.admin_open_counts() to authenticated;

revoke execute on all functions in schema private from public;
grant execute on all functions in schema private to authenticated, service_role;

-- Zeitpläne (pg_cron läuft in UTC)
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    execute $job$select cron.schedule('clockin-staffing', '*/5 4-21 * * *', 'select private.minute_checks()')$job$;
    execute $job$select cron.schedule('clockin-cron-cleanup', '17 3 * * *',
      $cmd$delete from cron.job_run_details where end_time < now() - interval '3 days'$cmd$)$job$;
  end if;
end $$;
