-- =============================================================================
-- Aufgaben und Notizen (Seiten, Datenbanken, Favoriten, Dateien)
-- Läuft in derselben Datenbank wie Clock-In: Login und Mitarbeiterliste sind gemeinsam.
-- Rechte: Private Seiten sieht nur der Besitzer, Team-Seiten alle aktiven Mitarbeiter.
-- Quelle: Repo Notion-Klon-Desktop-und-App- (supabase/migrations) – wird nach Clock-In synchronisiert.
-- =============================================================================

do $$ begin
  create type public.note_space as enum ('private', 'team');
exception when duplicate_object then null;
end $$;

create table if not exists public.note_pages (
  id          uuid primary key default gen_random_uuid(),
  parent_id   uuid references public.note_pages (id) on delete cascade,
  space       public.note_space not null default 'private',
  owner_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  kind        text not null default 'page' check (kind in ('page', 'database')),
  title       text not null default '',
  icon        text,
  cover       text,
  content     jsonb not null default '[]'::jsonb,   -- BlockNote-Blöcke
  plain       text not null default '',             -- Klartext für die Suche
  props       jsonb not null default '{}'::jsonb,   -- Werte, wenn die Seite eine Datenbank-Zeile ist
  schema      jsonb,                                -- Eigenschaften + Ansichten, wenn kind = 'database'
  options     jsonb not null default '{}'::jsonb,   -- volle Breite, kleine Schrift, Schriftart, gesperrt
  position    double precision not null default 0,
  archived_at timestamptz,
  created_at  timestamptz not null default now(),
  created_by  uuid default auth.uid(),
  updated_at  timestamptz not null default now(),
  updated_by  uuid default auth.uid()
);

create index if not exists note_pages_parent_idx on public.note_pages (parent_id);
create index if not exists note_pages_owner_idx on public.note_pages (owner_id);

create table if not exists public.note_favorites (
  user_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  page_id    uuid not null references public.note_pages (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, page_id)
);

-- Unterseiten erben Bereich und Besitzer von der Elternseite; Zeitstempel/Bearbeiter setzt der Server
create or replace function private.note_pages_inherit() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_parent public.note_pages;
begin
  if new.parent_id is not null then
    select * into v_parent from public.note_pages where id = new.parent_id;
    if found then
      new.space := v_parent.space;
      if v_parent.space = 'private' then new.owner_id := v_parent.owner_id; end if;
    end if;
  end if;
  if tg_op = 'UPDATE' then
    new.created_at := old.created_at;
    new.created_by := old.created_by;
    new.updated_at := now();
    new.updated_by := coalesce(auth.uid(), new.updated_by);
  end if;
  return new;
end $$;

drop trigger if exists inherit on public.note_pages;
create trigger inherit before insert or update on public.note_pages
  for each row execute function private.note_pages_inherit();

-- Bereichswechsel (Privat ↔ Team) gilt für den ganzen Teilbaum
create or replace function private.note_pages_cascade_space() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.space is distinct from old.space or new.owner_id is distinct from old.owner_id then
    update public.note_pages
       set space = new.space, owner_id = new.owner_id
     where parent_id = new.id
       and (space is distinct from new.space or owner_id is distinct from new.owner_id);
  end if;
  return null;
end $$;

drop trigger if exists cascade_space on public.note_pages;
create trigger cascade_space after update of space, owner_id on public.note_pages
  for each row execute function private.note_pages_cascade_space();

-- Zugriff: eigene Seiten oder Team-Seiten – immer nur für aktive Mitarbeiter (keine Tablets)
create or replace function private.can_access_note(p_space public.note_space, p_owner uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select private.is_staff() and (p_owner = (select auth.uid()) or p_space = 'team')
$$;

alter table public.note_pages enable row level security;
alter table public.note_favorites enable row level security;

drop policy if exists note_pages_select on public.note_pages;
drop policy if exists note_pages_insert on public.note_pages;
drop policy if exists note_pages_update on public.note_pages;
drop policy if exists note_pages_delete on public.note_pages;
create policy note_pages_select on public.note_pages for select to authenticated
  using ((select private.can_access_note(space, owner_id)));
create policy note_pages_insert on public.note_pages for insert to authenticated
  with check ((select private.can_access_note(space, owner_id)));
create policy note_pages_update on public.note_pages for update to authenticated
  using ((select private.can_access_note(space, owner_id)))
  with check ((select private.can_access_note(space, owner_id)));
create policy note_pages_delete on public.note_pages for delete to authenticated
  using ((select private.can_access_note(space, owner_id)));

drop policy if exists note_favorites_all on public.note_favorites;
create policy note_favorites_all on public.note_favorites for all to authenticated
  using (user_id = (select auth.uid()) and (select private.is_staff()))
  with check (user_id = (select auth.uid()) and (select private.is_staff()));

grant select, insert, update, delete on public.note_pages, public.note_favorites to authenticated;
revoke all on public.note_pages, public.note_favorites from anon;
revoke execute on function private.note_pages_inherit(), private.note_pages_cascade_space(),
  private.can_access_note(public.note_space, uuid) from public;
grant execute on function private.note_pages_inherit(), private.note_pages_cascade_space(),
  private.can_access_note(public.note_space, uuid) to authenticated, service_role;

-- Live-Aktualisierung (andere Nutzer sehen Änderungen sofort)
do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables
                     where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'note_pages') then
    alter publication supabase_realtime add table public.note_pages;
  end if;
end $$;

-- Dateien (Bilder, Anhänge): privater Bucket, Ablage unter <auth.uid()>/…
insert into storage.buckets (id, name, public, file_size_limit)
values ('notes', 'notes', false, 20971520)
on conflict (id) do nothing;

drop policy if exists notes_files_read on storage.objects;
drop policy if exists notes_files_insert on storage.objects;
drop policy if exists notes_files_delete on storage.objects;
create policy notes_files_read on storage.objects for select to authenticated
  using (bucket_id = 'notes' and (select private.is_staff()));
create policy notes_files_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'notes' and (select private.is_staff())
              and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy notes_files_delete on storage.objects for delete to authenticated
  using (bucket_id = 'notes' and (storage.foldername(name))[1] = (select auth.uid())::text);
