-- =============================================================================
-- Clock-In · Aushilfe stellen ohne Anfrage
-- =============================================================================
-- Studioleitung darf ihre eigenen Leute in jedem Studio einplanen (Aushilfe, telefonisch/WhatsApp
-- abgesprochen) – normale Schichten wie Akquise. Fremde Leute in fremden Studios bleiben gesperrt.
-- Die Leitung des Studios, in dem gearbeitet wird, kann die Schicht weiterhin ändern/löschen.
-- Anfragen im Programm („Aushilfe gesucht“) bleiben optional.
-- =============================================================================

create or replace function private.can_plan_shift(p_location_id uuid, p_user_id uuid, p_acquisition boolean) returns boolean
language sql stable security definer set search_path = '' as $$
  select private.can_plan_shift(p_location_id, p_user_id)
      or (p_location_id is not null and private.manages_user(p_user_id))
$$;

revoke execute on all functions in schema private from public;
grant execute on all functions in schema private to authenticated, service_role;
