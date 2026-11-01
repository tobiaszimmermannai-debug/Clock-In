-- =============================================================================
-- Aufgaben und Notizen: Leitung sieht alles, Löschen nur noch als Ausblenden, Studio-PC, Erfolge
-- * Admins (mit 2FA) sehen und bearbeiten alle Seiten, Studioleitungen die ihrer Mitarbeiter und alle
--   Team-Seiten – auch private und gelöschte.
-- * "Endgültig löschen" blendet für Mitarbeiter nur aus (deleted_at); wirklich löschen kann nur die Leitung.
-- * Studio-PC: ein als Terminal freigegebener PC (kiosk_devices.kind = 'pc') sieht und bearbeitet alle
--   Team-Seiten – nie private. Tablets bleiben reine Stempelgeräte.
-- * note_task_events: erledigte Aufgaben für Serie, Tagesziel und Rangliste (eine Gutschrift je Aufgabe
--   und Person; wird die Aufgabe wieder geöffnet, verschwindet sie).
-- Voraussetzung: 20261029…, 20261030…, 20261031… (Aufgaben) und 20261013090000_pc_terminals.sql (Clock-In)
-- =============================================================================

alter table public.note_pages add column if not exists deleted_at timestamptz;
alter table public.note_pages add column if not exists deleted_by uuid;

-- Studio-PC (nicht das Tablet)
create or replace function private.is_studio_pc() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.kiosk_devices k
    where k.auth_user_id = (select auth.uid()) and k.is_active and k.kind = 'pc'
  )
$$;

create or replace function private.is_manager() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.users u
    where u.auth_user_id = (select auth.uid()) and u.is_active and u.role = 'manager'
  )
$$;

