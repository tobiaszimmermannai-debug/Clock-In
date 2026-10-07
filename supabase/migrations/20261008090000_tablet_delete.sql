-- =============================================================================
-- Clock-In · Tablets löschen (Verwaltung → Tablets → Löschen, nur Admin)
-- =============================================================================
-- Ohne Stempelungen: Tablet und Login werden komplett gelöscht.
-- Mit Stempelungen: Tablet wird gesperrt und aus der Übersicht entfernt (archiviert) –
-- die Buchungen bleiben als Arbeitszeitnachweis mit ihrem Tablet verknüpft.
-- =============================================================================

alter table public.kiosk_devices add column archived_at timestamptz;

create function public.delete_tablet(p_device_id uuid) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_auth uuid;
begin
  if not private.is_admin() then
    raise exception 'Nur Admins dürfen Tablets löschen.';
  end if;
  select auth_user_id into v_auth from public.kiosk_devices where id = p_device_id;
  if not found then
    raise exception 'Tablet nicht gefunden.';
  end if;

  if exists (select 1 from public.time_logs where kiosk_device_id = p_device_id) then
    update public.kiosk_devices set is_active = false, archived_at = now() where id = p_device_id;
    return 'archived';
  end if;

  delete from public.kiosk_devices where id = p_device_id;
  begin
    delete from auth.users where id = v_auth;
  exception when others then
    null;  -- Login bleibt dann übrig, ist ohne Tablet-Eintrag aber nutzlos
  end;
  return 'deleted';
end $$;

revoke execute on function public.delete_tablet(uuid) from public, anon;
grant execute on function public.delete_tablet(uuid) to authenticated;
