-- =============================================================================
-- Aufgaben und Notizen: Datei-Rechte pro Seite, weniger Datenverkehr beim Bearbeiten
-- * Dateien liegen unter <Seiten-ID>/… – lesen, hochladen, löschen nur mit Zugriff auf die Seite.
--   Ältere Dateien unter <Nutzer-ID>/… sieht nur noch, wer sie hochgeladen hat.
-- * Seiteninhalt (content, plain, ydoc) zieht von note_pages nach note_docs: note_pages bleibt klein
--   und wird live an alle verteilt, der Inhalt nicht mehr.
-- * note_doc_updates: kleine Änderungen beim Tippen; ein offener Editor fasst sie regelmäßig zum
--   Stand in note_docs zusammen (mit Versionszähler rev, damit nichts überschrieben wird).
-- Voraussetzung: 20261029090000_notes.sql und 20261030090000_notes_collab.sql
-- =============================================================================

create table if not exists public.note_docs (
  page_id    uuid primary key references public.note_pages (id) on delete cascade,
  content    jsonb not null default '[]'::jsonb,   -- BlockNote-Blöcke (Suche, Export, Versionen)
  plain      text not null default '',             -- Klartext für die Suche
  ydoc       text,                                 -- zusammengefasster Yjs-Stand (Base64)
  rev        integer not null default 0,
  updated_at timestamptz not null default now()
);

create table if not exists public.note_doc_updates (
  id         bigint generated always as identity primary key,
  page_id    uuid not null references public.note_pages (id) on delete cascade,
  data       text not null,                        -- Yjs-Änderung (Base64)
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid()
);

create index if not exists note_doc_updates_page_idx on public.note_doc_updates (page_id, id);

-- Bestehende Inhalte übernehmen und aus note_pages entfernen
do $$
declare
  v_has_ydoc boolean;
begin
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'note_pages' and column_name = 'content') then
    select exists (select 1 from information_schema.columns
                   where table_schema = 'public' and table_name = 'note_pages' and column_name = 'ydoc')
      into v_has_ydoc;
    execute format(
      'insert into public.note_docs (page_id, content, plain, ydoc)
       select id, content, plain, %s from public.note_pages
       on conflict (page_id) do nothing',
      case when v_has_ydoc then 'ydoc' else 'null' end);
    alter table public.note_pages drop column content;
    alter table public.note_pages drop column if exists plain;
  end if;
end $$;

-- Live-Stand liegt jetzt in note_docs (auch falls die vorige Migration erneut ausgeführt wurde)
alter table public.note_pages drop column if exists ydoc;

-- Jede Seite bekommt sofort ihren Inhalts-Datensatz
create or replace function private.note_docs_create() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.note_docs (page_id) values (new.id) on conflict (page_id) do nothing;
  return null;
end $$;

drop trigger if exists create_doc on public.note_pages;
create trigger create_doc after insert on public.note_pages
  for each row execute function private.note_docs_create();

create or replace function private.note_docs_touch() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists touch on public.note_docs;
create trigger touch before update on public.note_docs
  for each row execute function private.note_docs_touch();

alter table public.note_docs enable row level security;
alter table public.note_doc_updates enable row level security;

drop policy if exists note_docs_select on public.note_docs;
drop policy if exists note_docs_insert on public.note_docs;
drop policy if exists note_docs_update on public.note_docs;
create policy note_docs_select on public.note_docs for select to authenticated
  using ((select private.can_access_note_id(page_id)));
create policy note_docs_insert on public.note_docs for insert to authenticated
  with check ((select private.can_access_note_id(page_id)));
create policy note_docs_update on public.note_docs for update to authenticated
  using ((select private.can_access_note_id(page_id)))
  with check ((select private.can_access_note_id(page_id)));

drop policy if exists note_doc_updates_select on public.note_doc_updates;
drop policy if exists note_doc_updates_insert on public.note_doc_updates;
drop policy if exists note_doc_updates_delete on public.note_doc_updates;
create policy note_doc_updates_select on public.note_doc_updates for select to authenticated
  using ((select private.can_access_note_id(page_id)));
create policy note_doc_updates_insert on public.note_doc_updates for insert to authenticated
  with check (created_by = (select auth.uid()) and (select private.can_access_note_id(page_id)));
create policy note_doc_updates_delete on public.note_doc_updates for delete to authenticated
  using ((select private.can_access_note_id(page_id)));

grant select, insert, update on public.note_docs to authenticated;
grant select, insert, delete on public.note_doc_updates to authenticated;
revoke all on public.note_docs, public.note_doc_updates from anon;
do $$ begin
  execute format('grant usage, select on sequence %s to authenticated',
                 pg_get_serial_sequence('public.note_doc_updates', 'id'));
end $$;

-- ---------------- Dateien: Zugriff über die Seite ----------------
-- Ordner = Seiten-ID (neu) oder Nutzer-ID (ältere Uploads, nur für den Hochladenden)
create or replace function private.note_file_readable(p_name text) returns boolean
language sql stable security definer set search_path = '' as $$
  select case when (storage.foldername(p_name))[1] ~ '^[0-9a-f-]{36}$'
    then (storage.foldername(p_name))[1] = (select auth.uid())::text
         or private.can_access_note_id(((storage.foldername(p_name))[1])::uuid)
    else false end
$$;

create or replace function private.note_file_writable(p_name text) returns boolean
language sql stable security definer set search_path = '' as $$
  select case when (storage.foldername(p_name))[1] ~ '^[0-9a-f-]{36}$'
    then private.can_access_note_id(((storage.foldername(p_name))[1])::uuid)
    else false end
$$;

revoke execute on function private.note_docs_create(), private.note_docs_touch(),
  private.note_file_readable(text), private.note_file_writable(text) from public;
grant execute on function private.note_docs_create(), private.note_docs_touch(),
  private.note_file_readable(text), private.note_file_writable(text) to authenticated, service_role;

drop policy if exists notes_files_read on storage.objects;
drop policy if exists notes_files_insert on storage.objects;
drop policy if exists notes_files_delete on storage.objects;
create policy notes_files_read on storage.objects for select to authenticated
  using (bucket_id = 'notes' and (select private.is_staff()) and private.note_file_readable(name));
create policy notes_files_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'notes' and (select private.is_staff()) and private.note_file_writable(name));
create policy notes_files_delete on storage.objects for delete to authenticated
  using (bucket_id = 'notes' and (select private.is_staff()) and private.note_file_readable(name));
