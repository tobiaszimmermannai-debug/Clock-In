-- =============================================================================
-- Aufgaben und Notizen: gemeinsames Bearbeiten, Kommentare, Versionsverlauf
-- * note_pages.ydoc: Yjs-Dokument (Base64) – Grundlage für Live-Bearbeitung; Kommentare liegen darin
-- * note_versions: gespeicherte Stände einer Seite (bis zu 100 je Seite)
-- * realtime.messages: Live-Kanal "note:<Seiten-ID>" nur für Personen mit Zugriff auf die Seite
-- Voraussetzung: 20261029090000_notes.sql
-- =============================================================================

alter table public.note_pages add column if not exists ydoc text;

create table if not exists public.note_versions (
  id         uuid primary key default gen_random_uuid(),
  page_id    uuid not null references public.note_pages (id) on delete cascade,
  title      text not null default '',
  content    jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid()
);

create index if not exists note_versions_page_idx on public.note_versions (page_id, created_at desc);

-- Zugriff auf eine Seite per ID (für Versionen und den Live-Kanal)
create or replace function private.can_access_note_id(p_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.note_pages p
    where p.id = p_id and private.can_access_note(p.space, p.owner_id)
  )
$$;

revoke execute on function private.can_access_note_id(uuid) from public;
grant execute on function private.can_access_note_id(uuid) to authenticated, service_role;

alter table public.note_versions enable row level security;

drop policy if exists note_versions_select on public.note_versions;
drop policy if exists note_versions_insert on public.note_versions;
drop policy if exists note_versions_delete on public.note_versions;
create policy note_versions_select on public.note_versions for select to authenticated
  using ((select private.can_access_note_id(page_id)));
create policy note_versions_insert on public.note_versions for insert to authenticated
  with check (created_by = (select auth.uid()) and (select private.can_access_note_id(page_id)));
create policy note_versions_delete on public.note_versions for delete to authenticated
  using ((select private.can_access_note_id(page_id)));

grant select, insert, delete on public.note_versions to authenticated;
revoke all on public.note_versions from anon;

-- Live-Kanal: Lesen und Senden nur mit Zugriff auf die Seite (Supabase Realtime Authorization)
do $$ begin
  if to_regclass('realtime.messages') is not null then
    execute 'drop policy if exists notes_collab_read on realtime.messages';
    execute 'drop policy if exists notes_collab_write on realtime.messages';
    execute $p$
      create policy notes_collab_read on realtime.messages for select to authenticated
        using (case when realtime.topic() ~ '^note:[0-9a-f-]{36}$'
                    then private.can_access_note_id(substr(realtime.topic(), 6)::uuid) else false end)
    $p$;
    execute $p$
      create policy notes_collab_write on realtime.messages for insert to authenticated
        with check (case when realtime.topic() ~ '^note:[0-9a-f-]{36}$'
                         then private.can_access_note_id(substr(realtime.topic(), 6)::uuid) else false end)
    $p$;
  end if;
end $$;
