-- =============================================================================
-- Aufgaben · Blitzi männlich/weiblich
-- =============================================================================
-- note_profiles: welche Blitzi-Variante eine Person hat. Lesen dürfen alle Aufgaben-Nutzer (für Rangliste
-- und Team-Übersicht); setzen nur über note_set_blitzi: selbst, Admin, Studioleitung für ihr Studio oder der
-- Studio-PC für die dort gewählte Person. (Mehrfach ausführbar.)
-- Voraussetzung: 20261101090000_notes_roles_gamification.sql
-- =============================================================================

create table if not exists public.note_profiles (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  blitzi     text check (blitzi in ('m', 'w')),
  updated_at timestamptz not null default now(),
  updated_by uuid default auth.uid()
);

alter table public.note_profiles enable row level security;
drop policy if exists note_profiles_select on public.note_profiles;
create policy note_profiles_select on public.note_profiles for select to authenticated
  using ((select private.is_note_user()));

revoke all on public.note_profiles from anon, authenticated;
grant select on public.note_profiles to authenticated;

create or replace function public.note_set_blitzi(p_user uuid, p_kind text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if p_kind is null or p_kind not in ('m', 'w') then
    raise exception 'Ungültige Auswahl' using errcode = '22023';
  end if;
  if not private.is_active_member(p_user) or not (
       p_user = (select auth.uid())
    or private.is_admin()
    or exists (select 1 from public.users u where u.auth_user_id = p_user and private.manages_user(u.id))
    or private.is_studio_pc()
  ) then
    raise exception 'Keine Berechtigung' using errcode = '42501';
  end if;
  insert into public.note_profiles (user_id, blitzi, updated_at, updated_by)
  values (p_user, p_kind, now(), (select auth.uid()))
  on conflict (user_id) do update set blitzi = excluded.blitzi, updated_at = excluded.updated_at, updated_by = excluded.updated_by;
end $$;

revoke execute on function public.note_set_blitzi(uuid, text) from public, anon;
grant execute on function public.note_set_blitzi(uuid, text) to authenticated;
