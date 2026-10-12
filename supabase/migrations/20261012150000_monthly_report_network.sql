-- =============================================================================
-- Clock-In · Netz-Check lockerer · Monatsübersicht per Mail
-- =============================================================================
-- * Stempeln per Handy: Handy und Tablet müssen nicht mehr exakt dieselbe öffentliche IPv4-Adresse haben,
--   es reicht derselbe Adressbereich (/16, z. B. 93.104.x.x). Grund: Anbieter wie M-net vergeben Adressen
--   aus einem gemeinsamen Pool (CGNAT) – Geräte im selben WLAN erscheinen dann mit verschiedenen Adressen.
--   IPv6 bleibt beim /64-Netz des Studios. Der QR-Code (90 Sek. gültig) bleibt der eigentliche Nachweis.
-- * Monatsübersicht: am 1. jedes Monats (7 Uhr) Mail an rule_settings.monthly_report_email mit Vormonat,
--   aktuellem und kommendem Monat – alle Schichten mit Zeiten, Abwesenheiten, Urlaub genommen/übrig.
--   Versand über die Telegram-Function (Resend, Secret RESEND_API_KEY).
-- (Mehrfach ausführbar.)
-- =============================================================================

-- Gleiches Netz? IPv4: gleicher /16-Bereich, IPv6: gleiches /64-Netz
create or replace function private.same_network(a cidr, b cidr) returns boolean
language sql immutable set search_path = '' as $$
  select family(a) = family(b)
     and set_masklen(a, case when family(a) = 4 then 16 else 64 end)
       = set_masklen(b, case when family(b) = 4 then 16 else 64 end)
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

alter table public.rule_settings
  add column if not exists monthly_report_email text default 'gf@bsnewfitness.de',
  add column if not exists monthly_report_hour integer not null default 7 check (monthly_report_hour between 0 and 23);

-- Daten der Monatsübersicht (nur Service-Role / Telegram-Function): p_month = 1. des aktuellen Monats
create or replace function public.monthly_report(p_month date)
returns jsonb
language sql stable security definer set search_path = '' as $$
  with bounds as (
    select (date_trunc('month', p_month) - interval '1 month')::date as d_from,
           (date_trunc('month', p_month) + interval '2 months')::date as d_to,
           (now() at time zone 'Europe/Berlin')::date as today
  ),
  people as (
    select u.id, u.first_name, u.last_name, u.role, l.name as studio, e.weekly_target_minutes
    from public.users u
    left join public.locations l on l.id = u.home_location_id
    left join public.employment_details e on e.user_id = u.id
    where u.is_active and u.role <> 'admin'
  ),
  entries as (
    select s.user_id, s.shift_type::text as type, s.starts_at, s.ends_at, s.note, s.is_acquisition,
           coalesce(s.is_herold, false) as is_herold, l.name as studio,
           (s.starts_at at time zone 'Europe/Berlin')::date as day
    from public.shifts s
    join people p on p.id = s.user_id
    left join public.locations l on l.id = s.location_id, bounds b
    where s.starts_at >= private.berlin_day_start(b.d_from) and s.starts_at < private.berlin_day_start(b.d_to)
  ),
  years as (
    select distinct extract(year from d)::integer as y
    from bounds b, generate_series(b.d_from, b.d_to - 1, interval '1 month') d
  ),
  vacation as (
    select p.id as user_id, y.y as year,
           coalesce(a.days, (select r.default_vacation_days from public.rule_settings r), 20) as allowance,
           count(distinct s.shift_date) filter (where s.shift_date <= b.today) as taken,
           count(distinct s.shift_date) filter (where s.shift_date > b.today) as planned
    from people p cross join years y cross join bounds b
    left join public.vacation_allowances a on a.user_id = p.id and a.year = y.y
    left join public.shifts s on s.user_id = p.id and s.shift_type = 'vacation'
          and s.shift_date >= make_date(y.y, 1, 1) and s.shift_date < make_date(y.y + 1, 1, 1)
    group by p.id, y.y, a.days
  )
  select jsonb_build_object(
    'from', (select d_from from bounds),
    'to', (select d_to from bounds),
    'today', (select today from bounds),
    'people', coalesce((select jsonb_agg(to_jsonb(p) order by p.studio nulls last, p.first_name, p.last_name) from people p), '[]'),
    'entries', coalesce((select jsonb_agg(to_jsonb(e) order by e.starts_at) from entries e), '[]'),
    'vacation', coalesce((select jsonb_agg(to_jsonb(v) order by v.year) from vacation v), '[]')
  )
$$;
revoke execute on function public.monthly_report(date) from public, anon, authenticated;
grant execute on function public.monthly_report(date) to service_role;

-- Stündlich: … + am 1. des Monats die Monatsübersicht
create or replace function private.hourly_jobs() returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_settings public.rule_settings;
  v_local    timestamp := now() at time zone 'Europe/Berlin';
  v_hour     integer := extract(hour from v_local);
begin
  select * into v_settings from public.rule_settings;
  if v_hour = v_settings.auto_checkout_hour then
    perform private.auto_checkout();
  end if;
  if v_hour = v_settings.absence_check_hour then
    perform private.call_telegram(jsonb_build_object('type', 'absence_check', 'date', v_local::date));
  end if;
  if extract(isodow from v_local) = v_settings.weekly_report_dow and v_hour = v_settings.weekly_report_hour then
    perform private.call_telegram(jsonb_build_object(
      'type', 'weekly_report', 'from', date_trunc('week', v_local)::date, 'to', v_local::date));
  end if;
  if extract(day from v_local) = 1 and v_hour = v_settings.monthly_report_hour
     and coalesce(v_settings.monthly_report_email, '') <> '' then
    perform private.call_telegram(jsonb_build_object('type', 'monthly_report', 'month', date_trunc('month', v_local)::date));
  end if;
end $$;

revoke execute on all functions in schema private from public;
grant execute on all functions in schema private to authenticated, service_role;
