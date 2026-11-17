-- =============================================================================
-- Aufgaben · Fotonachweis per Telegram prüfen
-- =============================================================================
-- Sobald zu einer Aufgabe ein Fotonachweis hochgeladen wird, schickt die Function „aufgaben“ das Foto mit der
-- Aufgabe an die Empfänger (AUFGABEN_EMPFAENGER, z. B. Tobi und Domi) – mit „Freigeben“ und „Ablehnen“.
-- Ablehnen: keine Punkte für die Aufgabe, und sie wird für morgen neu angelegt – wieder mit Fotonachweis.
-- (Mehrfach ausführbar.) Voraussetzung: 20261103090000_notes_daily_telegram.sql
-- =============================================================================

create or replace function private.note_pages_proof_notify() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.deleted_at is null
     and jsonb_typeof(new.props -> '__proof') = 'object'
     and (new.props -> '__proof' ->> 'url') is distinct from (old.props -> '__proof' ->> 'url') then
    perform private.call_aufgaben(jsonb_build_object('action', 'proof_new', 'page_id', new.id));
  end if;
  return null;
end $$;

drop trigger if exists note_pages_proof_notify on public.note_pages;
create trigger note_pages_proof_notify after update of props on public.note_pages
  for each row execute function private.note_pages_proof_notify();

revoke execute on function private.note_pages_proof_notify() from public, anon, authenticated;
