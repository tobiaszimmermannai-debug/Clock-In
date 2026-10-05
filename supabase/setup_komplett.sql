-- =============================================================================
-- Clock-In · KOMPLETT-SETUP für den Supabase SQL Editor (Ersteinrichtung)
-- Enthält alle Dateien aus supabase/migrations in richtiger Reihenfolge.
-- Kann nach einem fehlgeschlagenen Versuch einfach erneut ausgeführt werden.
-- Bricht automatisch ab, sobald echte Stempeldaten existieren (kein Datenverlust).
-- =============================================================================

do $$
declare
  v_has_data boolean := false;
begin
  if to_regclass('public.time_logs') is not null then
    execute 'select exists (select 1 from public.time_logs)' into v_has_data;
  end if;
  if v_has_data then
    raise exception 'Abbruch: Es gibt bereits Stempeldaten – dieses Skript ist nur für die Ersteinrichtung.';
  end if;
end $$;

-- Reste eines vorherigen Versuchs entfernen (nur Clock-In-Objekte)
drop table if exists
  public.staffing_alerts, public.rule_settings, public.biometric_consents, public.telegram_links, public.audit_log, public.swap_requests, public.time_logs, public.shifts,
  public.face_embeddings, public.kiosk_devices, public.location_managers, public.employment_details,
  public.users, public.locations
  cascade;
drop function if exists public.kiosk_roster();
drop function if exists public.am_i_admin();
drop function if exists public.absence_candidates(date);
drop function if exists public.work_day_summary(uuid, date, date);
drop function if exists public.weekly_report(date, date);
drop function if exists public.is_first_checkin(uuid);
drop schema if exists private cascade;
drop type if exists
  public.approval_status, public.swap_status, public.time_log_source,
  public.time_event_type, public.shift_type, public.user_role
  cascade;



-- >>> 20261005120000_initial_schema.sql

-- =============================================================================
-- Clock-In · Schritt 1: Datenbankschema (Supabase / PostgreSQL 15+)
-- Zeiterfassung & Dienstplan für 4 Studios
-- =============================================================================
-- Rollenmodell
--   admin    : Geschäftsführung/Verwaltung (eigener Login) – Vollzugriff, Nachträge, Freigaben
--   manager  : Studioleitung, verwaltet die Studios aus location_managers
--   employee : Mitarbeiter, Read-Only-Portal + Schichttausch-Anträge
--   trainee  : Azubi, wie employee + Berufsschul-Gutschrift
--   Kiosk    : Tablet mit eigenem Auth-Account (kiosk_devices), KEIN users-Eintrag
--
-- Buchungsregeln (time_logs)
--   * Kiosk live       : nur Echtzeit (±5 Min.)                    → sofort gültig
--   * Kiosk offline    : Nachsync vom selben Tag                   → sofort gültig
--                        Nachsync von Vortagen (max. 7 Tage)       → wartet auf Admin-OK
--   * Nachtrag Admin   : bis 7 Tage rückwirkend                    → sofort gültig
--   * Nachtrag Leitung : nur mit Recht can_backdate, bis 7 Tage   → wartet auf Admin-OK
--   * Es zählen nur Buchungen mit approval_status = 'approved'
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
create type public.approval_status as enum ('approved', 'pending', 'rejected');


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
  employment_start          date,
  employment_end            date,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  constraint employment_period check (employment_end is null or employment_start is null or employment_end >= employment_start)
);

-- Studioleitung ↔ Studio (n:m, z. B. Leitung für zwei Studios)
create table public.location_managers (
  user_id      uuid not null references public.users (id) on delete cascade,
  location_id  uuid not null references public.locations (id) on delete cascade,
  can_backdate boolean not null default false,  -- darf Nachträge erfassen (immer mit Admin-OK)
  created_at   timestamptz not null default now(),
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

-- Stempelbuchungen (append-only; Korrekturen & Freigaben nur Admin, auditiert)
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
  approval_status public.approval_status not null default 'approved',  -- serverseitig gesetzt (Trigger)
  reviewed_by     uuid references public.users (id) on delete set null,
  reviewed_at     timestamptz,
  review_note     text,
  created_by      uuid references public.users (id) on delete set null,
  received_at     timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint time_logs_kiosk_device check (source not in ('kiosk', 'offline_sync') or kiosk_device_id is not null),
  constraint time_logs_manual_note  check (source <> 'manual' or note is not null)
);
create index time_logs_user_time_idx     on public.time_logs (user_id, recorded_at desc);
create index time_logs_location_time_idx on public.time_logs (location_id, recorded_at desc);
create index time_logs_shift_idx         on public.time_logs (shift_id);
create index time_logs_pending_idx       on public.time_logs (received_at) where approval_status = 'pending';

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

