-- =============================================================================
-- Clock-In · Digitale Einwilligung (Biometrie) & Tablet-Konten mit Benutzernamen
-- =============================================================================
-- * Gesichtsdaten dürfen nur mit gültiger, unterschriebener Einwilligung gespeichert werden
-- * Widerruf oder Deaktivierung des Mitarbeiters löscht die Gesichtsdaten sofort
-- * Einwilligungen bleiben als Nachweis erhalten (nur widerrufbar, nicht änderbar)
-- =============================================================================

-- Einwilligung nach Art. 9 Abs. 2 lit. a DSGVO i. V. m. § 26 Abs. 2 BDSG
create table public.biometric_consents (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references public.users (id) on delete cascade,
  version       text not null,                                      -- Version des Einwilligungstexts
  consent_text  text not null check (length(consent_text) between 200 and 20000),  -- exakt angezeigter Text
  signed_name   text not null check (length(trim(signed_name)) >= 3),
  signature_svg text not null check (signature_svg like '<svg%' and length(signature_svg) <= 200000),
  given_at      timestamptz not null default now(),
  recorded_by   uuid references public.users (id) on delete set null,  -- anwesende Leitung/Admin
  revoked_at    timestamptz,
  revoked_by    uuid references public.users (id) on delete set null
);
create unique index biometric_consents_active_idx on public.biometric_consents (user_id) where revoked_at is null;

alter table public.face_embeddings
  add column consent_id uuid references public.biometric_consents (id) on delete cascade;

-- Tablet-Konten: Anmeldung per Benutzername (intern <name>@kiosk.clockin.invalid)
alter table public.kiosk_devices
  add column username text unique check (username ~ '^[a-z0-9][a-z0-9_-]{2,30}$');


-- -----------------------------------------------------------------------------
-- Trigger
-- -----------------------------------------------------------------------------

-- Neue Einwilligung: Zeitpunkt & aufnehmende Person serverseitig setzen
create function private.consent_before_insert() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  new.given_at    := now();
  new.recorded_by := private.current_user_id();
  new.revoked_at  := null;
  new.revoked_by  := null;
  return new;
end $$;

-- Einwilligung ist unveränderlich; einzig erlaubte Änderung: Widerruf
create function private.consent_before_update() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if old.revoked_at is not null then
    raise exception 'Diese Einwilligung wurde bereits widerrufen.';
  end if;
  if (new.user_id, new.version, new.consent_text, new.signed_name, new.signature_svg, new.given_at, new.recorded_by)
     is distinct from
     (old.user_id, old.version, old.consent_text, old.signed_name, old.signature_svg, old.given_at, old.recorded_by) then
    raise exception 'Eine Einwilligung kann nicht geändert, nur widerrufen werden.';
  end if;
  if new.revoked_at is null then
    raise exception 'Eine Einwilligung kann nicht geändert, nur widerrufen werden.';
  end if;
  new.revoked_at := now();
  new.revoked_by := private.current_user_id();
  return new;
end $$;

-- Widerruf → Gesichtsdaten sofort löschen
create function private.consent_after_revoke() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  delete from public.face_embeddings where user_id = new.user_id;
  return null;
end $$;

-- Gesichtsdaten nur mit gültiger Einwilligung; Verknüpfung serverseitig setzen
create function private.face_require_consent() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_consent public.biometric_consents;
begin
  select * into v_consent from public.biometric_consents
  where user_id = new.user_id and revoked_at is null;
  if v_consent.id is null then
    raise exception 'Keine gültige Einwilligung für biometrische Daten vorhanden.';
  end if;
  new.consent_id       := v_consent.id;
  new.consent_given_at := v_consent.given_at;
  return new;
end $$;

-- Mitarbeiter deaktiviert (Austritt) → Einwilligung beenden, Gesichtsdaten löschen
create function private.user_deactivated() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  update public.biometric_consents set revoked_at = now()
  where user_id = new.id and revoked_at is null;
  delete from public.face_embeddings where user_id = new.id;
  return null;
end $$;

create trigger before_insert before insert on public.biometric_consents
  for each row execute function private.consent_before_insert();
create trigger before_update before update on public.biometric_consents
  for each row execute function private.consent_before_update();
create trigger after_revoke after update of revoked_at on public.biometric_consents
  for each row when (old.revoked_at is null and new.revoked_at is not null)
  execute function private.consent_after_revoke();
create trigger require_consent before insert on public.face_embeddings
  for each row execute function private.face_require_consent();
create trigger deactivated after update of is_active on public.users
  for each row when (old.is_active and not new.is_active)
  execute function private.user_deactivated();


-- -----------------------------------------------------------------------------
-- RLS
-- -----------------------------------------------------------------------------
alter table public.biometric_consents enable row level security;

-- Betroffene sehen ihre eigene, Leitung/Admin die ihrer Mitarbeiter
create policy consents_select on public.biometric_consents for select to authenticated
  using (user_id = (select private.current_user_id()) or private.manages_user(user_id));
-- Unterschrift wird im Beisein der Leitung/Admin auf deren Gerät erfasst
create policy consents_insert on public.biometric_consents for insert to authenticated
  with check (private.manages_user(user_id));
-- Widerruf: Betroffene selbst oder Leitung/Admin (Inhalt sichert der Trigger)
create policy consents_update on public.biometric_consents for update to authenticated
  using (user_id = (select private.current_user_id()) or private.manages_user(user_id))
  with check (user_id = (select private.current_user_id()) or private.manages_user(user_id));

revoke all on public.biometric_consents from anon;
revoke truncate on public.biometric_consents from authenticated;


-- -----------------------------------------------------------------------------
-- RPC: Admin-Prüfung für Edge Functions (inkl. 2FA, siehe private.is_admin)
-- -----------------------------------------------------------------------------
create function public.am_i_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select private.is_admin()
$$;
revoke execute on function public.am_i_admin() from public, anon;
grant execute on function public.am_i_admin() to authenticated;

revoke execute on all functions in schema private from public;
grant execute on all functions in schema private to authenticated, service_role;
