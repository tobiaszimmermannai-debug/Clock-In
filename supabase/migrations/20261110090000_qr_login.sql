-- =============================================================================
-- Clock-In · Anmeldung per QR-Code (Studioleitung an externen Geräten, z. B. privater PC)
-- =============================================================================
-- Regel: Studioleitungen melden sich in der Verwaltung (#/admin) nur per QR-Code an – mit ihrem registrierten
-- Stempel-Handy. (Studio-PC: eigene Freigabe pc_plan_*; Admins: Passwort + 2FA wie bisher.)
--   1. Browser (noch nicht angemeldet) holt Code + Geheimnis: qr_login_challenge()
--   2. Studioleitung scannt am Handy → qr_login_unlock(code, Handy-Schlüssel)
--   3. Browser fragt qr_login_status(code, geheimnis) und löst über die Edge Function „qr-login“ ein
--      (qr_login_claim nur mit Service-Role; nur mit dem Geheimnis des Browsers, einmalig, höchstens 2 Min.)
-- (Mehrfach ausführbar.)
-- =============================================================================

create table if not exists public.qr_logins (
  token        text primary key,
  secret_hash  text not null,
  created_at   timestamptz not null default now(),
  unlocked_by  uuid references public.users (id) on delete cascade,
  unlocked_at  timestamptz,
  claimed_at   timestamptz
);
alter table public.qr_logins enable row level security;
revoke all on public.qr_logins from anon, authenticated;  -- nur über die Funktionen

-- Browser: neuen Code holen (auch ohne Anmeldung)
create or replace function public.qr_login_challenge() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_token  text := encode(extensions.gen_random_bytes(16), 'hex');
  v_secret text := encode(extensions.gen_random_bytes(16), 'hex');
begin
  delete from public.qr_logins where created_at < now() - interval '15 minutes';
  if (select count(*) from public.qr_logins) > 500 then
    raise exception 'Gerade zu viele Anmeldeversuche – bitte kurz warten.';
  end if;
  insert into public.qr_logins (token, secret_hash) values (v_token, encode(extensions.digest(v_secret, 'sha256'), 'hex'));
  return jsonb_build_object('token', v_token, 'secret', v_secret);
end $$;

-- Browser: wurde der Code am Handy bestätigt? (nur mit dem Geheimnis dieses Browsers)
create or replace function public.qr_login_status(p_token text, p_secret text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('unlocked', q.unlocked_by is not null and q.claimed_at is null,
                            'name', u.first_name || ' ' || u.last_name)
  from public.qr_logins q
  left join public.users u on u.id = q.unlocked_by
  where q.token = p_token and q.secret_hash = encode(extensions.digest(coalesce(p_secret, ''), 'sha256'), 'hex')
$$;

-- Handy der Studioleitung: Code bestätigen (aktive Studioleitung, eigenes registriertes Stempel-Handy, Code ≤ 2 Min.)
create or replace function public.qr_login_unlock(p_token text, p_phone_key text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_user public.users;
  v_tok  public.qr_logins;
begin
  select * into v_user from public.users where id = private.current_user_id() and is_active;
  if not found or v_user.role <> 'manager' then
    raise exception 'Die Anmeldung per QR-Code ist für die Studioleitung.' using errcode = '42501';
  end if;
  if coalesce(p_phone_key, '') = '' or not exists (
       select 1 from public.stamp_phones
       where user_id = v_user.id and key_hash = encode(extensions.digest(p_phone_key, 'sha256'), 'hex')) then
    raise exception 'Bitte mit deinem registrierten Stempel-Handy scannen.' using errcode = '42501';
  end if;
  select * into v_tok from public.qr_logins where token = p_token for update;
  if not found or v_tok.created_at < now() - interval '2 minutes' or v_tok.claimed_at is not null then
    raise exception 'QR-Code abgelaufen – bitte am PC neu laden.';
  end if;
  update public.qr_logins set unlocked_by = v_user.id, unlocked_at = now() where token = p_token;
  return jsonb_build_object('ok', true);
end $$;

-- Edge Function „qr-login“ (Service-Role): Freigabe einlösen → Auth-Konto der Studioleitung
create or replace function public.qr_login_claim(p_token text, p_secret text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_tok  public.qr_logins;
  v_auth uuid;
begin
  select * into v_tok from public.qr_logins
  where token = p_token and secret_hash = encode(extensions.digest(coalesce(p_secret, ''), 'sha256'), 'hex')
  for update;
  if not found or v_tok.unlocked_by is null or v_tok.claimed_at is not null
     or v_tok.unlocked_at < now() - interval '2 minutes' then
    raise exception 'Freigabe nicht gültig – bitte erneut scannen.' using errcode = '42501';
  end if;
  update public.qr_logins set claimed_at = now() where token = p_token;
  select u.auth_user_id into v_auth from public.users u
  where u.id = v_tok.unlocked_by and u.is_active and u.role = 'manager';
  if v_auth is null then
    raise exception 'Studioleitung nicht mehr aktiv.' using errcode = '42501';
  end if;
  return v_auth;
end $$;

revoke execute on function public.qr_login_challenge(), public.qr_login_status(text, text),
  public.qr_login_unlock(text, text), public.qr_login_claim(text, text) from public, anon, authenticated;
grant execute on function public.qr_login_challenge(), public.qr_login_status(text, text) to anon, authenticated;
grant execute on function public.qr_login_unlock(text, text) to authenticated;
grant execute on function public.qr_login_claim(text, text) to service_role;