-- Studioleitung mit Nachtrags-Recht für diesen Standort (Admins dürfen immer)
create function private.may_backdate(p_location_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
    from public.location_managers lm
    join public.users u on u.id = lm.user_id
    where u.auth_user_id = (select auth.uid())
      and u.is_active and u.role = 'manager'
      and lm.location_id = p_location_id and lm.can_backdate
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

-- Buchungen: Freigabestatus immer serverseitig bestimmen (Client-Werte werden ignoriert)
create function private.time_logs_approval() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_me    uuid := private.current_user_id();
  v_today date := (now() at time zone 'Europe/Berlin')::date;
begin
  -- System / Service-Role (Auto-Checkout, Freigabe per Telegram-Bot): Werte wie übergeben
  if auth.uid() is null then
    if tg_op = 'UPDATE' and new.approval_status is distinct from old.approval_status then
      new.reviewed_at := now();
    end if;
    return new;
  end if;

  if tg_op = 'INSERT' then
    new.created_by  := v_me;
    new.reviewed_by := null;
    new.reviewed_at := null;
    new.review_note := null;
    if new.source = 'manual' and private.is_admin() then
      new.approval_status := 'approved';            -- Nachtrag Admin: sofort gültig
      new.reviewed_by := v_me;
      new.reviewed_at := now();
    elsif new.source = 'manual'
       or (new.recorded_at at time zone 'Europe/Berlin')::date < v_today then
      new.approval_status := 'pending';             -- Nachtrag Leitung / Offline-Sync vom Vortag
    else
      new.approval_status := 'approved';            -- Kiosk, selber Tag
    end if;
    return new;
  end if;

  -- UPDATE (per RLS nur Admin): Freigabe/Ablehnung protokollieren
  if new.approval_status is distinct from old.approval_status then
    new.reviewed_by := v_me;
    new.reviewed_at := now();
  end if;
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
create trigger set_created_by before insert on public.face_embeddings for each row execute function private.set_created_by();

-- Freigabe-Workflow für Buchungen (setzt auch created_by)
create trigger approval before insert or update on public.time_logs for each row execute function private.time_logs_approval();

-- Audit (Biometrie bewusst NICHT, damit Widerruf die Daten wirklich entfernt)
create trigger audit after insert or update or delete on public.shifts             for each row execute function private.audit_changes();
create trigger audit after update or delete           on public.time_logs          for each row execute function private.audit_changes();
create trigger audit after insert or update or delete on public.employment_details for each row execute function private.audit_changes();
create trigger audit after update or delete           on public.users              for each row execute function private.audit_changes();
create trigger audit after update                     on public.swap_requests      for each row execute function private.audit_changes();
create trigger audit after insert or update or delete on public.location_managers  for each row execute function private.audit_changes();

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
create policy location_managers_update on public.location_managers for update to authenticated
  using ((select private.is_admin())) with check ((select private.is_admin()));
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

-- time_logs: Mitarbeiter nur eigene (read-only), Leitung ihr Studio.
-- Kiosk: alle der letzten 36 h (Stempelstatus inkl. Nachtschicht) + eigene 8 Tage
-- (nötig, weil ON CONFLICT DO NOTHING beim Offline-Sync die Lese-Policy prüft)
create policy time_logs_select on public.time_logs for select to authenticated
  using (
    user_id = (select private.current_user_id())
    or private.manages_location(location_id)
    or ((select private.current_kiosk_id()) is not null and (
          recorded_at > now() - interval '36 hours'
          or (kiosk_device_id = (select private.current_kiosk_id()) and recorded_at > now() - interval '8 days')))
  );
-- Kiosk: live nur Echtzeit (±5 Min.), Offline-Nachsync max. 7 Tage (Vortage → Admin-OK per Trigger)
create policy time_logs_insert_kiosk on public.time_logs for insert to authenticated
  with check (
    source in ('kiosk', 'offline_sync')
    and private.kiosk_may_book(kiosk_device_id, location_id, user_id)
    and recorded_at <= now() + interval '5 minutes'
    and recorded_at >= now() - case when source = 'kiosk' then interval '5 minutes' else interval '7 days' end
  );
-- Nachtrag (note = Pflicht): Admin sofort gültig, Studioleitung nur mit can_backdate → Admin-OK
create policy time_logs_insert_manual on public.time_logs for insert to authenticated
  with check (
    source = 'manual' and kiosk_device_id is null
    and ((select private.is_admin()) or private.may_backdate(location_id))
    and recorded_at between now() - interval '7 days' and now() + interval '5 minutes'
  );
-- Korrekturen & Freigaben nur Admin (auditiert)
create policy time_logs_update on public.time_logs for update to authenticated
  using ((select private.is_admin())) with check ((select private.is_admin()));
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


-- >>> 20261005130000_admin_mfa.sql

-- =============================================================================
-- Clock-In · 2FA für Admins
-- Admin-Rechte gelten nur in Sitzungen mit zweitem Faktor (Supabase MFA/TOTP,
-- JWT-Claim aal = 'aal2'). Ohne 2FA hat ein Admin-Konto nur Mitarbeiter-Rechte.
-- Wirkt automatisch auf alle Policies/Trigger, die private.is_admin() nutzen.
-- SQL-Editor / Service-Role sind nicht betroffen (umgehen RLS).
-- =============================================================================
create or replace function private.is_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select auth.jwt()) ->> 'aal', '') = 'aal2'
     and exists (
       select 1 from public.users u
       where u.auth_user_id = (select auth.uid()) and u.is_active and u.role = 'admin'
     )
$$;


-- >>> 20261005140000_telegram.sql

-- =============================================================================
-- Clock-In · Schritt 1b: Telegram-Benachrichtigungen
-- =============================================================================
-- Ablauf
--   time_logs INSERT → Trigger → pg_net → Edge Function "telegram" → Telegram
--   Button ✅/❌ in Telegram → Edge Function "telegram" → Freigabe in time_logs
--
-- Einmalige Einrichtung: docs/einrichtung.md (Vault-Secrets
-- edge_functions_url + notify_secret). Ohne diese Secrets bleibt der Trigger stumm.
-- =============================================================================

create extension if not exists pg_net;