-- Leitung: Admins alles; Studioleitung alle Team-Seiten und die Seiten der Mitarbeiter ihres Studios
create or replace function private.can_oversee_note(p_space public.note_space, p_owner uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select private.is_admin()
      or (p_space = 'team' and private.is_manager())
      or exists (select 1 from public.users u where u.auth_user_id = p_owner and private.manages_user(u.id))
$$;

-- Zugriff (ohne Rücksicht auf "gelöscht"): eigene + Team-Seiten, Leitung zusätzlich alles Beaufsichtigte,
-- Studio-PC nur Team-Seiten
create or replace function private.can_access_note(p_space public.note_space, p_owner uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select (private.is_staff() and (p_owner = (select auth.uid()) or p_space = 'team' or private.can_oversee_note(p_space, p_owner)))
      or (p_space = 'team' and private.is_studio_pc())
$$;

-- Sichtbar: wie oben, gelöschte Seiten nur für die Leitung
create or replace function private.can_see_note(p_space public.note_space, p_owner uuid, p_deleted timestamptz) returns boolean
language sql stable security definer set search_path = '' as $$
  select private.can_access_note(p_space, p_owner)
     and (p_deleted is null or private.can_oversee_note(p_space, p_owner))
$$;

create or replace function private.can_access_note_id(p_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.note_pages p
    where p.id = p_id and private.can_see_note(p.space, p.owner_id, p.deleted_at)
  )
$$;

create or replace function private.is_note_user() returns boolean
language sql stable security definer set search_path = '' as $$
  select private.is_staff() or private.is_studio_pc()
$$;

drop policy if exists note_pages_select on public.note_pages;
drop policy if exists note_pages_insert on public.note_pages;
drop policy if exists note_pages_update on public.note_pages;
drop policy if exists note_pages_delete on public.note_pages;
create policy note_pages_select on public.note_pages for select to authenticated
  using ((select private.can_see_note(space, owner_id, deleted_at)));
create policy note_pages_insert on public.note_pages for insert to authenticated
  with check ((select private.can_access_note(space, owner_id)) and deleted_at is null);
-- Ausblenden läuft über public.note_soft_delete (die Seite wird dabei für Mitarbeiter unsichtbar)
create policy note_pages_update on public.note_pages for update to authenticated
  using ((select private.can_see_note(space, owner_id, deleted_at)))
  with check ((select private.can_access_note(space, owner_id)));
-- Wirklich löschen nur die Leitung
create policy note_pages_delete on public.note_pages for delete to authenticated
  using ((select private.can_oversee_note(space, owner_id)));

drop policy if exists note_favorites_all on public.note_favorites;
create policy note_favorites_all on public.note_favorites for all to authenticated
  using (user_id = (select auth.uid()) and (select private.is_note_user()))
  with check (user_id = (select auth.uid()) and (select private.is_note_user()));

-- Dateien: auch für den Studio-PC (Zugriff weiterhin über die Seite)
drop policy if exists notes_files_read on storage.objects;
drop policy if exists notes_files_insert on storage.objects;
drop policy if exists notes_files_delete on storage.objects;
create policy notes_files_read on storage.objects for select to authenticated
  using (bucket_id = 'notes' and (select private.is_note_user()) and private.note_file_readable(name));
create policy notes_files_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'notes' and (select private.is_note_user()) and private.note_file_writable(name));
create policy notes_files_delete on storage.objects for delete to authenticated
  using (bucket_id = 'notes' and (select private.is_note_user()) and private.note_file_readable(name));

-- ---------------- Erfolge ----------------
-- Gutgeschrieben wird nur aktiven Mitarbeitern (nicht Geräten)
create or replace function private.is_active_member(p_auth uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.users u where u.auth_user_id = p_auth and u.is_active)
$$;

create table if not exists public.note_task_events (
  id         bigint generated always as identity primary key,
  page_id    uuid not null references public.note_pages (id) on delete cascade,
  user_id    uuid not null references auth.users (id) on delete cascade,   -- wem die Aufgabe gutgeschrieben wird
  points     integer not null default 10 check (points between 0 and 100),
  done_at    timestamptz not null default now(),
  created_by uuid default auth.uid(),
  unique (page_id, user_id)
);

create index if not exists note_task_events_done_idx on public.note_task_events (done_at);

alter table public.note_task_events enable row level security;
drop policy if exists note_task_events_select on public.note_task_events;
drop policy if exists note_task_events_insert on public.note_task_events;
drop policy if exists note_task_events_delete on public.note_task_events;
-- Rangliste: alle sehen alle Gutschriften (nur Zahlen, keine Inhalte)
create policy note_task_events_select on public.note_task_events for select to authenticated
  using ((select private.is_note_user()));
create policy note_task_events_insert on public.note_task_events for insert to authenticated
  with check (
    created_by = (select auth.uid())
    and (select private.can_access_note_id(page_id))
    and (select private.is_active_member(user_id))
  );
create policy note_task_events_delete on public.note_task_events for delete to authenticated
  using ((select private.can_access_note_id(page_id)));

grant select, insert, delete on public.note_task_events to authenticated;
revoke all on public.note_task_events from anon;
do $$ begin
  execute format('grant usage, select on sequence %s to authenticated',
                 pg_get_serial_sequence('public.note_task_events', 'id'));
end $$;

-- ---------------- Für die App ----------------
-- Eigene Rechte (Leitung, Studio-PC) – die App blendet danach Übersicht bzw. Studio-Modus ein
create or replace function public.note_access() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'oversee', private.is_admin() or private.is_manager(),
    'admin', private.is_admin(),
    'studio', private.is_studio_pc(),
    'studio_name', (select k.name from public.kiosk_devices k
                    where k.auth_user_id = (select auth.uid()) and k.is_active limit 1),
    'studio_location', (select k.location_id from public.kiosk_devices k
                        where k.auth_user_id = (select auth.uid()) and k.is_active limit 1)
  )
$$;

-- Löschen für alle mit Zugriff = ausblenden (danach sieht die Seite nur noch die Leitung)
create or replace function public.note_soft_delete(p_ids uuid[]) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_count integer;
begin
  update public.note_pages p
     set deleted_at = now(), deleted_by = (select auth.uid())
   where p.id = any (p_ids)
     and p.deleted_at is null
     and private.can_see_note(p.space, p.owner_id, p.deleted_at);
  get diagnostics v_count = row_count;
  return v_count;
end $$;

-- Tage mit "Kommen"-Stempel (freie Tage unterbrechen die Serie nicht)
create or replace function public.note_work_days(p_since date) returns setof date
language sql stable security definer set search_path = '' as $$
  select distinct (t.recorded_at at time zone 'Europe/Berlin')::date
  from public.time_logs t
  where t.user_id = private.current_user_id()
    and t.event_type = 'clock_in'
    and t.recorded_at >= p_since
$$;

revoke execute on function private.is_active_member(uuid), private.is_studio_pc(), private.is_manager(), private.can_oversee_note(public.note_space, uuid),
  private.can_see_note(public.note_space, uuid, timestamptz), private.is_note_user() from public;
grant execute on function private.is_active_member(uuid), private.is_studio_pc(), private.is_manager(), private.can_oversee_note(public.note_space, uuid),
  private.can_see_note(public.note_space, uuid, timestamptz), private.is_note_user() to authenticated, service_role;
revoke execute on function public.note_access(), public.note_work_days(date), public.note_soft_delete(uuid[]) from public, anon;
grant execute on function public.note_access(), public.note_work_days(date), public.note_soft_delete(uuid[]) to authenticated;
