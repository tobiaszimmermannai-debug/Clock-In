-- =============================================================================
-- Aufgaben · Studio-Trennung, Aushilfe im Gaststudio, Blitzi-Prestige (Items, Spitzname), Feierabend-Punkt
-- =============================================================================
-- * Studio-Trennung: Wochen-/Monatsaufgaben eines Studios (Zeilen mit Eigenschaft studio + rhythm) sehen nur
--   Admins, die Studioleitung dieses Studios, Leute mit diesem Heimatstudio, wer heute dort eingecheckt ist
--   (Aushilfe) und der Studio-PC dieses Studios. Zugewiesene Aufgaben bleiben für die zugewiesene Person sichtbar.
-- * Aushilfe: Am Studio-PC des Gaststudios erscheint, wer heute dort eingecheckt hat – mit den eigenen,
--   zugewiesenen Aufgaben und den Team-Aufgaben des Gaststudios.
-- * Blitzi-Prestige: Ab Stufe 30 wählt man 1 von 100 Items (bleibt für immer), Blitzi fängt bei Stufe 1 neu an.
--   Beim ersten Mal Pflicht-Spitzname (2–20 Zeichen). Gespeichert in blitzi_profiles.
-- * Feierabend: Wer beim Ausstempeln die Statistik abgibt (shift_reports, Clock-In), bekommt +1 Punkt.
-- (Mehrfach ausführbar.) Voraussetzung: 20261106090000_notes_assigned_visible.sql
-- =============================================================================

-- Heute (Berliner Tag) in diesem Studio eingestempelt?
create or replace function private.checked_in_today_at(p_user uuid, p_location uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.time_logs t
    where t.user_id = p_user and t.location_id = p_location and t.event_type = 'clock_in'
      and t.approval_status <> 'rejected'
      and t.recorded_at >= ((now() at time zone 'Europe/Berlin')::date)::timestamp at time zone 'Europe/Berlin')
$$;

-- Wo ist wer heute eingecheckt (letztes Kommen heute)? Für Studio-Dashboard und Aushilfe
create or replace function public.note_here_today() returns table (user_id uuid, location_id uuid)
language sql stable security definer set search_path = '' as $$
  select distinct on (u.id) u.auth_user_id, t.location_id
  from public.time_logs t
  join public.users u on u.id = t.user_id and u.is_active and u.auth_user_id is not null
  where private.is_note_user()
    and t.event_type = 'clock_in' and t.approval_status <> 'rejected' and t.location_id is not null
    and t.recorded_at >= ((now() at time zone 'Europe/Berlin')::date)::timestamp at time zone 'Europe/Berlin'
  order by u.id, t.recorded_at desc
$$;

-- Darf ich die Wochen-/Monatsaufgabe dieses Studios sehen? (Alle anderen Seiten: ja – wie bisher)
create or replace function private.note_studio_ok(p_props jsonb) returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare
  v_studio uuid;
  v_me     public.users;
begin
  if p_props is null or not (p_props ? 'rhythm') or jsonb_typeof(p_props -> 'studio') <> 'string' then
    return true;
  end if;
  begin
    v_studio := (p_props ->> 'studio')::uuid;
  exception when others then
    return true;
  end;
  if private.is_admin() or private.manages_location(v_studio) then
    return true;
  end if;
  if exists (select 1 from public.kiosk_devices k
             where k.auth_user_id = (select auth.uid()) and k.is_active and k.kind = 'pc' and k.location_id = v_studio) then
    return true;
  end if;
  select * into v_me from public.users where auth_user_id = (select auth.uid()) and is_active;
  if not found then
    return false;
  end if;
  return v_me.home_location_id = v_studio or private.checked_in_today_at(v_me.id, v_studio);
end $$;

-- Zugewiesen: zusätzlich am Studio-PC des Gaststudios (Aushilfe heute dort eingecheckt)
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
      where u.home_location_id = k.location_id or private.checked_in_today_at(u.id, k.location_id)))
  )
$$;

drop policy if exists note_pages_select on public.note_pages;
create policy note_pages_select on public.note_pages for select to authenticated
  using (
    ((select private.can_see_note(space, owner_id, deleted_at)) and private.note_studio_ok(props))
    or private.note_assigned_ok(props, deleted_at)
    or (kind = 'database' and deleted_at is null and private.note_parent_of_assigned(id))
  );

drop policy if exists note_pages_update on public.note_pages;
create policy note_pages_update on public.note_pages for update to authenticated
  using (((select private.can_see_note(space, owner_id, deleted_at)) and private.note_studio_ok(props))
         or private.note_assigned_ok(props, deleted_at))
  with check (((select private.can_access_note(space, owner_id)) and private.note_studio_ok(props))
              or private.note_assigned_ok(props, deleted_at));

-- Reiter am Studio-PC: auch Aushilfen, die heute hier eingecheckt sind
create or replace function public.note_unlocked() returns table (user_id uuid, unlocked boolean)
language sql stable security definer set search_path = '' as $$
  with pc as (
    select k.location_id from public.kiosk_devices k
    where k.auth_user_id = (select auth.uid()) and k.is_active and k.kind = 'pc'
    limit 1
  )
  select u.auth_user_id, (not u.time_tracking or private.is_checked_in(u.id))
  from public.users u
  where u.is_active
    and u.auth_user_id is not null
    and (
      (select auth.uid()) is null
      or u.auth_user_id = (select auth.uid())
      or private.manages_user(u.id)
      or u.home_location_id = (select pc.location_id from pc)
      or private.checked_in_today_at(u.id, (select pc.location_id from pc))
    )