-- Telegram-Chat ↔ Person (privater Chat: chat_id = Telegram-User-ID)
create table public.telegram_links (
  user_id         uuid primary key references public.users (id) on delete cascade,
  chat_id         bigint not null unique,
  notify_bookings boolean not null default true,  -- jede Stempelung melden; Freigabe-Anfragen kommen immer
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create trigger set_updated_at before update on public.telegram_links
  for each row execute function private.set_updated_at();
create trigger audit after insert or update or delete on public.telegram_links
  for each row execute function private.audit_changes();

alter table public.telegram_links enable row level security;

-- Verknüpfen nur Admin (mit 2FA); abmelden darf jeder selbst
create policy telegram_links_select on public.telegram_links for select to authenticated
  using (user_id = (select private.current_user_id()) or (select private.is_admin()));
create policy telegram_links_insert on public.telegram_links for insert to authenticated
  with check ((select private.is_admin()));
create policy telegram_links_update on public.telegram_links for update to authenticated
  using ((select private.is_admin())) with check ((select private.is_admin()));
create policy telegram_links_delete on public.telegram_links for delete to authenticated
  using (user_id = (select private.current_user_id()) or (select private.is_admin()));

revoke all on public.telegram_links from anon;
revoke truncate on public.telegram_links from authenticated;

-- Neue Buchung → Edge Function (asynchron über pg_net, blockiert das Stempeln nie)
create function private.notify_time_log() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_url    text;
  v_secret text;
begin
  select decrypted_secret into v_url    from vault.decrypted_secrets where name = 'edge_functions_url';
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'notify_secret';
  if v_url is null or v_secret is null then
    return null;  -- Telegram noch nicht eingerichtet
  end if;

  perform net.http_post(
    url     := v_url || '/telegram',
    body    := jsonb_build_object('type', 'time_log', 'id', new.id),
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-notify-secret', v_secret)
  );
  return null;
exception when others then
  raise warning 'Telegram-Benachrichtigung fehlgeschlagen: %', sqlerrm;
  return null;  -- Stempeln darf nie an Telegram scheitern
end $$;

create trigger notify_telegram after insert on public.time_logs
  for each row execute function private.notify_time_log();


-- >>> 20261006090000_consent_kiosk_accounts.sql

-- =============================================================================
-- Clock-In · Digitale Einwilligung (Biometrie) & Tablet-Konten mit Benutzernamen
-- =============================================================================
-- * Gesichtsdaten dürfen nur mit gültiger, unterschriebener Einwilligung gespeichert werden
-- * Widerruf oder Deaktivierung des Mitarbeiters löscht die Gesichtsdaten sofort
-- * Einwilligungen bleiben als Nachweis erhalten (nur widerrufbar, nicht änderbar)
-- =============================================================================

-- Einwilligung nach Art. 9 Abs. 2 lit. a DSGVO i. V. m. § 26 Abs. 2 BDSG
create table public.biometric_consents (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references public.users (id) on delete cascade,
  version       text not null,                                      -- Version des Einwilligungstexts
  consent_text  text not null check (length(consent_text) between 200 and 20000),  -- exakt angezeigter Text
  signed_name   text not null check (length(trim(signed_name)) >= 3),
  signature_svg text not null check (signature_svg like '<svg%' and length(signature_svg) <= 200000),
  given_at      timestamptz not null default now(),
  recorded_by   uuid references public.users (id) on delete set null,  -- anwesende Leitung/Admin
  revoked_at    timestamptz,
  revoked_by    uuid references public.users (id) on delete set null
);
create unique index biometric_consents_active_idx on public.biometric_consents (user_id) where revoked_at is null;

alter table public.face_embeddings
  add column consent_id uuid references public.biometric_consents (id) on delete cascade;

-- Tablet-Konten: Anmeldung per Benutzername (intern <name>@kiosk.clockin.invalid)
alter table public.kiosk_devices
  add column username text unique check (username ~ '^[a-z0-9][a-z0-9_-]{2,30}$');


-- -----------------------------------------------------------------------------
-- Trigger
-- -----------------------------------------------------------------------------

-- Neue Einwilligung: Zeitpunkt & aufnehmende Person serverseitig setzen
create function private.consent_before_insert() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  new.given_at    := now();
  new.recorded_by := private.current_user_id();
  new.revoked_at  := null;
  new.revoked_by  := null;
  return new;
end $$;

-- Einwilligung ist unveränderlich; einzig erlaubte Änderung: Widerruf
create function private.consent_before_update() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if old.revoked_at is not null then
    raise exception 'Diese Einwilligung wurde bereits widerrufen.';
  end if;
  if (new.user_id, new.version, new.consent_text, new.signed_name, new.signature_svg, new.given_at, new.recorded_by)
     is distinct from
     (old.user_id, old.version, old.consent_text, old.signed_name, old.signature_svg, old.given_at, old.recorded_by) then
    raise exception 'Eine Einwilligung kann nicht geändert, nur widerrufen werden.';
  end if;
  if new.revoked_at is null then
    raise exception 'Eine Einwilligung kann nicht geändert, nur widerrufen werden.';
  end if;
  new.revoked_at := now();
  new.revoked_by := private.current_user_id();
  return new;
end $$;

-- Widerruf → Gesichtsdaten sofort löschen
create function private.consent_after_revoke() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  delete from public.face_embeddings where user_id = new.user_id;
  return null;
end $$;

-- Gesichtsdaten nur mit gültiger Einwilligung; Verknüpfung serverseitig setzen
create function private.face_require_consent() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_consent public.biometric_consents;
begin
  select * into v_consent from public.biometric_consents
  where user_id = new.user_id and revoked_at is null;
  if v_consent.id is null then
    raise exception 'Keine gültige Einwilligung für biometrische Daten vorhanden.';
  end if;
  new.consent_id       := v_consent.id;
  new.consent_given_at := v_consent.given_at;
  return new;
end $$;

-- Mitarbeiter deaktiviert (Austritt) → Einwilligung beenden, Gesichtsdaten löschen
create function private.user_deactivated() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  update public.biometric_consents set revoked_at = now()
  where user_id = new.id and revoked_at is null;
  delete from public.face_embeddings where user_id = new.id;
  return null;
end $$;

create trigger before_insert before insert on public.biometric_consents
  for each row execute function private.consent_before_insert();
create trigger before_update before update on public.biometric_consents
  for each row execute function private.consent_before_update();
create trigger after_revoke after update of revoked_at on public.biometric_consents
  for each row when (old.revoked_at is null and new.revoked_at is not null)
  execute function private.consent_after_revoke();
create trigger require_consent before insert on public.face_embeddings
  for each row execute function private.face_require_consent();
create trigger deactivated after update of is_active on public.users
  for each row when (old.is_active and not new.is_active)
  execute function private.user_deactivated();


-- -----------------------------------------------------------------------------
-- RLS
-- -----------------------------------------------------------------------------
alter table public.biometric_consents enable row level security;

-- Betroffene sehen ihre eigene, Leitung/Admin die ihrer Mitarbeiter
create policy consents_select on public.biometric_consents for select to authenticated
  using (user_id = (select private.current_user_id()) or private.manages_user(user_id));
-- Unterschrift wird im Beisein der Leitung/Admin auf deren Gerät erfasst
create policy consents_insert on public.biometric_consents for insert to authenticated
  with check (private.manages_user(user_id));
-- Widerruf: Betroffene selbst oder Leitung/Admin (Inhalt sichert der Trigger)
create policy consents_update on public.biometric_consents for update to authenticated
  using (user_id = (select private.current_user_id()) or private.manages_user(user_id))
  with check (user_id = (select private.current_user_id()) or private.manages_user(user_id));

revoke all on public.biometric_consents from anon;
revoke truncate on public.biometric_consents from authenticated;


-- -----------------------------------------------------------------------------
-- RPC: Admin-Prüfung für Edge Functions (inkl. 2FA, siehe private.is_admin)
-- -----------------------------------------------------------------------------
create function public.am_i_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select private.is_admin()
$$;
revoke execute on function public.am_i_admin() from public, anon;
grant execute on function public.am_i_admin() to authenticated;

revoke execute on all functions in schema private from public;
grant execute on all functions in schema private to authenticated, service_role;


-- >>> 20261006120000_rules_engine.sql

-- =============================================================================
-- Clock-In · Schritt 3: Regel-Engine
-- =============================================================================
-- Regeln (Werte in rule_settings, durch Admins änderbar)
--   * Zu früh eingestempelt   → Arbeitszeit zählt ab Schichtbeginn
--   * Bis 5 Min. zu spät      → gilt als pünktlich (zählt ab Schichtbeginn)
--   * Mehr als 5 Min. zu spät → echte Zeit zählt, Verspätung wird ausgewiesen
--   * Nach Schichtende (> 5 Min.) → Überstunden nur nach Freigabe (Tobias/Dominik, Telegram)
--   * Kein Ausstempeln        → Auto-Checkout zur geplanten Endzeit (abends)
--   * Pausen nach § 4 ArbZG   → jede Pause zählt mind. 15 Min.; > 6 Std. Arbeit: 30 Min.,
--                               > 9 Std.: 45 Min.; Fehlendes wird abgezogen
--   * Einstempeln ohne Schicht → Aushilfsschicht wird automatisch im Dienstplan eingetragen
--   * Ohne Schicht & ohne Stempelung → 18 Uhr Telegram-Frage: Krank / IST / Urlaub (je 6,5 Std.) / Frei
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Einstellungen (eine Zeile)
-- -----------------------------------------------------------------------------
create table public.rule_settings (
  id                         boolean primary key default true check (id),
  late_tolerance_minutes     integer not null default 5   check (late_tolerance_minutes between 0 and 60),
  overtime_threshold_minutes integer not null default 5   check (overtime_threshold_minutes between 0 and 120),
  min_break_minutes          integer not null default 15  check (min_break_minutes between 0 and 60),
  absence_credit_minutes     integer not null default 390 check (absence_credit_minutes between 0 and 720),  -- Krank/IST/Urlaub
  help_shift_minutes         integer not null default 390 check (help_shift_minutes between 60 and 720),     -- Länge Aushilfsschicht
  absence_check_hour         integer not null default 18  check (absence_check_hour between 0 and 23),
  auto_checkout_hour         integer not null default 23  check (auto_checkout_hour between 0 and 23),
  updated_at                 timestamptz not null default now()
);
insert into public.rule_settings default values;

create trigger set_updated_at before update on public.rule_settings
  for each row execute function private.set_updated_at();
create trigger audit after update on public.rule_settings
  for each row execute function private.audit_changes();

alter table public.rule_settings enable row level security;
create policy rule_settings_select on public.rule_settings for select to authenticated
  using ((select private.is_staff()) or (select private.current_kiosk_id()) is not null);
create policy rule_settings_update on public.rule_settings for update to authenticated
  using ((select private.is_admin())) with check ((select private.is_admin()));
revoke all on public.rule_settings from anon;
revoke truncate on public.rule_settings from authenticated;

-- -----------------------------------------------------------------------------
-- Anpassungen bestehender Tabellen
-- -----------------------------------------------------------------------------
-- Gutschrift gilt einheitlich über rule_settings; berechnet wird live (work_day_summary)
alter table public.employment_details drop column school_day_credit_minutes;
alter table public.time_logs drop column effective_at;

-- Überstunden-Freigabe am Ausstempeln
alter table public.time_logs
  add column overtime_status      text check (overtime_status in ('pending', 'approved', 'rejected')),
  add column overtime_reviewed_by uuid references public.users (id) on delete set null,
  add column overtime_reviewed_at timestamptz;
create index time_logs_overtime_pending_idx on public.time_logs (received_at) where overtime_status = 'pending';

-- -----------------------------------------------------------------------------
-- Hilfsfunktionen
-- -----------------------------------------------------------------------------
-- Pflichtpause (§ 4 ArbZG) für eine Anwesenheit in Minuten. Abzug höchstens so weit,
-- dass nicht unter 6 bzw. 9 Std. gekürzt wird (z. B. 6:10 Std. ohne Pause → 6:00 Std.).
create function private.required_break(p_presence integer) returns integer
language sql immutable set search_path = '' as $$
  select case
    when p_presence <= 360 then 0
    when p_presence <= 390 then p_presence - 360
    when p_presence <= 570 then 30
    when p_presence <= 585 then p_presence - 540
    else 45
  end
$$;

-- Beginn eines Kalendertags in Berlin als Zeitpunkt
create function private.berlin_day_start(p_day date) returns timestamptz
language sql immutable set search_path = '' as $$
  select p_day::timestamp at time zone 'Europe/Berlin'
$$;

-- Aufruf der Edge Function "telegram" (asynchron, darf nie Fehler werfen)
create function private.call_telegram(p_body jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_url    text;
  v_secret text;
begin
  select decrypted_secret into v_url    from vault.decrypted_secrets where name = 'edge_functions_url';
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'notify_secret';
  if v_url is null or v_secret is null then
    return;
  end if;
  perform net.http_post(
    url     := v_url || '/telegram',
    body    := p_body,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-notify-secret', v_secret)
  );
exception when others then
  raise warning 'Telegram-Aufruf fehlgeschlagen: %', sqlerrm;
end $$;

-- -----------------------------------------------------------------------------
-- Buchung → Schicht zuordnen, Aushilfsschicht anlegen, Überstunden markieren
-- -----------------------------------------------------------------------------
create function private.time_logs_assign_shift() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_settings public.rule_settings;
  v_shift    public.shifts;
  v_clock_in public.time_logs;
begin
  select * into v_settings from public.rule_settings;

  if new.event_type = 'clock_in' then
    -- passende Arbeitsschicht: Beginn bis 3 Std. später als jetzt, noch nicht vorbei
    select * into v_shift from public.shifts
    where user_id = new.user_id and shift_type = 'work'
      and new.recorded_at >= starts_at - interval '3 hours' and new.recorded_at < ends_at
    order by abs(extract(epoch from starts_at - new.recorded_at))
    limit 1;

    -- keine Schicht → Aushilfsschicht im Dienstplan eintragen (nur für gültige Buchungen)
    if v_shift.id is null and new.approval_status = 'approved' then
      begin
        insert into public.shifts (user_id, location_id, shift_type, starts_at, ends_at, note)
        values (new.user_id, new.location_id, 'work', new.recorded_at,
                new.recorded_at + make_interval(mins => v_settings.help_shift_minutes),
                'Aushilfsschicht (automatisch eingetragen)')
        returning * into v_shift;
      exception when exclusion_violation then
        v_shift := null;  -- überschneidet sich mit anderer Schicht → ohne Schicht buchen
      end;
    end if;
    new.shift_id := coalesce(new.shift_id, v_shift.id);
    return new;
  end if;

  -- Pause/Gehen gehören zur Schicht des letzten Einstempelns
  if new.shift_id is null then
    select * into v_clock_in from public.time_logs
    where user_id = new.user_id and event_type = 'clock_in' and approval_status <> 'rejected'
      and recorded_at <= new.recorded_at and recorded_at > new.recorded_at - interval '16 hours'
    order by recorded_at desc
    limit 1;
    new.shift_id := v_clock_in.shift_id;
  end if;

  -- Gehen deutlich nach Schichtende → Überstunden brauchen Freigabe
  if new.event_type = 'clock_out' and new.shift_id is not null and new.source <> 'auto_checkout' then
    select * into v_shift from public.shifts where id = new.shift_id;
    if new.recorded_at > v_shift.ends_at + make_interval(mins => v_settings.overtime_threshold_minutes) then
      new.overtime_status := case when new.source = 'manual' and private.is_admin() then 'approved' else 'pending' end;
    else
      new.overtime_status := null;
    end if;
  end if;
  return new;
end $$;

-- Überstunden-Entscheidung protokollieren
create function private.time_logs_overtime_review() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.overtime_status is distinct from old.overtime_status then
    new.overtime_reviewed_by := coalesce(private.current_user_id(), new.overtime_reviewed_by);
    new.overtime_reviewed_at := now();
  end if;
  return new;
end $$;

create trigger assign_shift before insert on public.time_logs
  for each row execute function private.time_logs_assign_shift();
create trigger overtime_review before update on public.time_logs
  for each row execute function private.time_logs_overtime_review();

-- -----------------------------------------------------------------------------
-- Tagesauswertung (Soll/Ist-Basis für Handy-Portal und Wochenbericht)
-- -----------------------------------------------------------------------------
create function public.work_day_summary(p_user uuid, p_from date, p_to date)
returns table (
  day                       date,
  planned_minutes           integer,  -- geplante Arbeitsschichten
  worked_minutes            integer,  -- angerechnete Arbeitszeit (nach Kappung und Pausen)
  break_minutes             integer,  -- abgezogene Pausen
  credit_minutes            integer,  -- Gutschrift Krank / IST / Urlaub
  absence                   public.shift_type,
  late_minutes              integer,  -- Verspätung über der Toleranz
  overtime_pending_minutes  integer,
  overtime_approved_minutes integer,
  open_session              boolean   -- noch eingestempelt bzw. Ausstempeln fehlt
)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_settings public.rule_settings;
  v_day      date;
  v_from_ts  timestamptz;
  v_to_ts    timestamptz;
  ev         record;
  v_shift    public.shifts;
  v_in       timestamptz;
  v_break    timestamptz;
  v_breaks   integer;
  v_start    timestamptz;
  v_end      timestamptz;
  v_prev_end timestamptz;
  v_minutes  integer;
  v_presence integer;
  v_recorded integer;
  v_gaps     integer;
  v_extra    integer;
  v_started  uuid[];
begin
  -- eigene Daten, Leitung/Admin oder System (Service-Role)
  if auth.uid() is not null and p_user is distinct from private.current_user_id() and not private.manages_user(p_user) then
    raise exception 'Keine Berechtigung für diese Auswertung.';
  end if;
  if p_to - p_from > 92 then
    raise exception 'Zeitraum zu lang (max. 93 Tage).';
  end if;
  select * into v_settings from public.rule_settings;

  for v_day in select generate_series(p_from, p_to, interval '1 day')::date loop
    v_from_ts := private.berlin_day_start(v_day);
    v_to_ts   := private.berlin_day_start(v_day + 1);
    day := v_day;
    late_minutes := 0; overtime_pending_minutes := 0; overtime_approved_minutes := 0; open_session := false;
    v_presence := 0; v_recorded := 0; v_gaps := 0; v_prev_end := null;
    v_in := null; v_break := null; v_breaks := 0; v_started := '{}';

    select coalesce(sum(extract(epoch from s.ends_at - s.starts_at) / 60), 0)::integer into planned_minutes
    from public.shifts s
    where s.user_id = p_user and s.shift_type = 'work' and s.starts_at >= v_from_ts and s.starts_at < v_to_ts;

    select s.shift_type into absence
    from public.shifts s
    where s.user_id = p_user and s.shift_type <> 'work' and s.starts_at >= v_from_ts and s.starts_at < v_to_ts
    limit 1;
    credit_minutes := case when absence is null then 0 else v_settings.absence_credit_minutes end;

    for ev in
      select t.event_type, t.recorded_at, t.shift_id, t.overtime_status
      from public.time_logs t
      where t.user_id = p_user and t.approval_status = 'approved'
        and t.recorded_at >= v_from_ts and t.recorded_at < v_to_ts
      order by t.recorded_at
    loop
      if ev.event_type = 'clock_in' then
        v_in := ev.recorded_at; v_break := null; v_breaks := 0;
        select * into v_shift from public.shifts where id = ev.shift_id;
      elsif v_in is null then
        continue;  -- Pause/Gehen ohne Kommen: ignorieren
      elsif ev.event_type = 'break_start' then
        v_break := ev.recorded_at;
      elsif ev.event_type = 'break_end' and v_break is not null then
        v_minutes := ceil(extract(epoch from ev.recorded_at - v_break) / 60)::integer;
        v_breaks := v_breaks + greatest(v_minutes, v_settings.min_break_minutes);
        v_break := null;
      elsif ev.event_type = 'clock_out' then
        if v_break is not null then  -- Gehen während der Pause: Pause endet mit Gehen
          v_minutes := ceil(extract(epoch from ev.recorded_at - v_break) / 60)::integer;
          v_breaks := v_breaks + greatest(v_minutes, v_settings.min_break_minutes);
        end if;

        -- Beginn (nur beim ersten Einsatz der Schicht): zu früh → Schichtbeginn;
        -- bis Toleranz zu spät → Schichtbeginn; sonst echte Zeit und Verspätung
        v_start := v_in;
        if v_shift.id is not null and not (v_shift.id = any (v_started)) then
          v_started := v_started || v_shift.id;
          if v_in <= v_shift.starts_at + make_interval(mins => v_settings.late_tolerance_minutes) then
            v_start := v_shift.starts_at;
          else
            late_minutes := late_minutes + floor(extract(epoch from v_in - v_shift.starts_at) / 60)::integer;
          end if;
        end if;

        -- Ende: nach Schichtende nur mit Freigabe
        v_end := ev.recorded_at;
        if v_shift.id is not null and ev.recorded_at > v_shift.ends_at then
          v_minutes := floor(extract(epoch from ev.recorded_at - v_shift.ends_at) / 60)::integer;
          if ev.overtime_status = 'approved' then
            overtime_approved_minutes := overtime_approved_minutes + v_minutes;
          else
            v_end := v_shift.ends_at;
            if ev.overtime_status = 'pending' then
              overtime_pending_minutes := overtime_pending_minutes + v_minutes;
            end if;
          end if;
        end if;

        if v_end > v_start then
          v_presence := v_presence + floor(extract(epoch from v_end - v_start) / 60)::integer;
          v_recorded := v_recorded + v_breaks;
          if v_prev_end is not null and v_start > v_prev_end then
            v_gaps := v_gaps + floor(extract(epoch from v_start - v_prev_end) / 60)::integer;
          end if;
          v_prev_end := v_end;
        end if;
        v_in := null; v_break := null; v_breaks := 0;
      end if;
    end loop;
    open_session := v_in is not null;

    -- Pausen: gestempelt (je mind. 15 Min.) + Lücken zwischen Einsätzen; Fehlendes zur Pflichtpause abziehen
    v_recorded := least(v_recorded, v_presence);
    v_extra := greatest(0, private.required_break(v_presence) - v_recorded - v_gaps);
    break_minutes  := v_recorded + v_extra;
    worked_minutes := greatest(0, v_presence - break_minutes);
    return next;
  end loop;
end $$;

-- -----------------------------------------------------------------------------
-- Abendliche Jobs
-- -----------------------------------------------------------------------------
-- Offene Einsätze nach Schichtende automatisch zur geplanten Endzeit ausstempeln
create function private.auto_checkout() returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_open  record;
  v_count integer := 0;
begin
  for v_open in
    select distinct on (t.user_id) t.user_id, t.event_type, t.recorded_at, t.location_id, t.shift_id, s.ends_at
    from public.time_logs t
    left join public.shifts s on s.id = t.shift_id
    where t.approval_status = 'approved' and t.recorded_at > now() - interval '20 hours'
    order by t.user_id, t.recorded_at desc
  loop
    continue when v_open.event_type = 'clock_out' or v_open.ends_at is null or v_open.ends_at > now();
    insert into public.time_logs (user_id, location_id, event_type, recorded_at, source, shift_id, note)
    values (v_open.user_id, v_open.location_id, 'clock_out', greatest(v_open.ends_at, v_open.recorded_at),
            'auto_checkout', v_open.shift_id, 'Automatisch zur geplanten Endzeit ausgestempelt');
    v_count := v_count + 1;
  end loop;
  return v_count;
end $$;

-- Wer hatte heute weder Schicht noch Abwesenheit noch Stempelung – obwohl die Woche
-- noch nicht voll verplant ist? (Regelmäßige freie Tage lösen so keine Frage aus.)
create function public.absence_candidates(p_day date)
returns table (user_id uuid, first_name text, last_name text)
language sql stable security definer set search_path = '' as $$
  select u.id, u.first_name, u.last_name
  from public.users u
  left join public.employment_details e on e.user_id = u.id
  where u.is_active and u.role <> 'admin'
    and (e.employment_start is null or e.employment_start <= p_day)
    and (e.employment_end is null or e.employment_end >= p_day)
    and not exists (
      select 1 from public.shifts s
      where s.user_id = u.id and s.starts_at >= private.berlin_day_start(p_day) and s.starts_at < private.berlin_day_start(p_day + 1))
    and not exists (
      select 1 from public.time_logs t
      where t.user_id = u.id and t.approval_status <> 'rejected'
        and t.recorded_at >= private.berlin_day_start(p_day) and t.recorded_at < private.berlin_day_start(p_day + 1))
    and (
      select count(distinct s.shift_date) from public.shifts s
      where s.user_id = u.id
        and s.shift_date between date_trunc('week', p_day)::date and date_trunc('week', p_day)::date + 6
    ) < coalesce(e.work_days_per_week, 5)
  order by u.last_name, u.first_name
$$;

-- Antwort aus Telegram: Abwesenheit als Eintrag im Dienstplan (08:00 + Gutschrift)
create function public.record_absence(p_user uuid, p_day date, p_type public.shift_type, p_decided_by uuid)
returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  v_minutes integer;
  v_name    text;
begin
  if p_type = 'work' then
    raise exception 'Nur Krank, IST oder Urlaub.';
  end if;
  if exists (
    select 1 from public.shifts
    where user_id = p_user and starts_at >= private.berlin_day_start(p_day) and starts_at < private.berlin_day_start(p_day + 1)
  ) then
    return false;  -- bereits erfasst (z. B. vom anderen Admin)
  end if;
  select absence_credit_minutes into v_minutes from public.rule_settings;
  select first_name into v_name from public.users where id = p_decided_by;
  insert into public.shifts (user_id, location_id, shift_type, starts_at, ends_at, note, created_by)
  values (p_user, null, p_type, private.berlin_day_start(p_day) + interval '8 hours',
          private.berlin_day_start(p_day) + interval '8 hours' + make_interval(mins => v_minutes),
          'Per Telegram eingetragen' || coalesce(' von ' || v_name, ''), p_decided_by);
  return true;
end $$;

-- Stündlich aufgerufen; handelt zur eingestellten Berliner Uhrzeit (sommer-/winterzeitfest)
create function private.hourly_jobs() returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_settings public.rule_settings;
  v_hour     integer := extract(hour from now() at time zone 'Europe/Berlin');
begin
  select * into v_settings from public.rule_settings;
  if v_hour = v_settings.auto_checkout_hour then
    perform private.auto_checkout();
  end if;
  if v_hour = v_settings.absence_check_hour then
    perform private.call_telegram(jsonb_build_object(
      'type', 'absence_check', 'date', (now() at time zone 'Europe/Berlin')::date));
  end if;
end $$;

-- Nur für System (Telegram-Function mit Service-Role) bzw. Angemeldete
revoke execute on function public.absence_candidates(date) from public, anon, authenticated;
revoke execute on function public.record_absence(uuid, date, public.shift_type, uuid) from public, anon, authenticated;
grant execute on function public.absence_candidates(date) to service_role;
grant execute on function public.record_absence(uuid, date, public.shift_type, uuid) to service_role;
revoke execute on function public.work_day_summary(uuid, date, date) from public, anon;
grant execute on function public.work_day_summary(uuid, date, date) to authenticated, service_role;

revoke execute on all functions in schema private from public;
grant execute on all functions in schema private to authenticated, service_role;

-- Zeitplan (pg_cron): stündlich zur vollen Stunde
do $$
begin
  create extension if not exists pg_cron;
exception when others then
  raise notice 'pg_cron bitte unter Database → Extensions aktivieren: %', sqlerrm;
end $$;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    execute $job$select cron.schedule('clockin-hourly', '0 * * * *', 'select private.hourly_jobs()')$job$;
  end if;
end $$;


-- >>> 20261006150000_portal_swaps_report.sql

-- =============================================================================
-- Clock-In · Schritt 4/5: Mitarbeiter-Zugänge, Schichttausch per Telegram, Wochenbericht
-- =============================================================================

-- Mitarbeiter melden sich im Handy-Portal mit Benutzername an (intern <name>@team.clockin.invalid)
alter table public.users
  add column username text unique check (username ~ '^[a-z0-9][a-z0-9._-]{2,30}$');

-- Zeitpunkt des Wochenberichts (ISO-Wochentag: 1 = Mo … 5 = Fr)
alter table public.rule_settings
  add column weekly_report_dow  integer not null default 5  check (weekly_report_dow between 1 and 7),
  add column weekly_report_hour integer not null default 19 check (weekly_report_hour between 0 and 23);


-- -----------------------------------------------------------------------------
-- Schichttausch: primär im eigenen Studio. Studioübergreifend braucht die Freigabe
-- BEIDER Studioleitungen (Admin oder Telegram-Button eines Admins = beide).
-- -----------------------------------------------------------------------------
alter table public.swap_requests
  add column is_cross_studio   boolean not null default false,
  add column other_location_id uuid references public.locations (id) on delete set null,
  add column approved_own_by   uuid references public.users (id) on delete set null,  -- Leitung Studio der abgegebenen Schicht
  add column approved_other_by uuid references public.users (id) on delete set null;  -- Leitung des anderen Studios

-- Leitung des anderen Studios sieht und entscheidet den Antrag mit
drop policy swap_select on public.swap_requests;
drop policy swap_update on public.swap_requests;
create policy swap_select on public.swap_requests for select to authenticated
  using (
    requester_id = (select private.current_user_id())
    or target_user_id = (select private.current_user_id())
    or private.manages_shift(requester_shift_id)
    or (target_shift_id is not null and private.manages_shift(target_shift_id))
    or (other_location_id is not null and private.manages_location(other_location_id))
  );
create policy swap_update on public.swap_requests for update to authenticated
  using (
    requester_id = (select private.current_user_id())
    or private.manages_shift(requester_shift_id)
    or (target_shift_id is not null and private.manages_shift(target_shift_id))
    or (other_location_id is not null and private.manages_location(other_location_id))
  );
create or replace function private.swap_requests_validate() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_me     uuid := private.current_user_id();
  v_system boolean := auth.uid() is null;  -- Service-Role (Telegram-Button eines Admins)
  v_full   boolean;                         -- Admin/System: gibt für beide Studios frei
  v_own    boolean;
  v_other  boolean;
  v_req    public.shifts;
  v_tgt    public.shifts;
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
    new.approved_own_by := null; new.approved_other_by := null;
    -- anderes Studio = Studio der Gegenschicht bzw. Heimatstudio der übernehmenden Person
    new.other_location_id := coalesce(
      v_tgt.location_id,
      (select home_location_id from public.users where id = new.target_user_id));
    new.is_cross_studio := new.other_location_id is not null
                           and new.other_location_id is distinct from v_req.location_id;
    if not new.is_cross_studio then
      new.other_location_id := null;
    end if;

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
  if (new.requester_id, new.requester_shift_id, new.target_user_id, new.target_shift_id, new.created_at,
      new.is_cross_studio, new.other_location_id)
     is distinct from
     (old.requester_id, old.requester_shift_id, old.target_user_id, old.target_shift_id, old.created_at,
      old.is_cross_studio, old.other_location_id) then
    raise exception 'Schichttausch: Antragsdaten sind unveränderlich.';
  end if;
  if old.status <> 'pending' then
    raise exception 'Schichttausch: Antrag ist bereits abgeschlossen (%).', old.status;
  end if;

  case new.status
    when 'pending' then
      new.decided_by := null; new.decided_at := null;
      new.approved_own_by := old.approved_own_by; new.approved_other_by := old.approved_other_by;

    when 'cancelled' then
      if not v_system and v_me is distinct from old.requester_id and not private.is_admin() then
        raise exception 'Schichttausch: Nur der Antragsteller kann stornieren.';
      end if;

    else  -- approved / rejected
      v_full := v_system or private.is_admin();
      v_own := v_full or private.manages_location(v_req.location_id);
      v_other := v_full or (old.is_cross_studio and private.manages_location(old.other_location_id));
      if not (v_own or v_other) then
        raise exception 'Schichttausch: Freigabe nur durch die beteiligte Studioleitung oder Admin.';
      end if;
      if not v_system and v_me = old.requester_id and not private.is_admin() then
        raise exception 'Schichttausch: Eigene Anträge können nicht selbst freigegeben werden.';
      end if;

      -- Freigabe pro Studio vermerken; studioübergreifend erst komplett, wenn beide zugestimmt haben
      if new.status = 'approved' then
        new.approved_own_by   := coalesce(old.approved_own_by, case when v_own then coalesce(v_me, new.decided_by) end);
        new.approved_other_by := coalesce(old.approved_other_by, case when v_other then coalesce(v_me, new.decided_by) end);
        if old.is_cross_studio and (new.approved_own_by is null or new.approved_other_by is null) then
          new.status := 'pending';
          new.decided_by := null;
          new.decided_at := null;
          return new;
        end if;
      end if;

      if new.status = 'approved' and (
           v_req.user_id <> old.requester_id or v_req.starts_at <= now()
           or (new.target_shift_id is not null
               and (v_tgt.user_id <> old.target_user_id or v_tgt.starts_at <= now()))) then
        raise exception 'Schichttausch: Schichten haben sich zwischenzeitlich geändert.';
      end if;
      new.decided_by := coalesce(v_me, new.decided_by);
      new.decided_at := now();
  end case;

  return new;
end $$;

-- Neuer Tauschantrag → Telegram an die Admins (mit Freigabe-Buttons)
create function private.notify_swap_request() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform private.call_telegram(jsonb_build_object('type', 'swap_request', 'id', new.id));
  return null;
end $$;

create trigger notify_telegram after insert on public.swap_requests
  for each row execute function private.notify_swap_request();


-- -----------------------------------------------------------------------------
-- Wochenbericht (Freitag): Stunden, Verspätungen, Überstunden je Mitarbeiter
-- -----------------------------------------------------------------------------
create function public.weekly_report(p_from date, p_to date)
returns table (
  user_id                   uuid,
  first_name                text,
  last_name                 text,
  role                      public.user_role,
  target_minutes            integer,
  worked_minutes            integer,
  credit_minutes            integer,
  late_count                integer,
  late_minutes              integer,
  overtime_pending_minutes  integer,
  overtime_approved_minutes integer,
  open_days                 integer
)
language sql stable security definer set search_path = '' as $$
  select u.id, u.first_name, u.last_name, u.role,
         coalesce(e.weekly_target_minutes, 0),
         coalesce(sum(s.worked_minutes), 0)::integer,
         coalesce(sum(s.credit_minutes), 0)::integer,
         (count(*) filter (where s.late_minutes > 0))::integer,
         coalesce(sum(s.late_minutes), 0)::integer,
         coalesce(sum(s.overtime_pending_minutes), 0)::integer,
         coalesce(sum(s.overtime_approved_minutes), 0)::integer,
         (count(*) filter (where s.open_session))::integer
  from public.users u
  left join public.employment_details e on e.user_id = u.id
  cross join lateral public.work_day_summary(u.id, p_from, p_to) s
  where u.is_active and u.role <> 'admin'
  group by u.id, u.first_name, u.last_name, u.role, e.weekly_target_minutes
  order by u.last_name, u.first_name
$$;
revoke execute on function public.weekly_report(date, date) from public, anon, authenticated;
grant execute on function public.weekly_report(date, date) to service_role;

-- Stündlicher Job: Auto-Checkout, 18-Uhr-Abfrage, Wochenbericht
create or replace function private.hourly_jobs() returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_settings public.rule_settings;
  v_local    timestamp := now() at time zone 'Europe/Berlin';
  v_hour     integer := extract(hour from v_local);
begin
  select * into v_settings from public.rule_settings;
  if v_hour = v_settings.auto_checkout_hour then
    perform private.auto_checkout();
  end if;
  if v_hour = v_settings.absence_check_hour then
    perform private.call_telegram(jsonb_build_object('type', 'absence_check', 'date', v_local::date));
  end if;
  if extract(isodow from v_local) = v_settings.weekly_report_dow and v_hour = v_settings.weekly_report_hour then
    perform private.call_telegram(jsonb_build_object(
      'type', 'weekly_report', 'from', date_trunc('week', v_local)::date, 'to', v_local::date));
  end if;
end $$;

revoke execute on all functions in schema private from public;
grant execute on all functions in schema private to authenticated, service_role;


-- >>> 20261006180000_studio_staffing.sql

-- =============================================================================
-- Clock-In · Studio besetzt? Morgendliche Telegram-Meldungen
-- =============================================================================
-- * Erstes Einstempeln des Tages je Studio → "🟢 Studio Nord ist besetzt"
-- * 10 Min. nach der ersten geplanten Schicht noch niemand da → "🔴 noch nicht besetzt"
-- * Je Admin abschaltbar (Bot-Befehl /kurz bzw. /alle steuert Einzelmeldungen)
-- =============================================================================

alter table public.telegram_links
  add column notify_studio_status boolean not null default true;

-- Bereits gesendete Warnungen (höchstens eine je Studio und Tag)
create table public.staffing_alerts (
  location_id uuid not null references public.locations (id) on delete cascade,
  day         date not null,
  sent_at     timestamptz not null default now(),
  primary key (location_id, day)
);
alter table public.staffing_alerts enable row level security;
create policy staffing_alerts_select on public.staffing_alerts for select to authenticated
  using ((select private.is_admin()));
revoke all on public.staffing_alerts from anon;
revoke insert, update, delete, truncate on public.staffing_alerts from authenticated;

-- Ist diese Buchung das erste Einstempeln des Tages im Studio? (für die Telegram-Function)
create function public.is_first_checkin(p_log_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.time_logs me
    where me.id = p_log_id and me.event_type = 'clock_in' and me.approval_status = 'approved'
      and not exists (
        select 1 from public.time_logs t
        where t.location_id = me.location_id and t.event_type = 'clock_in' and t.approval_status = 'approved'
          and t.id <> me.id
          and t.recorded_at >= private.berlin_day_start((me.recorded_at at time zone 'Europe/Berlin')::date)
          and t.recorded_at <= me.recorded_at
      )
  )
$$;
revoke execute on function public.is_first_checkin(uuid) from public, anon, authenticated;
grant execute on function public.is_first_checkin(uuid) to service_role;

-- Alle 5 Min.: Studios mit geplanter Schicht, aber ohne Einstempeln → Warnung (einmal pro Tag)
create function private.staffing_check() returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_settings public.rule_settings;
  v_today    date := (now() at time zone 'Europe/Berlin')::date;
  v_plan     record;
  v_names    jsonb;
  v_count    integer := 0;
begin
  select * into v_settings from public.rule_settings;

  for v_plan in
    select s.location_id, l.name, min(s.starts_at) as first_start
    from public.shifts s
    join public.locations l on l.id = s.location_id and l.is_active
    where s.shift_type = 'work'
      and s.starts_at >= private.berlin_day_start(v_today)
      and s.starts_at < private.berlin_day_start(v_today + 1)
    group by s.location_id, l.name
  loop
    -- erst nach Toleranz + 5 Min. warnen, nicht mehr nach 3 Std.
    continue when now() < v_plan.first_start + make_interval(mins => v_settings.late_tolerance_minutes + 5)
               or now() > v_plan.first_start + interval '3 hours';
    continue when exists (
      select 1 from public.time_logs t
      where t.location_id = v_plan.location_id and t.event_type = 'clock_in' and t.approval_status = 'approved'
        and t.recorded_at >= private.berlin_day_start(v_today));

    insert into public.staffing_alerts (location_id, day) values (v_plan.location_id, v_today)
    on conflict do nothing;
    continue when not found;  -- heute schon gewarnt

    select jsonb_agg(u.first_name || ' ' || u.last_name order by u.first_name) into v_names
    from public.shifts s join public.users u on u.id = s.user_id
    where s.location_id = v_plan.location_id and s.shift_type = 'work' and s.starts_at = v_plan.first_start;

    perform private.call_telegram(jsonb_build_object(
      'type', 'studio_unstaffed',
      'location', v_plan.name,
      'start', to_char(v_plan.first_start at time zone 'Europe/Berlin', 'HH24:MI'),
      'names', coalesce(v_names, '[]'::jsonb)));
    v_count := v_count + 1;
  end loop;
  return v_count;
end $$;

revoke execute on all functions in schema private from public;
grant execute on all functions in schema private to authenticated, service_role;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    execute $job$select cron.schedule('clockin-staffing', '*/5 * * * *', 'select private.staffing_check()')$job$;
  end if;
end $$;


-- >>> 20261007090000_studio_names.sql

-- =============================================================================
-- Clock-In · Echte Studionamen: Krailling, Germering, Starnberg, Moosach
-- =============================================================================
update public.locations set code = 'KRAILLING', name = 'Studio Krailling' where code = 'NORD';
update public.locations set code = 'GERMERING', name = 'Studio Germering' where code = 'SUED';
update public.locations set code = 'STARNBERG', name = 'Studio Starnberg' where code = 'WEST';
update public.locations set code = 'MOOSACH',   name = 'Studio Moosach'   where code = 'OST';

-- Bereits angelegte Tablets mit altem Namen umbenennen (Benutzername bleibt gleich)
update public.kiosk_devices set name = 'Tablet Krailling' where name = 'Tablet Nord';
update public.kiosk_devices set name = 'Tablet Germering' where name = 'Tablet Süd';
update public.kiosk_devices set name = 'Tablet Starnberg' where name = 'Tablet West';
update public.kiosk_devices set name = 'Tablet Moosach'   where name = 'Tablet Ost';


select '✅ Clock-In Datenbank eingerichtet' as status, count(*) as studios from public.locations;
