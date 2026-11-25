-- =============================================================================
-- Clock-In · Fotonachweis pro Mitarbeiter (mehrfach ausführbar)
-- =============================================================================
-- Die Studioleitung (oder ein Admin) kann für eine Person festlegen: bei ALLEN Aufgaben ein Foto als Nachweis.
-- Die App verlangt dann beim Abhaken jeder Aufgabe ein Foto (zusätzlich zu einzeln markierten Aufgaben).
-- =============================================================================

alter table public.users add column if not exists photo_required boolean not null default false;

create or replace function public.set_photo_required(p_user uuid, p_on boolean) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not (private.is_admin() or private.manages_user(p_user)) then
    raise exception 'Nur die eigene Studioleitung oder ein Admin.';
  end if;
  update public.users set photo_required = coalesce(p_on, false) where id = p_user;
end $$;

revoke execute on function public.set_photo_required(uuid, boolean) from public, anon;
grant execute on function public.set_photo_required(uuid, boolean) to authenticated;
