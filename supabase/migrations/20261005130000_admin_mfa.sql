-- =============================================================================
-- Clock-In · 2FA für Admins
-- Admin-Rechte gelten nur in Sitzungen mit zweitem Faktor (Supabase MFA/TOTP,
-- JWT-Claim aal = 'aal2'). Ohne 2FA hat ein Admin-Konto nur Mitarbeiter-Rechte.
-- Wirkt automatisch auf alle Policies/Trigger, die private.is_admin() nutzen.
-- SQL-Editor / Service-Role sind nicht betroffen (umgehen RLS).
-- =============================================================================
create or replace function private.is_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select auth.jwt()) ->> 'aal', '') = 'aal2'
     and exists (
       select 1 from public.users u
       where u.auth_user_id = (select auth.uid()) and u.is_active and u.role = 'admin'
     )
$$;
