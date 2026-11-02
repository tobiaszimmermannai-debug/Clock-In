-- =============================================================================
-- Aufgaben · Regeln für Fotonachweis und Verschieben
-- =============================================================================
-- * props.__photo (Fotonachweis verlangt): setzen dürfen alle (z. B. Kopie einer Serie), zurücknehmen nur
--   Studioleitung/Geschäftsführung.
-- * props.__moves (wie oft verschoben): zählt nur hoch – ab 2× verlangt die App einen Fotonachweis.
-- (Mehrfach ausführbar.) Voraussetzung: 20261104110000_notes_checkin_gate.sql
-- =============================================================================

create or replace function private.note_pages_task_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_old_moves integer := case when (old.props ->> '__moves') ~ '^\d+$' then (old.props ->> '__moves')::integer else 0 end;
  v_new_moves integer := case when (new.props ->> '__moves') ~ '^\d+$' then (new.props ->> '__moves')::integer else 0 end;
begin
  if private.is_note_lead() then
    return new;
  end if;
  if coalesce(old.props ->> '__photo', '') = 'true' and coalesce(new.props ->> '__photo', '') <> 'true' then
    new.props := jsonb_set(coalesce(new.props, '{}'::jsonb), '{__photo}', 'true'::jsonb);
  end if;
  if v_old_moves > v_new_moves then
    new.props := jsonb_set(coalesce(new.props, '{}'::jsonb), '{__moves}', to_jsonb(v_old_moves));
  end if;
  return new;
end $$;

drop trigger if exists note_pages_task_guard on public.note_pages;
create trigger note_pages_task_guard before update of props on public.note_pages
  for each row execute function private.note_pages_task_guard();

revoke execute on function private.note_pages_task_guard() from public, anon, authenticated;
