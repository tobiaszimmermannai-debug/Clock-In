-- =============================================================================
-- Clock-In · Schritt 1: Datenbankschema (Supabase / PostgreSQL 15+)
-- Zeiterfassung & Dienstplan für 4 Studios
-- =============================================================================
-- Rollenmodell
--   admin    : Vollzugriff auf alle Studios
--   manager  : Studioleitung, verwaltet die Studios aus location_managers
--   employee : Mitarbeiter, Read-Only-Portal + Schichttausch-Anträge
--   trainee  : Azubi, wie employee + Berufsschul-Gutschrift
--   Kiosk    : Tablet mit eigenem Auth-Account (kiosk_devices), KEIN users-Eintrag
--
-- Konventionen
--   * Zeitpunkte als timestamptz (UTC), Darstellung Europe/Berlin
--   * Dauern als integer-Minuten (keine Rundungsfehler)
--   * RLS-Hilfsfunktionen liegen im nicht per API erreichbaren Schema "private"
--   * Mitarbeiter werden deaktiviert (is_active = false), nie gelöscht
--     (Aufbewahrungspflicht für Arbeitszeitnachweise)
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 0. Extensions & Schemas
-- -----------------------------------------------------------------------------
create extension if not exists btree_gist with schema extensions;  -- Overlap-Constraint für Schichten

create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to authenticated, service_role;


-- -----------------------------------------------------------------------------
-- 1. Enums
-- -----------------------------------------------------------------------------
create type public.user_role       as enum ('admin', 'manager', 'employee', 'trainee');
create type public.shift_type      as enum ('work', 'vocational_school', 'vacation', 'sick');
create type public.time_event_type as enum ('clock_in', 'break_start', 'break_end', 'clock_out');
create type public.time_log_source as enum ('kiosk', 'offline_sync', 'auto_checkout', 'manual');
create type public.swap_status     as enum ('pending', 'approved', 'rejected', 'cancelled');


-- -----------------------------------------------------------------------------
-- 2. Tabellen
-- -----------------------------------------------------------------------------

