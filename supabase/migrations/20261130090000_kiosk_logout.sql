-- =============================================================================
-- Clock-In · Studio-Geräte (Tablets und Studio-PCs) per Klick abmelden (mehrfach ausführbar, löscht nichts)
-- =============================================================================
-- Admin setzt logout_requested_at; jedes Gerät fragt höchstens jede Minute nach (kiosk_logout_check) und meldet sich
-- ab, wenn die Anforderung NACH seinem Login liegt. Ein danach neu angemeldetes Gerät bleibt angemeldet.
-- =============================================================================

alter table public.kiosk_devices add column if not exists logout_requested_at timestamptz;

-- Admin: alle aktiven Geräte (oder nur ein Studio) abmelden → Anzahl
create or replace function public.kiosk_logout_all(p_location uuid default null) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_count integer;
begin
  if not private.is_admin() then
    raise exception 'Nur für Admins.';
  end if;
  update public.kiosk_devices
     set logout_requested_at = now()
   where is_active and (p_location is null or location_id = p_location);
  get diagnostics v_count = row_count;
  return v_count;
end $$;

-- Gerät: Soll ich mich abmelden? Login-Zeitpunkt = Beginn der Supabase-Sitzung (auth.sessions über die session_id
-- im Token); fehlt die, zählt der von der App übergebene Zeitpunkt p_since. Ohne beides: nicht abmelden.
create or replace function public.kiosk_logout_check(p_since timestamptz default null) returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare
  v_req   timestamptz;
  v_login timestamptz;
begin
  select d.logout_requested_at into v_req from public.kiosk_devices d where d.auth_user_id = auth.uid();
  if v_req is null then
    return false;
  end if;
  begin
    select s.created_at into v_login from auth.sessions s where s.id = nullif(auth.jwt() ->> 'session_id', '')::uuid;
  exception when others then
    v_login := null;  -- auth.sessions nicht lesbar → Zeitpunkt der App
  end;
  v_login := coalesce(v_login, p_since);
  return v_login is not null and v_req > v_login;
end $$;

revoke execute on function public.kiosk_logout_all(uuid) from public, anon;
grant execute on function public.kiosk_logout_all(uuid) to authenticated;
revoke execute on function public.kiosk_logout_check(timestamptz) from public, anon;
grant execute on function public.kiosk_logout_check(timestamptz) to authenticated;
