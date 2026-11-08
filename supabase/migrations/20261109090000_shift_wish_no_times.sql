-- =============================================================================
-- Clock-In · Schichtwunsch annehmen ohne automatische Zeiten
-- =============================================================================
-- Die Studioleitung trägt die Schicht beim Annehmen selbst ein (eigene Zeiten); der Wunsch (früh/mittel/spät)
-- steht dabei nur als Hinweis. Diese Funktion legt deshalb keine Schicht mehr an, sondern markiert den Wunsch
-- nur noch als angenommen bzw. abgelehnt. (Mehrfach ausführbar.)
-- =============================================================================

create or replace function public.shift_wish_decide(p_id uuid, p_ok boolean) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_wish  public.shift_wishes;
  v_shift uuid;
begin
  select * into v_wish from public.shift_wishes where id = p_id for update;
  if not found or v_wish.status <> 'open' then
    raise exception 'Der Wunsch ist nicht mehr offen.';
  end if;
  if not private.manages_location(v_wish.location_id) then
    raise exception 'Nur die Studioleitung dieses Studios kann Wünsche freigeben.' using errcode = '42501';
  end if;
  if p_ok then
    -- die gerade von der Leitung eingetragene Schicht der Person an diesem Tag verknüpfen (falls vorhanden)
    select s.id into v_shift from public.shifts s
    where s.user_id = v_wish.user_id and s.shift_type = 'work' and s.shift_date = v_wish.day
    order by s.created_at desc limit 1;
  end if;
  update public.shift_wishes
     set status = case when p_ok then 'approved' else 'rejected' end,
         shift_id = v_shift, decided_by = private.current_user_id(), decided_at = now()
   where id = p_id;
  return v_shift;
end $$;

revoke execute on function public.shift_wish_decide(uuid, boolean) from public, anon;
grant execute on function public.shift_wish_decide(uuid, boolean) to authenticated;
