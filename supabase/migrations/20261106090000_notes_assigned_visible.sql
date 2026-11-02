-- =============================================================================
-- Aufgaben · Zugewiesenes ist immer sichtbar
-- =============================================================================
-- Legt die Leitung eine Aufgabe in ihrer privaten Liste an und weist sie jemandem zu (oder pinnt sie als
-- Tagesaufgabe an), sieht diese Person die Aufgabe trotzdem – samt der Liste drumherum (nur lesen), damit
-- sie angezeigt und abgehakt werden kann. Für Mitarbeiter gilt weiter: nur eingecheckt.
-- Der Studio-PC sieht so auch Aufgaben, die Personen seines Studios zugewiesen sind.
-- (Mehrfach ausführbar.) Voraussetzung: 20261105090000_notes_task_rules.sql
-- =============================================================================

-- Alle Personen, die eine Aufgabe nennt: Personen-Eigenschaften (Listen von IDs) und Tagesfokus (__focus)
create or replace function private.note_people_of(p_props jsonb) returns setof text
language sql immutable set search_path = '' as $$
  select v
  from jsonb_each(coalesce(p_props, '{}'::jsonb)) e
  cross join lateral jsonb_array_elements_text(case when jsonb_typeof(e.value) = 'array' then e.value else '[]'::jsonb end) v
  union
  select k
  from jsonb_object_keys(case when jsonb_typeof(p_props -> '__focus') = 'object' then p_props -> '__focus' else '{}'::jsonb end) k
$$;

-- Darf ich diese (nicht gelöschte) Aufgabe sehen, weil sie mir bzw. meinem Studio (Studio-PC) zugewiesen ist?
create or replace function private.note_assigned_ok(p_props jsonb, p_deleted timestamptz) returns boolean
language sql stable security definer set search_path = '' as $$
  select p_deleted is null and p_props is not null and (
    (private.is_staff() and private.note_gate_ok()
      and ((select auth.uid())::text in (select private.note_people_of(p_props))))
    or (private.is_studio_pc() and exists (
      select 1
      from private.note_people_of(p_props) x
      join public.users u on u.auth_user_id::text = x and u.is_active
      join public.kiosk_devices k on k.auth_user_id = (select auth.uid()) and k.is_active and k.kind = 'pc'
      where u.home_location_id = k.location_id))
  )
$$;

-- Liste (Datenbank), in der mir etwas zugewiesen ist – nur lesen
create or replace function private.note_parent_of_assigned(p_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.note_pages c
    where c.parent_id = p_id and private.note_assigned_ok(c.props, c.deleted_at)
  )
$$;

drop policy if exists note_pages_select on public.note_pages;
create policy note_pages_select on public.note_pages for select to authenticated
  using (
    (select private.can_see_note(space, owner_id, deleted_at))
    or private.note_assigned_ok(props, deleted_at)
    or (kind = 'database' and deleted_at is null and private.note_parent_of_assigned(id))
  );

-- Abhaken/Bearbeiten der zugewiesenen Aufgabe (nicht der Liste)
drop policy if exists note_pages_update on public.note_pages;
create policy note_pages_update on public.note_pages for update to authenticated
  using ((select private.can_see_note(space, owner_id, deleted_at)) or private.note_assigned_ok(props, deleted_at))
  with check ((select private.can_access_note(space, owner_id)) or private.note_assigned_ok(props, deleted_at));

-- Inhalt, Kommentare, Dateien (z. B. Fotonachweis) und Gutschriften hängen an can_access_note_id
create or replace function private.can_access_note_id(p_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.note_pages p
    where p.id = p_id
      and (private.can_see_note(p.space, p.owner_id, p.deleted_at) or private.note_assigned_ok(p.props, p.deleted_at))
  )
$$;

revoke execute on function private.note_people_of(jsonb), private.note_assigned_ok(jsonb, timestamptz), private.note_parent_of_assigned(uuid)
  from public, anon;
grant execute on function private.note_people_of(jsonb), private.note_assigned_ok(jsonb, timestamptz), private.note_parent_of_assigned(uuid)
  to authenticated, service_role;