-- Studios
create table public.locations (
  id         uuid primary key default gen_random_uuid(),
  code       text not null unique check (code ~ '^[A-Z]{2,10}$'),
  name       text not null,
  address    text,
  is_active  boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Mitarbeiter-Stammdaten: für alle Mitarbeiter sichtbar (Namen im Dienstplan).
-- Sensible Vertragsdaten liegen getrennt in employment_details.
create table public.users (
  id               uuid primary key default gen_random_uuid(),
  auth_user_id     uuid unique references auth.users (id) on delete set null,
  first_name       text not null,
  last_name        text not null,
  role             public.user_role not null default 'employee',
  home_location_id uuid references public.locations (id) on delete set null,
  is_active        boolean not null default true,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index users_home_location_idx on public.users (home_location_id);

-- Vertragsdaten (nur eigene Zeile / Studioleitung / Admin)
create table public.employment_details (
  user_id                   uuid primary key references public.users (id) on delete cascade,
  weekly_target_minutes     integer  not null default 2400 check (weekly_target_minutes between 0 and 3600),
  work_days_per_week        smallint not null default 5    check (work_days_per_week between 1 and 6),
  -- Azubi: Gutschrift pro Berufsschultag (480 = 8 h Pauschale), null = keine
  school_day_credit_minutes integer check (school_day_credit_minutes between 0 and 720),
  -- für JArbSchG (Minderjährige: andere Pausen-/Arbeitszeitregeln)
  birth_date                date,
  employment_start          date,
  employment_end            date,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  constraint employment_period check (employment_end is null or employment_start is null or employment_end >= employment_start)
);

-- Studioleitung ↔ Studio (n:m, z. B. Leitung für zwei Studios)
create table public.location_managers (
  user_id     uuid not null references public.users (id) on delete cascade,
  location_id uuid not null references public.locations (id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (user_id, location_id)
);
create index location_managers_location_idx on public.location_managers (location_id);

-- Kiosk-Tablets: je Tablet ein eigener Supabase-Auth-Account
create table public.kiosk_devices (
  id           uuid primary key default gen_random_uuid(),
  auth_user_id uuid not null unique references auth.users (id) on delete cascade,
  name         text not null,
  location_id  uuid references public.locations (id) on delete set null,  -- null = Standort am Tablet wählbar
  is_active    boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- Biometrie (Art. 9 DSGVO): nur 128-d Embeddings, keine Fotos.
-- Kiosk liest ausschließlich über RPC kiosk_roster(); Widerruf = Zeile löschen.
create table public.face_embeddings (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references public.users (id) on delete cascade,
  descriptor       real[] not null check (
                     array_ndims(descriptor) = 1
                     and array_length(descriptor, 1) = 128
                     and array_position(descriptor, null) is null
                   ),
  model            text not null default 'face-api.js/faceRecognitionNet',
  consent_given_at timestamptz not null,  -- schriftliche Einwilligung liegt vor
  created_by       uuid references public.users (id) on delete set null,
  created_at       timestamptz not null default now()
);
create index face_embeddings_user_idx on public.face_embeddings (user_id);

-- Dienstplan (inkl. Abwesenheiten / Berufsschule)
create table public.shifts (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.users (id) on delete restrict,
  location_id uuid references public.locations (id) on delete restrict,
  shift_type  public.shift_type not null default 'work',
  starts_at   timestamptz not null,
  ends_at     timestamptz not null,
  shift_date  date generated always as ((starts_at at time zone 'Europe/Berlin')::date) stored,
  note        text,
  created_by  uuid references public.users (id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint shifts_time_range        check (ends_at > starts_at and ends_at - starts_at <= interval '24 hours'),
  constraint shifts_location_required check (shift_type <> 'work' or location_id is not null),
  -- keine überlappenden Einträge pro Mitarbeiter; deferrable für atomaren Schichttausch
  constraint shifts_no_overlap exclude using gist (
    user_id extensions.gist_uuid_ops with =,
    tstzrange(starts_at, ends_at) with &&
  ) deferrable initially immediate
);
create index shifts_location_start_idx on public.shifts (location_id, starts_at);
create index shifts_date_idx           on public.shifts (shift_date);

-- Stempelbuchungen (append-only für Kiosk; Korrekturen nur Studioleitung/Admin, auditiert)
create table public.time_logs (
  id              uuid primary key default gen_random_uuid(),
  -- vom Tablet erzeugt (IndexedDB) → idempotenter Offline-Sync via ON CONFLICT DO NOTHING
  client_event_id uuid not null default gen_random_uuid() unique,
  user_id         uuid not null references public.users (id) on delete restrict,
  location_id     uuid not null references public.locations (id) on delete restrict,
  event_type      public.time_event_type not null,
  recorded_at     timestamptz not null,  -- reale Stempelzeit (Gerätezeit, auch offline)
  effective_at    timestamptz,           -- gekappte, abrechnungsrelevante Zeit (Regel-Engine, Schritt 3)
  shift_id        uuid references public.shifts (id) on delete set null,
  source          public.time_log_source not null default 'kiosk',
  kiosk_device_id uuid references public.kiosk_devices (id) on delete restrict,
  match_distance  real check (match_distance >= 0),  -- Face-Match-Distanz zur Qualitätskontrolle
  note            text,
  created_by      uuid references public.users (id) on delete set null,
  received_at     timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint time_logs_kiosk_device check (source not in ('kiosk', 'offline_sync') or kiosk_device_id is not null),
  constraint time_logs_manual_note  check (source <> 'manual' or note is not null)
);
create index time_logs_user_time_idx     on public.time_logs (user_id, recorded_at desc);
create index time_logs_location_time_idx on public.time_logs (location_id, recorded_at desc);
create index time_logs_shift_idx         on public.time_logs (shift_id);

-- Schichttausch: target_shift_id null = reine Übernahme, sonst Tausch
create table public.swap_requests (
  id                 uuid primary key default gen_random_uuid(),
  requester_id       uuid not null references public.users (id) on delete restrict,
  requester_shift_id uuid not null references public.shifts (id) on delete cascade,
  target_user_id     uuid not null references public.users (id) on delete restrict,
  target_shift_id    uuid references public.shifts (id) on delete cascade,
  status             public.swap_status not null default 'pending',
  reason             text,
  decided_by         uuid references public.users (id) on delete set null,
  decided_at         timestamptz,
  decision_note      text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint swap_distinct_users  check (requester_id <> target_user_id),
  constraint swap_distinct_shifts check (target_shift_id is distinct from requester_shift_id),
  constraint swap_decision        check ((status in ('approved', 'rejected')) = (decided_at is not null))
);
create unique index swap_requests_one_pending_idx on public.swap_requests (requester_shift_id) where status = 'pending';
create index swap_requests_requester_idx on public.swap_requests (requester_id);
create index swap_requests_target_idx    on public.swap_requests (target_user_id);
create index swap_requests_tshift_idx    on public.swap_requests (target_shift_id);

-- Revisionssicheres Änderungsprotokoll (nur per Trigger beschreibbar)
create table public.audit_log (
  id         bigint generated always as identity primary key,
  table_name text not null,
  record_id  text not null,
  action     text not null check (action in ('INSERT', 'UPDATE', 'DELETE')),
  old_data   jsonb,
  new_data   jsonb,
  changed_by uuid,  -- auth.uid(); null = System / Service-Role
  changed_at timestamptz not null default now()
);
create index audit_log_record_idx on public.audit_log (table_name, record_id);


-- -----------------------------------------------------------------------------
-- 3. RLS-Hilfsfunktionen (security definer → keine RLS-Rekursion)
-- -----------------------------------------------------------------------------
create function private.current_user_id() returns uuid
language sql stable security definer set search_path = '' as $$
  select u.id from public.users u
  where u.auth_user_id = (select auth.uid()) and u.is_active
$$;

create function private.is_staff() returns boolean
language sql stable security definer set search_path = '' as $$
  select private.current_user_id() is not null
$$;

create function private.is_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.users u
    where u.auth_user_id = (select auth.uid()) and u.is_active and u.role = 'admin'
  )
$$;

create function private.current_kiosk_id() returns uuid
language sql stable security definer set search_path = '' as $$
  select k.id from public.kiosk_devices k
  where k.auth_user_id = (select auth.uid()) and k.is_active
$$;

-- Admin oder Studioleitung des Standorts
create function private.manages_location(p_location_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select private.is_admin() or exists (
    select 1
    from public.location_managers lm
    join public.users u on u.id = lm.user_id
    where u.auth_user_id = (select auth.uid())
      and u.is_active and u.role = 'manager'
      and lm.location_id = p_location_id
  )
$$;

-- Admin oder Studioleitung des Heimatstudios des Mitarbeiters
create function private.manages_user(p_user_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select private.is_admin() or exists (
    select 1 from public.users t
    where t.id = p_user_id and private.manages_location(t.home_location_id)
  )
$$;

-- Darf Schicht planen? Standort-Schicht → Standortleitung, Abwesenheit → Leitung des Heimatstudios
create function private.can_plan_shift(p_location_id uuid, p_user_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select case when p_location_id is null then private.manages_user(p_user_id)
              else private.manages_location(p_location_id) end
$$;

create function private.manages_shift(p_shift_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.shifts s
    where s.id = p_shift_id and private.can_plan_shift(s.location_id, s.user_id)
  )
$$;

-- Kiosk darf für aktiven Mitarbeiter an aktivem (bzw. seinem fest zugewiesenen) Standort buchen
create function private.kiosk_may_book(p_device_id uuid, p_location_id uuid, p_user_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
           select 1 from public.kiosk_devices k
           where k.id = p_device_id and k.auth_user_id = (select auth.uid()) and k.is_active
             and (k.location_id is null or k.location_id = p_location_id))
     and exists (select 1 from public.locations l where l.id = p_location_id and l.is_active)
     and exists (select 1 from public.users u where u.id = p_user_id and u.is_active)
$$;

-- -----------------------------------------------------------------------------
-- 4. Trigger
-- -----------------------------------------------------------------------------
create function private.set_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- created_by immer serverseitig setzen (nicht fälschbar)
create function private.set_created_by() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  new.created_by := private.current_user_id();
  return new;
end $$;

create function private.audit_changes() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_row jsonb := case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end;
begin
  insert into public.audit_log (table_name, record_id, action, old_data, new_data, changed_by)
  values (
    tg_table_name,
    coalesce(v_row ->> 'id', v_row ->> 'user_id'),
    tg_op,
    case when tg_op <> 'INSERT' then to_jsonb(old) end,
    case when tg_op <> 'DELETE' then to_jsonb(new) end,
    auth.uid()
  );
  return null;
end $$;

-- Schichttausch: Validierung & erlaubte Statusübergänge
create function private.swap_requests_validate() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_me  uuid := private.current_user_id();
  v_req public.shifts;
  v_tgt public.shifts;
begin
  -- interne Folge-Updates (Auto-Storno aus swap_requests_apply) nicht erneut prüfen
  if pg_trigger_depth() > 1 then
    return new;
  end if;

  select * into v_req from public.shifts where id = new.requester_shift_id;
  if new.target_shift_id is not null then
    select * into v_tgt from public.shifts where id = new.target_shift_id;
  end if;

  if tg_op = 'INSERT' then
    new.status := 'pending';
    new.decided_by := null; new.decided_at := null; new.decision_note := null;

    if v_req.user_id is distinct from new.requester_id then
      raise exception 'Schichttausch: Die angegebene Schicht gehört nicht dem Antragsteller.';
    end if;
    if v_req.shift_type <> 'work' or v_req.starts_at <= now() then
      raise exception 'Schichttausch: Nur zukünftige Arbeitsschichten können getauscht werden.';
    end if;
    if not exists (select 1 from public.users where id = new.target_user_id and is_active) then
      raise exception 'Schichttausch: Ziel-Mitarbeiter ist nicht aktiv.';
    end if;
    if new.target_shift_id is not null and (
         v_tgt.user_id is distinct from new.target_user_id
         or v_tgt.shift_type <> 'work' or v_tgt.starts_at <= now()) then
      raise exception 'Schichttausch: Ungültige Gegenschicht.';
    end if;
    return new;
  end if;

  -- UPDATE
  if (new.requester_id, new.requester_shift_id, new.target_user_id, new.target_shift_id, new.created_at)
     is distinct from
     (old.requester_id, old.requester_shift_id, old.target_user_id, old.target_shift_id, old.created_at) then
    raise exception 'Schichttausch: Antragsdaten sind unveränderlich.';
  end if;
  if old.status <> 'pending' then
    raise exception 'Schichttausch: Antrag ist bereits abgeschlossen (%).', old.status;
  end if;

  case new.status
    when 'pending' then
      new.decided_by := null; new.decided_at := null;

    when 'cancelled' then
      if v_me is distinct from old.requester_id and not private.is_admin() then
        raise exception 'Schichttausch: Nur der Antragsteller kann stornieren.';
      end if;

    else  -- approved / rejected
      if not (private.manages_shift(new.requester_shift_id)
              and (new.target_shift_id is null or private.manages_shift(new.target_shift_id))) then
        raise exception 'Schichttausch: Freigabe nur durch Studioleitung oder Admin.';
      end if;
      if v_me = old.requester_id and not private.is_admin() then
        raise exception 'Schichttausch: Eigene Anträge können nicht selbst freigegeben werden.';
      end if;
      if new.status = 'approved' and (
           v_req.user_id <> old.requester_id or v_req.starts_at <= now()
           or (new.target_shift_id is not null
               and (v_tgt.user_id <> old.target_user_id or v_tgt.starts_at <= now()))) then
        raise exception 'Schichttausch: Schichten haben sich zwischenzeitlich geändert.';
      end if;
      new.decided_by := v_me;
      new.decided_at := now();
  end case;

  return new;
end $$;

-- Schichttausch: bei Freigabe Schichten atomar umschreiben, konkurrierende Anträge stornieren
create function private.swap_requests_apply() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.status = 'approved' and old.status = 'pending' then
    set constraints public.shifts_no_overlap deferred;

    update public.shifts set user_id = new.target_user_id where id = new.requester_shift_id;
    if new.target_shift_id is not null then
      update public.shifts set user_id = new.requester_id where id = new.target_shift_id;
    end if;

    update public.swap_requests
       set status = 'cancelled',
           decision_note = 'Automatisch storniert: Schicht wurde anderweitig getauscht.'
     where status = 'pending' and id <> new.id
       and (requester_shift_id in (new.requester_shift_id, new.target_shift_id)
            or target_shift_id in (new.requester_shift_id, new.target_shift_id));
  end if;
  return null;
end $$;

-- updated_at
create trigger set_updated_at before update on public.locations          for each row execute function private.set_updated_at();
create trigger set_updated_at before update on public.users              for each row execute function private.set_updated_at();
create trigger set_updated_at before update on public.employment_details for each row execute function private.set_updated_at();
create trigger set_updated_at before update on public.kiosk_devices      for each row execute function private.set_updated_at();
create trigger set_updated_at before update on public.shifts             for each row execute function private.set_updated_at();
create trigger set_updated_at before update on public.time_logs          for each row execute function private.set_updated_at();
create trigger set_updated_at before update on public.swap_requests      for each row execute function private.set_updated_at();

-- created_by
create trigger set_created_by before insert on public.shifts          for each row execute function private.set_created_by();
create trigger set_created_by before insert on public.time_logs       for each row execute function private.set_created_by();
create trigger set_created_by before insert on public.face_embeddings for each row execute function private.set_created_by();

-- Audit (Biometrie bewusst NICHT, damit Widerruf die Daten wirklich entfernt)
create trigger audit after insert or update or delete on public.shifts             for each row execute function private.audit_changes();
create trigger audit after update or delete           on public.time_logs          for each row execute function private.audit_changes();
create trigger audit after insert or update or delete on public.employment_details for each row execute function private.audit_changes();
create trigger audit after update or delete           on public.users              for each row execute function private.audit_changes();
create trigger audit after update                     on public.swap_requests      for each row execute function private.audit_changes();

-- Schichttausch-Workflow
create trigger validate before insert or update on public.swap_requests for each row execute function private.swap_requests_validate();
create trigger apply    after update             on public.swap_requests for each row execute function private.swap_requests_apply();


-- -----------------------------------------------------------------------------
-- 5. Row Level Security
-- -----------------------------------------------------------------------------
alter table public.locations          enable row level security;
alter table public.users              enable row level security;
alter table public.employment_details enable row level security;
alter table public.location_managers  enable row level security;
alter table public.kiosk_devices      enable row level security;
alter table public.face_embeddings    enable row level security;
alter table public.shifts             enable row level security;
alter table public.time_logs          enable row level security;
alter table public.swap_requests      enable row level security;
alter table public.audit_log          enable row level security;

-- locations: lesen Personal + Kiosk, schreiben Admin
create policy locations_select on public.locations for select to authenticated
  using ((select private.is_staff()) or (select private.current_kiosk_id()) is not null);
create policy locations_insert on public.locations for insert to authenticated
  with check ((select private.is_admin()));
create policy locations_update on public.locations for update to authenticated
  using ((select private.is_admin())) with check ((select private.is_admin()));
create policy locations_delete on public.locations for delete to authenticated
  using ((select private.is_admin()));

-- users: Namen für alle (Dienstplan/Kiosk), Pflege nur Admin
create policy users_select on public.users for select to authenticated
  using ((select private.is_staff()) or (select private.current_kiosk_id()) is not null);
create policy users_insert on public.users for insert to authenticated
  with check ((select private.is_admin()));
create policy users_update on public.users for update to authenticated
  using ((select private.is_admin())) with check ((select private.is_admin()));
create policy users_delete on public.users for delete to authenticated
  using ((select private.is_admin()));

-- employment_details: eigene Zeile, Studioleitung (Heimatstudio), Admin
create policy employment_select on public.employment_details for select to authenticated
  using (user_id = (select private.current_user_id()) or private.manages_user(user_id));
create policy employment_insert on public.employment_details for insert to authenticated
  with check ((select private.is_admin()));
create policy employment_update on public.employment_details for update to authenticated
  using ((select private.is_admin())) with check ((select private.is_admin()));
create policy employment_delete on public.employment_details for delete to authenticated
  using ((select private.is_admin()));

-- location_managers: lesen Personal, schreiben Admin
create policy location_managers_select on public.location_managers for select to authenticated
  using ((select private.is_staff()));
create policy location_managers_insert on public.location_managers for insert to authenticated
  with check ((select private.is_admin()));
create policy location_managers_delete on public.location_managers for delete to authenticated
  using ((select private.is_admin()));

-- kiosk_devices: Admin + das Tablet selbst
create policy kiosk_devices_select on public.kiosk_devices for select to authenticated
  using (auth_user_id = (select auth.uid()) or (select private.is_admin()));
create policy kiosk_devices_insert on public.kiosk_devices for insert to authenticated
  with check ((select private.is_admin()));
create policy kiosk_devices_update on public.kiosk_devices for update to authenticated
  using ((select private.is_admin())) with check ((select private.is_admin()));
create policy kiosk_devices_delete on public.kiosk_devices for delete to authenticated
  using ((select private.is_admin()));

-- face_embeddings: Auskunft/Widerruf durch Betroffene, Erfassung durch Leitung/Admin
create policy face_select on public.face_embeddings for select to authenticated
  using (user_id = (select private.current_user_id()) or (select private.is_admin()));
create policy face_insert on public.face_embeddings for insert to authenticated
  with check (private.manages_user(user_id));
create policy face_delete on public.face_embeddings for delete to authenticated
  using (user_id = (select private.current_user_id()) or private.manages_user(user_id));

-- shifts: Dienstplan aller 4 Studios für alle Mitarbeiter; Kiosk nur ±1 Tag
create policy shifts_select on public.shifts for select to authenticated
  using (
    (select private.is_staff())
    or ((select private.current_kiosk_id()) is not null
        and starts_at between now() - interval '1 day' and now() + interval '1 day')
  );
create policy shifts_insert on public.shifts for insert to authenticated
  with check (private.can_plan_shift(location_id, user_id));
create policy shifts_update on public.shifts for update to authenticated
  using (private.can_plan_shift(location_id, user_id))
  with check (private.can_plan_shift(location_id, user_id));
create policy shifts_delete on public.shifts for delete to authenticated
  using (private.can_plan_shift(location_id, user_id));

-- time_logs: Mitarbeiter nur eigene (read-only), Leitung ihr Studio, Kiosk letzte 8 Tage
create policy time_logs_select on public.time_logs for select to authenticated
  using (
    user_id = (select private.current_user_id())
    or private.manages_location(location_id)
    or ((select private.current_kiosk_id()) is not null and recorded_at > now() - interval '8 days')
  );
-- Kiosk-Buchung (live oder Offline-Nachsync bis 7 Tage, max. 5 Min. Uhrenabweichung)
create policy time_logs_insert_kiosk on public.time_logs for insert to authenticated
  with check (
    source in ('kiosk', 'offline_sync')
    and private.kiosk_may_book(kiosk_device_id, location_id, user_id)
    and recorded_at between now() - interval '7 days' and now() + interval '5 minutes'
  );
-- manuelle Nachbuchung durch Leitung/Admin (note = Pflicht, siehe Constraint)
create policy time_logs_insert_manual on public.time_logs for insert to authenticated
  with check (source = 'manual' and kiosk_device_id is null and private.manages_location(location_id));
create policy time_logs_update on public.time_logs for update to authenticated
  using (private.manages_location(location_id))
  with check (private.manages_location(location_id));
create policy time_logs_delete on public.time_logs for delete to authenticated
  using ((select private.is_admin()));

-- swap_requests: Beteiligte + zuständige Leitung; Statuslogik im Trigger
create policy swap_select on public.swap_requests for select to authenticated
  using (
    requester_id = (select private.current_user_id())
    or target_user_id = (select private.current_user_id())
    or private.manages_shift(requester_shift_id)
    or (target_shift_id is not null and private.manages_shift(target_shift_id))
  );
create policy swap_insert on public.swap_requests for insert to authenticated
  with check (requester_id = (select private.current_user_id()));
create policy swap_update on public.swap_requests for update to authenticated
  using (
    requester_id = (select private.current_user_id())
    or private.manages_shift(requester_shift_id)
    or (target_shift_id is not null and private.manages_shift(target_shift_id))
  );
create policy swap_delete on public.swap_requests for delete to authenticated
  using ((select private.is_admin()));

-- audit_log: nur Admin lesend
create policy audit_select on public.audit_log for select to authenticated
  using ((select private.is_admin()));


-- -----------------------------------------------------------------------------
-- 6. RPC für den Kiosk
-- -----------------------------------------------------------------------------
-- Liefert aktive Mitarbeiter inkl. Embeddings für den clientseitigen Abgleich.
-- Nur für Kiosk-Accounts (und Admin zum Testen).
create function public.kiosk_roster()
returns table (user_id uuid, first_name text, last_name text, descriptors jsonb)
language sql stable security definer set search_path = '' as $$
  select u.id, u.first_name, u.last_name, jsonb_agg(f.descriptor order by f.created_at)
  from public.users u
  join public.face_embeddings f on f.user_id = u.id
  where u.is_active
    and (private.current_kiosk_id() is not null or private.is_admin())
  group by u.id
$$;


-- -----------------------------------------------------------------------------
-- 7. Rechte (Defense in Depth)
-- -----------------------------------------------------------------------------
revoke all on all tables in schema public from anon;
revoke truncate on all tables in schema public from authenticated;  -- TRUNCATE umgeht RLS
revoke insert, update, delete on public.audit_log from authenticated;

revoke execute on all functions in schema private from public;
grant execute on all functions in schema private to authenticated, service_role;

revoke execute on function public.kiosk_roster() from public, anon;
grant execute on function public.kiosk_roster() to authenticated;


-- -----------------------------------------------------------------------------
-- 8. Realtime (Dienstplan, Buchungen, Tauschanträge; RLS gilt auch hier)
-- -----------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.shifts, public.time_logs, public.swap_requests;
  end if;
end $$;


-- -----------------------------------------------------------------------------
-- 9. Stammdaten
-- -----------------------------------------------------------------------------
insert into public.locations (code, name) values
  ('NORD', 'Studio Nord'),
  ('SUED', 'Studio Süd'),
  ('WEST', 'Studio West'),
  ('OST',  'Studio Ost')
on conflict (code) do nothing;

-- Ersten Admin anlegen (nach Registrierung in Supabase Auth, im SQL-Editor):
--   insert into public.users (auth_user_id, first_name, last_name, role)
--   values ('<auth.users.id>', '<Vorname>', '<Nachname>', 'admin');
--
-- Kiosk-Tablet registrieren (eigener Auth-User je Tablet):
--   insert into public.kiosk_devices (auth_user_id, name, location_id)
--   values ('<auth.users.id>', 'Tablet Nord', (select id from public.locations where code = 'NORD'));