$$;

-- ---------------------------------------------------------------------------
-- Blitzi-Prestige
-- ---------------------------------------------------------------------------
create table if not exists public.blitzi_profiles (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  nickname   text check (nickname is null or char_length(nickname) between 2 and 20),
  prestige   integer not null default 0 check (prestige between 0 and 100),
  items      text[] not null default '{}',
  reset_day  date,                 -- Tag des letzten Prestiges: Blitzi zählt danach wieder ab Stufe 1
  updated_at timestamptz not null default now()
);
comment on table public.blitzi_profiles is 'Blitzi: Prestige (wie oft Stufe 30 + Item), Items (für immer), Spitzname';
alter table public.blitzi_profiles enable row level security;
drop policy if exists blitzi_profiles_select on public.blitzi_profiles;
create policy blitzi_profiles_select on public.blitzi_profiles for select to authenticated
  using ((select private.is_note_user()));
revoke insert, update, delete on public.blitzi_profiles from authenticated, anon;
grant select on public.blitzi_profiles to authenticated;

-- Stufe 30 erreicht → Item wählen (und beim ersten Mal den Spitznamen). Selbst oder am Studio-PC für die
-- Person, die dort gerade eingecheckt ist. Grobe Prüfung: seit dem letzten Prestige an mind. 29 Tagen Aufgaben.
create or replace function public.blitzi_prestige(p_user uuid, p_item text, p_nickname text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_prof public.blitzi_profiles;
  v_nick text := nullif(btrim(coalesce(p_nickname, '')), '');
  v_days integer;
  v_uid  uuid;
begin
  select u.id into v_uid from public.users u where u.auth_user_id = p_user and u.is_active;
  if v_uid is null then
    raise exception 'Person nicht gefunden.';
  end if;
  if not (p_user = (select auth.uid())
          or (private.is_studio_pc() and private.is_checked_in(v_uid))) then
    raise exception 'Nur für den eigenen Blitzi.' using errcode = '42501';
  end if;
  if p_item is null or p_item !~ '^[a-z0-9-]{2,40}$' then
    raise exception 'Unbekanntes Item.';
  end if;
  insert into public.blitzi_profiles (user_id) values (p_user) on conflict do nothing;
  select * into v_prof from public.blitzi_profiles where user_id = p_user for update;
  if v_prof.prestige >= 100 then
    raise exception 'Alle 100 Items sind schon gesammelt.';
  end if;
  if p_item = any (v_prof.items) then
    raise exception 'Dieses Item hat Blitzi schon.';
  end if;
  if v_prof.reset_day = (now() at time zone 'Europe/Berlin')::date then
    raise exception 'Heute gab es schon ein Prestige.';
  end if;
  if v_prof.prestige = 0 then
    if v_nick is null or char_length(v_nick) not between 2 and 20 or v_nick !~ '^[[:alnum:]äöüÄÖÜß .\-_]+$' then
      raise exception 'Spitzname: 2–20 Zeichen (Buchstaben, Zahlen, Leerzeichen, - . _).';
    end if;
  end if;
  select count(distinct (e.done_at at time zone 'Europe/Berlin')::date) into v_days
  from public.note_task_events e
  where e.user_id = p_user
    and (v_prof.reset_day is null or (e.done_at at time zone 'Europe/Berlin')::date > v_prof.reset_day);
  if v_days < 29 then
    raise exception 'Blitzi ist noch nicht auf Stufe 30.';
  end if;
  update public.blitzi_profiles
     set prestige = prestige + 1, items = items || p_item,
         nickname = coalesce(nickname, v_nick), reset_day = (now() at time zone 'Europe/Berlin')::date, updated_at = now()
   where user_id = p_user
  returning * into v_prof;
  return to_jsonb(v_prof);
end $$;

-- ---------------------------------------------------------------------------
-- Feierabend-Punkt: je abgegebener Ausstempel-Statistik +1 (nur Tag und Person, keine Zahlen)
-- ---------------------------------------------------------------------------
create or replace function public.note_bonus_points(p_since timestamptz) returns table (user_id uuid, done_at timestamptz, ref text)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not private.is_note_user() or to_regclass('public.shift_reports') is null then
    return;
  end if;
  return query execute
    'select u.auth_user_id, r.created_at, r.id::text
       from public.shift_reports r join public.users u on u.id = r.user_id and u.auth_user_id is not null
      where r.created_at >= $1'
    using p_since;
end $$;

revoke execute on function private.checked_in_today_at(uuid, uuid), private.note_studio_ok(jsonb) from public, anon;
grant execute on function private.checked_in_today_at(uuid, uuid), private.note_studio_ok(jsonb) to authenticated, service_role;
revoke execute on function public.note_here_today(), public.blitzi_prestige(uuid, text, text), public.note_bonus_points(timestamptz)
  from public, anon;
grant execute on function public.note_here_today(), public.blitzi_prestige(uuid, text, text), public.note_bonus_points(timestamptz)
  to authenticated, service_role;
