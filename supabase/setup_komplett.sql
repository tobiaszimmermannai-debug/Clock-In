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
  public.vacation_allowances, public.help_requests, public.no_show_alerts, public.kiosk_qr, public.kiosk_networks, public.stamp_phones, public.staffing_alerts, public.rule_settings, public.biometric_consents, public.telegram_links, public.audit_log, public.swap_requests, public.time_logs, public.shifts,
  public.face_embeddings, public.kiosk_devices, public.location_managers, public.employment_details,
  public.users, public.locations
  cascade;
drop function if exists public.kiosk_roster();
drop function if exists public.am_i_admin();
drop function if exists public.absence_candidates(date);
drop function if exists public.work_day_summary(uuid, date, date);
drop function if exists public.weekly_report(date, date);
drop function if exists public.is_first_checkin(uuid);
drop function if exists public.kiosk_ping(uuid, timestamptz);
drop function if exists public.stamp_check(text, text);
drop function if exists public.stamp(text, public.time_event_type, text);
drop function if exists public.delete_tablet(uuid);
drop function if exists public.vacation_overview(integer);
drop function if exists public.report_sick(uuid, timestamptz);
drop function if exists public.fill_help_request(uuid, uuid);
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
  ('KRAILLING', 'Studio Krailling'),
  ('GERMERING', 'Studio Germering'),
  ('STARNBERG', 'Studio Starnberg'),
  ('MOOSACH',   'Studio Moosach')
on conflict (code) do nothing;

-- Ersten Admin anlegen (nach Registrierung in Supabase Auth, im SQL-Editor):
--   insert into public.users (auth_user_id, first_name, last_name, role)
--   values ('<auth.users.id>', '<Vorname>', '<Nachname>', 'admin');
--
-- Kiosk-Tablet registrieren (eigener Auth-User je Tablet):
--   insert into public.kiosk_devices (auth_user_id, name, location_id)
--   values ('<auth.users.id>', 'Tablet Krailling', (select id from public.locations where code = 'KRAILLING'));


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
-- * Erstes Einstempeln des Tages je Studio → "🟢 Studio Krailling ist besetzt"
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


-- >>> 20261007120000_phone_stamping.sql

-- =============================================================================
-- Clock-In · Stempeln mit Handy + Tablet (ersetzt die Gesichtserkennung)
-- =============================================================================
-- Zwei Faktoren je Buchung:
--   1. das eigene, registrierte Handy des Mitarbeiters (angemeldet im Portal)
--   2. der QR-Code am Tablet vor Ort – wechselt alle 30 Sek., also nur vor Ort lesbar
-- Zusätzlich muss das Handy im selben Netz (Studio-WLAN) sein wie das Tablet:
-- verglichen wird die öffentliche Adresse (IPv4 bzw. IPv6-/64-Präfix), mit der beide
-- bei Supabase ankommen. Browser können den WLAN-Namen nicht auslesen.
-- =============================================================================

-- Gesichtserkennung wird nicht mehr genutzt → Einwilligungen beenden, Gesichtsdaten löschen
update public.biometric_consents set revoked_at = now() where revoked_at is null;
delete from public.face_embeddings;

-- Aktueller QR-Code je Tablet (eigene Tabelle: kein Audit-Eintrag alle 30 Sek.)
create table public.kiosk_qr (
  device_id    uuid primary key references public.kiosk_devices (id) on delete cascade,
  token        text not null,
  prev_token   text,
  issued_at    timestamptz not null default now(),
  location_id  uuid not null references public.locations (id) on delete cascade,
  last_seen_at timestamptz not null default now()
);

-- Netze, in denen ein Tablet online war (öffentliche IPv4 /32 bzw. IPv6 /64)
create table public.kiosk_networks (
  device_id    uuid not null references public.kiosk_devices (id) on delete cascade,
  network      cidr not null,
  last_seen_at timestamptz not null default now(),
  primary key (device_id, network)
);

-- Registriertes Stempel-Handy je Mitarbeiter (nur Hash des Geräteschlüssels).
-- Ein Konto stempelt nur mit seinem Handy, ein Handy gehört nur zu einem Konto:
-- Kollegen können niemanden mit dem eigenen Handy einstempeln.
create table public.stamp_phones (
  user_id       uuid primary key references public.users (id) on delete cascade,
  key_hash      text not null unique,
  registered_at timestamptz not null default now()
);

alter table public.kiosk_qr       enable row level security;
alter table public.kiosk_networks enable row level security;
alter table public.stamp_phones   enable row level security;

create policy kiosk_qr_select on public.kiosk_qr for select to authenticated
  using ((select private.is_admin()));
create policy kiosk_networks_select on public.kiosk_networks for select to authenticated
  using ((select private.is_admin()));
-- Handy-Registrierung: sehen die Person selbst und ihre Leitung; zurücksetzen nur Leitung/Admin
create policy stamp_phones_select on public.stamp_phones for select to authenticated
  using (user_id = (select private.current_user_id()) or private.manages_user(user_id));
create policy stamp_phones_delete on public.stamp_phones for delete to authenticated
  using (private.manages_user(user_id));

revoke all on public.kiosk_qr, public.kiosk_networks, public.stamp_phones from anon;
revoke insert, update, delete, truncate on public.kiosk_qr, public.kiosk_networks from authenticated;
revoke insert, update, truncate on public.stamp_phones from authenticated;

create trigger audit after insert or delete on public.stamp_phones
  for each row execute function private.audit_changes();


-- Öffentliche Adresse des Aufrufers als Netz (IPv4 /32, IPv6 /64)
create function private.client_network() returns cidr
language plpgsql stable set search_path = '' as $$
declare
  v_headers jsonb := coalesce(nullif(current_setting('request.headers', true), '')::jsonb, '{}'::jsonb);
  v_ip      inet;
begin
  begin
    v_ip := trim(coalesce(
      v_headers ->> 'cf-connecting-ip',
      v_headers ->> 'x-real-ip',
      split_part(v_headers ->> 'x-forwarded-for', ',', 1)))::inet;
  exception when others then
    return null;
  end;
  return network(set_masklen(v_ip, case when family(v_ip) = 6 then 64 else 32 end));
end $$;

-- Tablet meldet sich alle paar Sekunden: Netz merken, QR-Code erneuern,
-- neue Buchungen an diesem Tablet zurückgeben (für die Begrüßung am Bildschirm)
create function public.kiosk_ping(p_location_id uuid default null, p_since timestamptz default null)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_device public.kiosk_devices;
  v_net    cidr := private.client_network();
  v_loc    uuid;
  v_qr     public.kiosk_qr;
  v_recent jsonb;
begin
  select * into v_device from public.kiosk_devices where auth_user_id = auth.uid() and is_active;
  if not found then
    raise exception 'Dieses Konto ist kein aktives Tablet.';
  end if;
  v_loc := coalesce(v_device.location_id, p_location_id);
  if not exists (select 1 from public.locations where id = v_loc and is_active) then
    raise exception 'Bitte am Tablet ein Studio wählen.';
  end if;

  if v_net is not null then
    insert into public.kiosk_networks (device_id, network) values (v_device.id, v_net)
    on conflict (device_id, network) do update set last_seen_at = now()
      where public.kiosk_networks.last_seen_at < now() - interval '1 minute';
  end if;

  select * into v_qr from public.kiosk_qr where device_id = v_device.id;
  if not found or v_qr.issued_at < now() - interval '30 seconds' or v_qr.location_id <> v_loc then
    insert into public.kiosk_qr (device_id, token, prev_token, issued_at, location_id, last_seen_at)
    values (v_device.id, encode(extensions.gen_random_bytes(12), 'hex'), null, now(), v_loc, now())
    on conflict (device_id) do update
      set prev_token = public.kiosk_qr.token, token = excluded.token, issued_at = now(),
          location_id = excluded.location_id, last_seen_at = now()
    returning * into v_qr;
  elsif v_qr.last_seen_at < now() - interval '1 minute' then
    update public.kiosk_qr set last_seen_at = now() where device_id = v_device.id;
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'first_name', u.first_name, 'event_type', t.event_type, 'recorded_at', t.recorded_at)
           order by t.received_at), '[]'::jsonb)
    into v_recent
  from public.time_logs t
  join public.users u on u.id = t.user_id
  where t.kiosk_device_id = v_device.id
    and t.received_at > greatest(coalesce(p_since, now()), now() - interval '1 minute');

  return jsonb_build_object('token', v_qr.token, 'location_id', v_loc, 'now', now(), 'recent', v_recent);
end $$;

-- Gemeinsame Prüfung für Handy-Stempelungen: Anmeldung, QR-Code, Netz, registriertes Handy
create function private.stamp_context(
  p_token text, p_phone_key text,
  out o_device uuid, out o_location uuid, out o_user uuid, out o_registered boolean)
language plpgsql security definer set search_path = '' as $$
declare
  v_net    cidr := private.client_network();
  v_hash   text;
  v_known  text;
  v_tablet text;
begin
  o_user := private.current_user_id();
  if o_user is null or not exists (select 1 from public.users where id = o_user and is_active) then
    raise exception 'Bitte im Mitarbeiter-Portal anmelden.';
  end if;

  select q.device_id, q.location_id into o_device, o_location
  from public.kiosk_qr q
  join public.kiosk_devices k on k.id = q.device_id and k.is_active
  where (q.token = p_token and q.issued_at > now() - interval '90 seconds')
     or (q.prev_token = p_token and q.issued_at > now() - interval '30 seconds');
  if o_device is null then
    raise exception 'QR-Code abgelaufen – bitte den aktuellen Code am Tablet scannen.';
  end if;

  if v_net is null or not exists (
       select 1 from public.kiosk_networks n
       where n.device_id = o_device and n.network = v_net and n.last_seen_at > now() - interval '12 hours') then
    select string_agg(host(n.network), ', ' order by n.last_seen_at desc) into v_tablet
    from public.kiosk_networks n where n.device_id = o_device and n.last_seen_at > now() - interval '12 hours';
    raise exception 'Dein Handy ist nicht im WLAN des Studios. Bitte mit dem Studio-WLAN verbinden (mobile Daten aus) und erneut scannen. [Handy %, Tablet %]',
      coalesce(host(v_net), '?'), coalesce(v_tablet, '?');
  end if;

  if coalesce(length(p_phone_key), 0) < 32 then
    raise exception 'Ungültiger Geräteschlüssel.';
  end if;
  v_hash := encode(extensions.digest(p_phone_key, 'sha256'), 'hex');
  select key_hash into v_known from public.stamp_phones where user_id = o_user;
  o_registered := false;
  if v_known is null then
    if exists (select 1 from public.stamp_phones where key_hash = v_hash) then
      raise exception 'Dieses Handy ist bereits für eine andere Person registriert. Bitte mit deinem eigenen Handy stempeln.';
    end if;
    insert into public.stamp_phones (user_id, key_hash) values (o_user, v_hash);
    o_registered := true;
    perform private.call_telegram(jsonb_build_object(
      'type', 'phone_registered',
      'name', (select first_name || ' ' || last_name from public.users where id = o_user),
      'location', (select name from public.locations where id = o_location)));
  elsif v_known <> v_hash then
    raise exception 'Stempeln geht nur mit deinem registrierten Handy. Neues Handy? Bitte Tobias oder Dominik, die Registrierung zurückzusetzen.';
  end if;
end $$;

-- Aktueller Stempelstatus: out / in / break (ältere offene Zustände gelten als vergessen)
create function private.stamp_state(p_user uuid, out o_state text, out o_since timestamptz)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_last public.time_logs;
begin
  select * into v_last from public.time_logs t
  where t.user_id = p_user and t.approval_status <> 'rejected' and t.recorded_at > now() - interval '16 hours'
  order by t.recorded_at desc limit 1;
  o_state := case v_last.event_type when 'clock_in' then 'in' when 'break_end' then 'in'
                                    when 'break_start' then 'break' else 'out' end;
  o_since := case when o_state <> 'out' then v_last.recorded_at end;
end $$;

-- Nach dem Scannen: prüfen (und Handy beim ersten Mal registrieren), Status zurückgeben
create function public.stamp_check(p_token text, p_phone_key text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_ctx   record;
  v_state record;
begin
  select * into v_ctx from private.stamp_context(p_token, p_phone_key);
  select * into v_state from private.stamp_state(v_ctx.o_user);
  return jsonb_build_object(
    'location', (select name from public.locations where id = v_ctx.o_location),
    'state', v_state.o_state, 'since', v_state.o_since, 'registered', v_ctx.o_registered);
end $$;

-- Buchen: Kommen / Pause Start / Pause Ende / Gehen – Zeitpunkt setzt der Server
create function public.stamp(p_token text, p_event public.time_event_type, p_phone_key text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_ctx   record;
  v_state record;
  v_seit  text;
  v_log   public.time_logs;
begin
  select * into v_ctx from private.stamp_context(p_token, p_phone_key);
  select * into v_state from private.stamp_state(v_ctx.o_user);
  v_seit := coalesce(' (seit ' || to_char(v_state.o_since at time zone 'Europe/Berlin', 'HH24:MI') || ')', '');

  if p_event = 'clock_in' and v_state.o_state = 'in' then
    raise exception 'Du bist bereits eingestempelt%.', v_seit;
  elsif p_event = 'clock_in' and v_state.o_state = 'break' then
    raise exception 'Du bist gerade in der Pause%. Bitte „Pause Ende“ wählen.', v_seit;
  elsif p_event = 'break_start' and v_state.o_state = 'out' then
    raise exception 'Du bist nicht eingestempelt. Bitte zuerst „Kommen“ wählen.';
  elsif p_event = 'break_start' and v_state.o_state = 'break' then
    raise exception 'Du bist bereits in der Pause%.', v_seit;
  elsif p_event = 'break_end' and v_state.o_state <> 'break' then
    raise exception 'Du bist gerade nicht in der Pause.';
  elsif p_event = 'clock_out' and v_state.o_state = 'out' then
    raise exception 'Du bist nicht eingestempelt.';
  end if;

  insert into public.time_logs (user_id, location_id, event_type, recorded_at, source, kiosk_device_id)
  values (v_ctx.o_user, v_ctx.o_location, p_event, now(), 'kiosk', v_ctx.o_device)
  returning * into v_log;

  return jsonb_build_object(
    'id', v_log.id, 'event_type', v_log.event_type, 'recorded_at', v_log.recorded_at,
    'location', (select name from public.locations where id = v_ctx.o_location));
end $$;

revoke execute on function public.kiosk_ping(uuid, timestamptz) from public, anon;
revoke execute on function public.stamp_check(text, text) from public, anon;
revoke execute on function public.stamp(text, public.time_event_type, text) from public, anon;
grant execute on function public.kiosk_ping(uuid, timestamptz) to authenticated;
grant execute on function public.stamp_check(text, text) to authenticated;
grant execute on function public.stamp(text, public.time_event_type, text) to authenticated;

revoke execute on all functions in schema private from public;
grant execute on all functions in schema private to authenticated, service_role;


-- >>> 20261007150000_forgotten_checkout.sql

-- =============================================================================
-- Clock-In · Ausstempeln vergessen = nur mit Freigabe
-- =============================================================================
-- Wer nicht ausstempelt, wird weiterhin automatisch zur geplanten Endzeit ausgestempelt –
-- die Zeit zählt aber erst, wenn Tobias oder Dominik per Telegram zustimmen.
-- Wer früher geht, ohne zu stempeln, bekommt so nicht automatisch bis Schichtende bezahlt.
-- Der Wochenbericht zeigt, wie oft jemand nicht ausgestempelt hat.
-- =============================================================================

create or replace function private.auto_checkout() returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_open  record;
  v_count integer := 0;
begin
  -- letzte nicht abgelehnte Buchung je Person (offene Freigaben zählen mit → keine Doppel-Einträge)
  for v_open in
    select distinct on (t.user_id) t.user_id, t.event_type, t.recorded_at, t.location_id, t.shift_id, s.ends_at
    from public.time_logs t
    left join public.shifts s on s.id = t.shift_id
    where t.approval_status <> 'rejected' and t.recorded_at > now() - interval '20 hours'
    order by t.user_id, t.recorded_at desc
  loop
    continue when v_open.event_type = 'clock_out' or v_open.ends_at is null or v_open.ends_at > now();
    insert into public.time_logs (user_id, location_id, event_type, recorded_at, source, shift_id, note, approval_status)
    values (v_open.user_id, v_open.location_id, 'clock_out', greatest(v_open.ends_at, v_open.recorded_at),
            'auto_checkout', v_open.shift_id, 'Ausstempeln vergessen – automatisch zur geplanten Endzeit eingetragen',
            'pending');
    v_count := v_count + 1;
  end loop;
  return v_count;
end $$;

-- Wochenbericht: zusätzlich Anzahl „nicht ausgestempelt“
drop function public.weekly_report(date, date);
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
  open_days                 integer,
  forgotten_count           integer
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
         (count(*) filter (where s.open_session))::integer,
         (select count(*) from public.time_logs t
          where t.user_id = u.id and t.source = 'auto_checkout'
            and t.recorded_at >= private.berlin_day_start(p_from)
            and t.recorded_at < private.berlin_day_start(p_to + 1))::integer
  from public.users u
  left join public.employment_details e on e.user_id = u.id
  cross join lateral public.work_day_summary(u.id, p_from, p_to) s
  where u.is_active and u.role <> 'admin'
  group by u.id, u.first_name, u.last_name, u.role, e.weekly_target_minutes
  order by u.last_name, u.first_name
$$;
revoke execute on function public.weekly_report(date, date) from public, anon, authenticated;
grant execute on function public.weekly_report(date, date) to service_role;

revoke execute on all functions in schema private from public;
grant execute on all functions in schema private to authenticated, service_role;


-- >>> 20261008090000_tablet_delete.sql

-- =============================================================================
-- Clock-In · Tablets löschen (Verwaltung → Tablets → Löschen, nur Admin)
-- =============================================================================
-- Ohne Stempelungen: Tablet und Login werden komplett gelöscht.
-- Mit Stempelungen: Tablet wird gesperrt und aus der Übersicht entfernt (archiviert) –
-- die Buchungen bleiben als Arbeitszeitnachweis mit ihrem Tablet verknüpft.
-- =============================================================================

alter table public.kiosk_devices add column archived_at timestamptz;

create function public.delete_tablet(p_device_id uuid) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_auth uuid;
begin
  if not private.is_admin() then
    raise exception 'Nur Admins dürfen Tablets löschen.';
  end if;
  select auth_user_id into v_auth from public.kiosk_devices where id = p_device_id;
  if not found then
    raise exception 'Tablet nicht gefunden.';
  end if;

  if exists (select 1 from public.time_logs where kiosk_device_id = p_device_id) then
    update public.kiosk_devices set is_active = false, archived_at = now() where id = p_device_id;
    return 'archived';
  end if;

  delete from public.kiosk_devices where id = p_device_id;
  begin
    delete from auth.users where id = v_auth;
  exception when others then
    null;  -- Login bleibt dann übrig, ist ohne Tablet-Eintrag aber nutzlos
  end;
  return 'deleted';
end $$;

revoke execute on function public.delete_tablet(uuid) from public, anon;
grant execute on function public.delete_tablet(uuid) to authenticated;


-- >>> 20261008120000_acquisition_shifts.sql

-- =============================================================================
-- Clock-In · Akquise-Schichten
-- =============================================================================
-- * Schalter „Akquise“ beim Planen: normale Arbeitsschicht (Stempeln, Stunden, Pausen wie
--   immer), das Studio zeigt, wo die Akquise stattfindet.
-- * Studioleitung plant normale Schichten nur im eigenen Studio. Akquise-Schichten darf sie
--   für ihre eigenen Leute auch in anderen Studios planen (z. B. Moosach → Krailling).
-- * Akquise zählt nicht als „Studio besetzt“ (betreut keine Trainings).
-- =============================================================================

alter table public.shifts
  add column is_acquisition boolean not null default false,
  add constraint shifts_acquisition_work check (not is_acquisition or shift_type = 'work');

-- Darf planen? Wie bisher – zusätzlich: Akquise für eigene Leute in jedem Studio
create function private.can_plan_shift(p_location_id uuid, p_user_id uuid, p_acquisition boolean) returns boolean
language sql stable security definer set search_path = '' as $$
  select private.can_plan_shift(p_location_id, p_user_id)
      or (p_acquisition and p_location_id is not null and private.manages_user(p_user_id))
$$;

drop policy shifts_insert on public.shifts;
drop policy shifts_update on public.shifts;
drop policy shifts_delete on public.shifts;
create policy shifts_insert on public.shifts for insert to authenticated
  with check (private.can_plan_shift(location_id, user_id, is_acquisition));
create policy shifts_update on public.shifts for update to authenticated
  using (private.can_plan_shift(location_id, user_id, is_acquisition))
  with check (private.can_plan_shift(location_id, user_id, is_acquisition));
create policy shifts_delete on public.shifts for delete to authenticated
  using (private.can_plan_shift(location_id, user_id, is_acquisition));

-- Schichttausch-Freigaben: Studioleitung, die die Schicht planen darf
create or replace function private.manages_shift(p_shift_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.shifts s
    where s.id = p_shift_id and private.can_plan_shift(s.location_id, s.user_id, s.is_acquisition)
  )
$$;

-- Erstes Einstempeln des Tages im Studio – Akquise-Stempelungen zählen nicht
create or replace function public.is_first_checkin(p_log_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.time_logs me
    where me.id = p_log_id and me.event_type = 'clock_in' and me.approval_status = 'approved'
      and not exists (select 1 from public.shifts a where a.id = me.shift_id and a.is_acquisition)
      and not exists (
        select 1 from public.time_logs t
        where t.location_id = me.location_id and t.event_type = 'clock_in' and t.approval_status = 'approved'
          and t.id <> me.id
          and t.recorded_at >= private.berlin_day_start((me.recorded_at at time zone 'Europe/Berlin')::date)
          and t.recorded_at <= me.recorded_at
          and not exists (select 1 from public.shifts a where a.id = t.shift_id and a.is_acquisition)
      )
  )
$$;

-- Studio noch nicht besetzt? Nur Trainer-Schichten zählen, Akquise nicht
create or replace function private.staffing_check() returns integer
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
    where s.shift_type = 'work' and not s.is_acquisition
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
        and t.recorded_at >= private.berlin_day_start(v_today)
        and not exists (select 1 from public.shifts a where a.id = t.shift_id and a.is_acquisition));

    insert into public.staffing_alerts (location_id, day) values (v_plan.location_id, v_today)
    on conflict do nothing;
    continue when not found;  -- heute schon gewarnt

    select jsonb_agg(u.first_name || ' ' || u.last_name order by u.first_name) into v_names
    from public.shifts s join public.users u on u.id = s.user_id
    where s.location_id = v_plan.location_id and s.shift_type = 'work' and not s.is_acquisition
      and s.starts_at = v_plan.first_start;

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


-- >>> 20261008150000_vacation_sick.sql

-- =============================================================================
-- Clock-In · Urlaub, Krank, Schule
-- =============================================================================
-- * Urlaubsanspruch (Tage pro Jahr) im Arbeitsvertrag; Zähler je Person:
--   Anspruch, genommen (bis heute), geplant, übrig – für Admin, Studioleitung und die Person selbst
-- * Krank: Studioleitung/Admin tauscht eine geplante Schicht gegen eine Krankheitsschicht – ganz
--   oder ab Uhrzeit (davor Gearbeitetes bleibt Arbeitsschicht). Die Studioleitung darf das für
--   Schichten in ihrem Studio und für alle Schichten ihrer eigenen Leute (auch Aushilfe/Akquise woanders).
-- * Gutschrift:
--   - Azubis: je Urlaubs-, Krank- und Schultag Wochenstunden ÷ 5,25 (einstellbar in
--     rule_settings.absence_week_days); Krank ab Uhrzeit anteilig (Krank-Zeit ÷ Schichtlänge).
--   - Alle anderen: Dauer des Eintrags – Urlaub/Schule ganztags 6,5 Std., Krank statt Schicht
--     mit den Stunden der (restlichen) Schicht.
--   Gegen Missbrauch: keine Selbst-Krankmeldung durch Mitarbeiter; Krank-Einträge ohne geplante
--   Schicht anlegen oder verlängern nur Admin.
-- =============================================================================

alter table public.employment_details
  add column vacation_days_per_year numeric(4,1) check (vacation_days_per_year between 0 and 365);

alter table public.rule_settings
  add column absence_week_days numeric(3,2) not null default 5.25 check (absence_week_days between 1 and 7);

-- Anteil eines Abwesenheitstags für Azubis (1 = ganzer Tag; Krank ab Uhrzeit = Krank-Zeit ÷ Schichtlänge)
alter table public.shifts
  add column credit_share numeric(4,3) not null default 1 check (credit_share > 0 and credit_share <= 1);

-- Urlaubstage im Jahr: Anspruch, genommen (bis heute), noch geplant – ein Urlaubstag je Kalendertag
create function public.vacation_overview(p_year integer)
returns table (user_id uuid, allowance numeric, taken integer, planned integer)
language sql stable security definer set search_path = '' as $$
  select u.id, e.vacation_days_per_year,
         count(distinct s.shift_date) filter (where s.shift_date <= (now() at time zone 'Europe/Berlin')::date)::integer,
         count(distinct s.shift_date) filter (where s.shift_date > (now() at time zone 'Europe/Berlin')::date)::integer
  from public.users u
  left join public.employment_details e on e.user_id = u.id
  left join public.shifts s on s.user_id = u.id and s.shift_type = 'vacation'
        and s.shift_date >= make_date(p_year, 1, 1) and s.shift_date < make_date(p_year + 1, 1, 1)
  where u.is_active and (u.id = private.current_user_id() or private.manages_user(u.id))
  group by u.id, e.vacation_days_per_year
$$;

-- Krank-Einträge: anlegen/ändern nur Admin; Studioleitung nur über report_sick (Schicht tauschen)
drop policy shifts_insert on public.shifts;
drop policy shifts_update on public.shifts;
create policy shifts_insert on public.shifts for insert to authenticated
  with check (private.can_plan_shift(location_id, user_id, is_acquisition)
              and (shift_type <> 'sick' or private.is_admin()));
create policy shifts_update on public.shifts for update to authenticated
  using (private.can_plan_shift(location_id, user_id, is_acquisition) and (shift_type <> 'sick' or private.is_admin()))
  with check (private.can_plan_shift(location_id, user_id, is_acquisition) and (shift_type <> 'sick' or private.is_admin()));

-- Geplante Schicht gegen Krankheitsschicht tauschen: Leitung des Studios der Schicht, Leitung des
-- Heimatstudios der Person (auch die eigene Schicht) bzw. Admin.
-- p_from = krank ab; leer oder Schichtbeginn → ganze Schicht.
create function public.report_sick(p_shift_id uuid, p_from timestamptz default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_shift public.shifts;
  v_from  timestamptz;
  v_loc   uuid;
  v_id    uuid;
begin
  select * into v_shift from public.shifts where id = p_shift_id for update;
  if not found or v_shift.shift_type <> 'work' then
    raise exception 'Nur geplante Schichten können gegen Krank getauscht werden.';
  end if;
  if not (private.can_plan_shift(v_shift.location_id, v_shift.user_id, v_shift.is_acquisition)
          or private.manages_user(v_shift.user_id)) then
    raise exception 'Dafür fehlt die Berechtigung.' using errcode = '42501';
  end if;
  v_from := greatest(coalesce(p_from, v_shift.starts_at), v_shift.starts_at);
  if v_from >= v_shift.ends_at then
    raise exception '„Krank ab“ muss vor dem Schichtende liegen.';
  end if;
  -- Krank-Eintrag beim Studio der Schicht; Akquise oder fremdes Studio → beim Heimatstudio
  v_loc := case when v_shift.is_acquisition or not private.manages_location(v_shift.location_id)
                then null else v_shift.location_id end;

  if v_from = v_shift.starts_at then
    update public.shifts
       set shift_type = 'sick', is_acquisition = false, location_id = v_loc, note = 'Krank statt Schicht', credit_share = 1
     where id = p_shift_id
    returning id into v_id;
  else
    update public.shifts set ends_at = v_from where id = p_shift_id;
    insert into public.shifts (user_id, location_id, shift_type, starts_at, ends_at, note, created_by, credit_share)
    values (v_shift.user_id, v_loc, 'sick', v_from, v_shift.ends_at, 'Krank statt Schicht', private.current_user_id(),
            round((extract(epoch from v_shift.ends_at - v_from) / extract(epoch from v_shift.ends_at - v_shift.starts_at))::numeric, 3))
    returning id into v_id;
  end if;
  return v_id;
end $$;

-- -----------------------------------------------------------------------------
-- Tagesauswertung: neue Gutschrift-Regel (sonst unverändert)
-- -----------------------------------------------------------------------------
create or replace function public.work_day_summary(p_user uuid, p_from date, p_to date)
returns table (
  day                       date,
  planned_minutes           integer,  -- geplante Arbeitsschichten
  worked_minutes            integer,  -- angerechnete Arbeitszeit (nach Kappung und Pausen)
  break_minutes             integer,  -- abgezogene Pausen
  credit_minutes            integer,  -- Gutschrift Krank / Schule / Urlaub
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
  v_daily    numeric;
begin
  -- eigene Daten, Leitung/Admin oder System (Service-Role)
  if auth.uid() is not null and p_user is distinct from private.current_user_id() and not private.manages_user(p_user) then
    raise exception 'Keine Berechtigung für diese Auswertung.';
  end if;
  if p_to - p_from > 92 then
    raise exception 'Zeitraum zu lang (max. 93 Tage).';
  end if;
  select * into v_settings from public.rule_settings;
  -- Azubis: ein Abwesenheitstag = Wochenstunden ÷ 5,25; sonst bleibt v_daily leer (Dauer zählt)
  select e.weekly_target_minutes / v_settings.absence_week_days into v_daily
  from public.employment_details e join public.users u on u.id = e.user_id
  where e.user_id = p_user and u.role = 'trainee';

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

    -- Gutschrift: Azubis Tagesanteil (höchstens ein Tag), sonst Dauer der Einträge
    select (array_agg(s.shift_type order by s.starts_at))[1],
           round(case when v_daily is null
                      then coalesce(sum(extract(epoch from s.ends_at - s.starts_at) / 60), 0)
                      else least(coalesce(sum(s.credit_share), 0), 1) * v_daily end)::integer
      into absence, credit_minutes
    from public.shifts s
    where s.user_id = p_user and s.shift_type <> 'work' and s.starts_at >= v_from_ts and s.starts_at < v_to_ts;

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

revoke execute on function public.vacation_overview(integer) from public, anon;
revoke execute on function public.report_sick(uuid, timestamptz) from public, anon;
grant execute on function public.vacation_overview(integer) to authenticated;
grant execute on function public.report_sick(uuid, timestamptz) to authenticated;


-- >>> 20261009090000_sick_days_good_boy.sql

-- =============================================================================
-- Clock-In · Krank-Tage durch die Studioleitung, „Good Boy“ am Tablet, „Noch nicht da“-Meldung
-- =============================================================================
-- * Studioleitung darf ihre Leute auch für ganze Tage ohne geplante Schicht krank eintragen.
--   Gutschrift dafür pauschal (6,5 Std. bzw. Azubis Wochenstunden ÷ 5,25) – unabhängig von den
--   eingetragenen Uhrzeiten, damit sich nichts „verlängern“ lässt.
-- * Krank statt Schicht (report_sick) wird markiert (from_shift) und zählt weiter mit der Schichtdauer;
--   setzen kann die Markierung nur report_sick bzw. ein Admin.
-- (Mehrfach ausführbar.)
-- * Tablet: beim Gehen spätestens zum Schichtende erscheint 3 Sekunden das „Good Boy“-Bild.
-- * Telegram: 5 Min. (Verspätungs-Toleranz) nach Schichtbeginn noch nicht eingestempelt → Meldung,
--   je Schicht einmal. Prüfung läuft jede Minute (Job clockin-staffing).
-- =============================================================================

alter table public.shifts add column if not exists from_shift boolean not null default false;
update public.shifts set from_shift = true where shift_type = 'sick' and note = 'Krank statt Schicht';

-- Krank-Einträge anlegen: Studioleitung und Admin; ändern weiterhin nur Admin (Studioleitung: löschen + neu)
drop policy if exists shifts_insert on public.shifts;
drop policy if exists shifts_update on public.shifts;
create policy shifts_insert on public.shifts for insert to authenticated
  with check (private.can_plan_shift(location_id, user_id, is_acquisition) and (not from_shift or private.is_admin()));
create policy shifts_update on public.shifts for update to authenticated
  using (private.can_plan_shift(location_id, user_id, is_acquisition) and (shift_type <> 'sick' or private.is_admin()))
  with check (private.can_plan_shift(location_id, user_id, is_acquisition) and (shift_type <> 'sick' or private.is_admin())
              and (not from_shift or private.is_admin()));

create or replace function public.report_sick(p_shift_id uuid, p_from timestamptz default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_shift public.shifts;
  v_from  timestamptz;
  v_loc   uuid;
  v_id    uuid;
begin
  select * into v_shift from public.shifts where id = p_shift_id for update;
  if not found or v_shift.shift_type <> 'work' then
    raise exception 'Nur geplante Schichten können gegen Krank getauscht werden.';
  end if;
  if not (private.can_plan_shift(v_shift.location_id, v_shift.user_id, v_shift.is_acquisition)
          or private.manages_user(v_shift.user_id)) then
    raise exception 'Dafür fehlt die Berechtigung.' using errcode = '42501';
  end if;
  v_from := greatest(coalesce(p_from, v_shift.starts_at), v_shift.starts_at);
  if v_from >= v_shift.ends_at then
    raise exception '„Krank ab“ muss vor dem Schichtende liegen.';
  end if;
  -- Krank-Eintrag beim Studio der Schicht; Akquise oder fremdes Studio → beim Heimatstudio
  v_loc := case when v_shift.is_acquisition or not private.manages_location(v_shift.location_id)
                then null else v_shift.location_id end;

  if v_from = v_shift.starts_at then
    update public.shifts
       set shift_type = 'sick', is_acquisition = false, location_id = v_loc, note = 'Krank statt Schicht', credit_share = 1, from_shift = true
     where id = p_shift_id
    returning id into v_id;
  else
    update public.shifts set ends_at = v_from where id = p_shift_id;
    insert into public.shifts (user_id, location_id, shift_type, starts_at, ends_at, note, created_by, credit_share, from_shift)
    values (v_shift.user_id, v_loc, 'sick', v_from, v_shift.ends_at, 'Krank statt Schicht', private.current_user_id(),
            round((extract(epoch from v_shift.ends_at - v_from) / extract(epoch from v_shift.ends_at - v_shift.starts_at))::numeric, 3), true)
    returning id into v_id;
  end if;
  return v_id;
end $$;

create or replace function public.work_day_summary(p_user uuid, p_from date, p_to date)
returns table (
  day                       date,
  planned_minutes           integer,  -- geplante Arbeitsschichten
  worked_minutes            integer,  -- angerechnete Arbeitszeit (nach Kappung und Pausen)
  break_minutes             integer,  -- abgezogene Pausen
  credit_minutes            integer,  -- Gutschrift Krank / Schule / Urlaub
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
  v_daily    numeric;
begin
  -- eigene Daten, Leitung/Admin oder System (Service-Role)
  if auth.uid() is not null and p_user is distinct from private.current_user_id() and not private.manages_user(p_user) then
    raise exception 'Keine Berechtigung für diese Auswertung.';
  end if;
  if p_to - p_from > 92 then
    raise exception 'Zeitraum zu lang (max. 93 Tage).';
  end if;
  select * into v_settings from public.rule_settings;
  -- Azubis: ein Abwesenheitstag = Wochenstunden ÷ 5,25; sonst bleibt v_daily leer (Dauer zählt)
  select e.weekly_target_minutes / v_settings.absence_week_days into v_daily
  from public.employment_details e join public.users u on u.id = e.user_id
  where e.user_id = p_user and u.role = 'trainee';

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

    -- Gutschrift: Azubis Tagesanteil (höchstens ein Tag), sonst Pauschale bzw. Schichtdauer
    select (array_agg(s.shift_type order by s.starts_at))[1],
           round(case when v_daily is null
                      -- ganzer Tag pauschal (höchstens einmal), Krank statt Schicht mit der Schichtdauer
                      then least(count(*) filter (where not s.from_shift), 1) * v_settings.absence_credit_minutes
                           + coalesce(sum(extract(epoch from s.ends_at - s.starts_at) / 60) filter (where s.from_shift), 0)
                      else least(coalesce(sum(s.credit_share), 0), 1) * v_daily end)::integer
      into absence, credit_minutes
    from public.shifts s
    where s.user_id = p_user and s.shift_type <> 'work' and s.starts_at >= v_from_ts and s.starts_at < v_to_ts;

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

create or replace function public.kiosk_ping(p_location_id uuid default null, p_since timestamptz default null)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_device public.kiosk_devices;
  v_net    cidr := private.client_network();
  v_loc    uuid;
  v_qr     public.kiosk_qr;
  v_recent jsonb;
  v_grace  integer;
begin
  select * into v_device from public.kiosk_devices where auth_user_id = auth.uid() and is_active;
  if not found then
    raise exception 'Dieses Konto ist kein aktives Tablet.';
  end if;
  v_loc := coalesce(v_device.location_id, p_location_id);
  if not exists (select 1 from public.locations where id = v_loc and is_active) then
    raise exception 'Bitte am Tablet ein Studio wählen.';
  end if;

  if v_net is not null then
    insert into public.kiosk_networks (device_id, network) values (v_device.id, v_net)
    on conflict (device_id, network) do update set last_seen_at = now()
      where public.kiosk_networks.last_seen_at < now() - interval '1 minute';
  end if;

  select * into v_qr from public.kiosk_qr where device_id = v_device.id;
  if not found or v_qr.issued_at < now() - interval '30 seconds' or v_qr.location_id <> v_loc then
    insert into public.kiosk_qr (device_id, token, prev_token, issued_at, location_id, last_seen_at)
    values (v_device.id, encode(extensions.gen_random_bytes(12), 'hex'), null, now(), v_loc, now())
    on conflict (device_id) do update
      set prev_token = public.kiosk_qr.token, token = excluded.token, issued_at = now(),
          location_id = excluded.location_id, last_seen_at = now()
    returning * into v_qr;
  elsif v_qr.last_seen_at < now() - interval '1 minute' then
    update public.kiosk_qr set last_seen_at = now() where device_id = v_device.id;
  end if;

  -- on_time: Gehen spätestens zum Schichtende (+ Überstunden-Schwelle) → Tablet zeigt „Good Boy“
  select overtime_threshold_minutes into v_grace from public.rule_settings;
  select coalesce(jsonb_agg(jsonb_build_object(
           'first_name', u.first_name, 'event_type', t.event_type, 'recorded_at', t.recorded_at,
           'on_time', t.event_type = 'clock_out' and s.id is not null
                      and t.recorded_at <= s.ends_at + make_interval(mins => coalesce(v_grace, 5)))
           order by t.received_at), '[]'::jsonb)
    into v_recent
  from public.time_logs t
  join public.users u on u.id = t.user_id
  left join public.shifts s on s.id = t.shift_id
  where t.kiosk_device_id = v_device.id
    and t.received_at > greatest(coalesce(p_since, now()), now() - interval '1 minute');

  return jsonb_build_object('token', v_qr.token, 'location_id', v_loc, 'now', now(), 'recent', v_recent);
end $$;

-- -----------------------------------------------------------------------------
-- Noch nicht da? (je Schicht eine Telegram-Meldung)
-- -----------------------------------------------------------------------------
create table if not exists public.no_show_alerts (
  shift_id uuid primary key references public.shifts (id) on delete cascade,
  sent_at  timestamptz not null default now()
);
alter table public.no_show_alerts enable row level security;  -- nur intern (keine Policies)

create or replace function private.no_show_check() returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_settings public.rule_settings;
  v_shift    record;
  v_count    integer := 0;
begin
  select * into v_settings from public.rule_settings;
  for v_shift in
    select s.id, s.user_id, s.starts_at, s.is_acquisition, u.first_name, u.last_name, l.name as location
    from public.shifts s
    join public.users u on u.id = s.user_id and u.is_active
    join public.locations l on l.id = s.location_id
    where s.shift_type = 'work'
      and s.starts_at <= now() - make_interval(mins => v_settings.late_tolerance_minutes)
      and s.starts_at > now() - interval '2 hours'
      and s.ends_at > now()
      and s.created_at < s.starts_at                                    -- nachträglich geplant → keine Meldung
      and (s.note is null or s.note not like 'Aushilfsschicht%')        -- entsteht erst beim Einstempeln
      -- eingestempelt (ab 1 Std. vor Beginn) …
      and not exists (
        select 1 from public.time_logs t
        where t.user_id = s.user_id and t.event_type = 'clock_in' and t.approval_status <> 'rejected'
          and t.recorded_at >= s.starts_at - interval '1 hour')
      -- … oder noch von vorher anwesend
      and coalesce((
        select t.event_type <> 'clock_out' from public.time_logs t
        where t.user_id = s.user_id and t.approval_status <> 'rejected' and t.recorded_at > now() - interval '14 hours'
        order by t.recorded_at desc limit 1), false) = false
  loop
    insert into public.no_show_alerts (shift_id) values (v_shift.id) on conflict do nothing;
    continue when not found;
    perform private.call_telegram(jsonb_build_object(
      'type', 'not_checked_in',
      'name', v_shift.first_name || ' ' || v_shift.last_name,
      'location', v_shift.location,
      'start', to_char(v_shift.starts_at at time zone 'Europe/Berlin', 'HH24:MI'),
      'acquisition', v_shift.is_acquisition));
    v_count := v_count + 1;
  end loop;
  return v_count;
end $$;

-- Jede Minute: Studio besetzt? + Wer ist noch nicht da?
create or replace function private.minute_checks() returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform private.staffing_check();
  perform private.no_show_check();
end $$;

revoke execute on all functions in schema private from public;
grant execute on all functions in schema private to authenticated, service_role;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    execute $job$select cron.schedule('clockin-staffing', '* * * * *', 'select private.minute_checks()')$job$;
  end if;
end $$;


-- >>> 20261009120000_help_requests.sql

-- =============================================================================
-- Clock-In · Aushilfe anfragen und stellen
-- =============================================================================
-- * Studioleitung fragt für ihr Studio eine Aushilfe an (Tag, von–bis, Hinweis).
--   Alle sehen offene Anfragen im Dienstplan („Aushilfe gesucht“).
-- * Leitung eines anderen Studios „stellt“ die Aushilfe: wählt eigenen Mitarbeiter → Schicht wird
--   direkt im anfragenden Studio eingetragen (fill_help_request). Ohne Anfrage bleiben normale
--   Schichten in fremden Studios gesperrt.
-- * Wird die gestellte Schicht gelöscht, ist die Anfrage automatisch wieder offen.
-- (Mehrfach ausführbar.)
-- =============================================================================

create table if not exists public.help_requests (
  id              uuid primary key default gen_random_uuid(),
  location_id     uuid not null references public.locations (id) on delete cascade,
  starts_at       timestamptz not null,
  ends_at         timestamptz not null,
  note            text check (char_length(note) <= 200),
  status          text not null default 'open' check (status in ('open', 'filled')),
  created_by      uuid default private.current_user_id() references public.users (id) on delete set null,
  created_at      timestamptz not null default now(),
  filled_shift_id uuid references public.shifts (id) on delete set null,
  filled_by       uuid references public.users (id) on delete set null,
  filled_at       timestamptz,
  constraint help_requests_time check (ends_at > starts_at and ends_at - starts_at <= interval '24 hours')
);
create index if not exists help_requests_start_idx on public.help_requests (starts_at);

alter table public.help_requests enable row level security;
-- sehen: alle Angemeldeten aus dem Team; anfragen/zurückziehen: Leitung des Studios
drop policy if exists help_requests_select on public.help_requests;
drop policy if exists help_requests_insert on public.help_requests;
drop policy if exists help_requests_delete on public.help_requests;
create policy help_requests_select on public.help_requests for select to authenticated
  using ((select private.is_staff()));
create policy help_requests_insert on public.help_requests for insert to authenticated
  with check (private.manages_location(location_id) and status = 'open'
              and filled_shift_id is null and filled_by is null and filled_at is null);
create policy help_requests_delete on public.help_requests for delete to authenticated
  using (private.manages_location(location_id) and status = 'open');
grant select, insert, delete on public.help_requests to authenticated;

-- Gestellte Schicht gelöscht → Anfrage wieder offen
create or replace function private.help_request_reopen() returns trigger
language plpgsql set search_path = '' as $$
begin
  if old.filled_shift_id is not null and new.filled_shift_id is null and new.status = 'filled' then
    new.status := 'open';
    new.filled_by := null;
    new.filled_at := null;
  end if;
  return new;
end $$;
drop trigger if exists help_request_reopen on public.help_requests;
create trigger help_request_reopen before update on public.help_requests
  for each row execute function private.help_request_reopen();

-- Aushilfe stellen: eigener Mitarbeiter (bzw. Admin: jeder) übernimmt die angefragte Zeit
create or replace function public.fill_help_request(p_request_id uuid, p_user_id uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_req   public.help_requests;
  v_home  text;
  v_shift uuid;
begin
  select * into v_req from public.help_requests where id = p_request_id for update;
  if not found then
    raise exception 'Anfrage nicht gefunden.';
  end if;
  if v_req.status <> 'open' then
    raise exception 'Diese Anfrage ist schon vergeben.';
  end if;
  if not private.manages_user(p_user_id) then
    raise exception 'Du kannst nur eigene Mitarbeiter als Aushilfe stellen.' using errcode = '42501';
  end if;
  if not exists (select 1 from public.users where id = p_user_id and is_active and role <> 'admin') then
    raise exception 'Mitarbeiter nicht gefunden.';
  end if;

  select l.name into v_home from public.users u join public.locations l on l.id = u.home_location_id where u.id = p_user_id;
  insert into public.shifts (user_id, location_id, shift_type, starts_at, ends_at, note, created_by)
  values (p_user_id, v_req.location_id, 'work', v_req.starts_at, v_req.ends_at,
          'Aushilfe' || coalesce(' aus ' || regexp_replace(v_home, '^Studio\s+', ''), ''), private.current_user_id())
  returning id into v_shift;

  update public.help_requests
     set status = 'filled', filled_shift_id = v_shift, filled_by = private.current_user_id(), filled_at = now()
   where id = p_request_id;
  return v_shift;
end $$;

revoke execute on function public.fill_help_request(uuid, uuid) from public, anon;
grant execute on function public.fill_help_request(uuid, uuid) to authenticated;
revoke execute on all functions in schema private from public;
grant execute on all functions in schema private to authenticated, service_role;


-- >>> 20261009150000_help_without_request.sql

-- =============================================================================
-- Clock-In · Aushilfe stellen ohne Anfrage
-- =============================================================================
-- Studioleitung darf ihre eigenen Leute in jedem Studio einplanen (Aushilfe, telefonisch/WhatsApp
-- abgesprochen) – normale Schichten wie Akquise. Fremde Leute in fremden Studios bleiben gesperrt.
-- Die Leitung des Studios, in dem gearbeitet wird, kann die Schicht weiterhin ändern/löschen.
-- Anfragen im Programm („Aushilfe gesucht“) bleiben optional.
-- =============================================================================

create or replace function private.can_plan_shift(p_location_id uuid, p_user_id uuid, p_acquisition boolean) returns boolean
language sql stable security definer set search_path = '' as $$
  select private.can_plan_shift(p_location_id, p_user_id)
      or (p_location_id is not null and private.manages_user(p_user_id))
$$;

revoke execute on all functions in schema private from public;
grant execute on all functions in schema private to authenticated, service_role;


-- >>> 20261009180000_sick_documents.sql

-- =============================================================================
-- Clock-In · Krankheit: Attest / Karenztag-Zettel abhaken (nur Admin)
-- =============================================================================
-- Je Krank-Eintrag zwei Haken; die Übersicht „Krankheit“ fasst zusammenhängende Tage zu einem
-- Fall zusammen und setzt die Haken für alle Tage des Falls. Studioleitung kann sie nicht setzen.
-- (Mehrfach ausführbar.)
-- =============================================================================

alter table public.shifts
  add column if not exists attest_received boolean not null default false,
  add column if not exists karenz_received boolean not null default false;

alter table public.shifts drop constraint if exists shifts_sick_documents;
alter table public.shifts add constraint shifts_sick_documents
  check (shift_type = 'sick' or (not attest_received and not karenz_received));

-- Anlegen: Haken nur durch Admin (Ändern von Krank-Einträgen ist ohnehin nur Admin erlaubt)
drop policy if exists shifts_insert on public.shifts;
create policy shifts_insert on public.shifts for insert to authenticated
  with check (private.can_plan_shift(location_id, user_id, is_acquisition)
              and (not from_shift or private.is_admin())
              and ((not attest_received and not karenz_received) or private.is_admin()));


-- >>> 20261010090000_unknown_phone.sql

-- =============================================================================
-- Clock-In · Anderes Handy: Buchung zur Freigabe statt Sperre
-- =============================================================================
-- Der Handy-Schlüssel liegt im Browser-Speicher. Beim iPhone haben die installierte App und Safari
-- (Kamera-Scan) getrennten Speicher; eine andere App-Adresse hat ebenfalls eigenen Speicher. Dann
-- wirkt das Handy „neu“. Statt zu sperren: Buchung wird gespeichert, wartet aber auf Freigabe
-- (Telegram ✅/❌ oder Verwaltung → Freigaben). Mit ✅ zählt sie und dieses Handy/dieser Browser wird
-- für die Person gemerkt (mehrere möglich); weitere offene Buchungen davon werden mit freigegeben.
-- Ein Handy, das einer anderen Person gehört, bleibt gesperrt. (Mehrfach ausführbar.)
-- =============================================================================

-- Mehrere Handys/Browser je Person
alter table public.stamp_phones drop constraint if exists stamp_phones_pkey;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'stamp_phones_key_pkey') then
    alter table public.stamp_phones add constraint stamp_phones_key_pkey primary key (key_hash);
  end if;
end $$;
create index if not exists stamp_phones_user_idx on public.stamp_phones (user_id);

alter table public.time_logs
  add column if not exists device_unverified boolean not null default false,
  add column if not exists device_key_hash text;

create or replace function private.time_logs_approval() returns trigger
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
    elsif new.device_unverified then
      new.approval_status := 'pending';             -- anderes Handy/Browser: erst nach Freigabe
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

drop function if exists private.stamp_context(text, text);
create function private.stamp_context(
  p_token text, p_phone_key text,
  out o_device uuid, out o_location uuid, out o_user uuid, out o_registered boolean,
  out o_unverified boolean, out o_key_hash text)
language plpgsql security definer set search_path = '' as $$
declare
  v_net    cidr := private.client_network();
  v_hash   text;
  v_tablet text;
begin
  o_user := private.current_user_id();
  if o_user is null or not exists (select 1 from public.users where id = o_user and is_active) then
    raise exception 'Bitte im Mitarbeiter-Portal anmelden.';
  end if;

  select q.device_id, q.location_id into o_device, o_location
  from public.kiosk_qr q
  join public.kiosk_devices k on k.id = q.device_id and k.is_active
  where (q.token = p_token and q.issued_at > now() - interval '90 seconds')
     or (q.prev_token = p_token and q.issued_at > now() - interval '30 seconds');
  if o_device is null then
    raise exception 'QR-Code abgelaufen – bitte den aktuellen Code am Tablet scannen.';
  end if;

  if v_net is null or not exists (
       select 1 from public.kiosk_networks n
       where n.device_id = o_device and n.network = v_net and n.last_seen_at > now() - interval '12 hours') then
    select string_agg(host(n.network), ', ' order by n.last_seen_at desc) into v_tablet
    from public.kiosk_networks n where n.device_id = o_device and n.last_seen_at > now() - interval '12 hours';
    raise exception 'Dein Handy ist nicht im WLAN des Studios. Bitte mit dem Studio-WLAN verbinden (mobile Daten aus) und erneut scannen. [Handy %, Tablet %]',
      coalesce(host(v_net), '?'), coalesce(v_tablet, '?');
  end if;

  if coalesce(length(p_phone_key), 0) < 32 then
    raise exception 'Ungültiger Geräteschlüssel.';
  end if;
  v_hash := encode(extensions.digest(p_phone_key, 'sha256'), 'hex');
  o_key_hash := v_hash;
  o_registered := false;
  o_unverified := false;
  if exists (select 1 from public.stamp_phones where key_hash = v_hash and user_id <> o_user) then
    raise exception 'Dieses Handy ist bereits für eine andere Person registriert. Bitte mit deinem eigenen Handy stempeln.';
  end if;
  if not exists (select 1 from public.stamp_phones where user_id = o_user) then
    -- erstes Handy: automatisch registrieren, Admins bekommen eine Meldung
    insert into public.stamp_phones (user_id, key_hash) values (o_user, v_hash);
    o_registered := true;
    perform private.call_telegram(jsonb_build_object(
      'type', 'phone_registered',
      'name', (select first_name || ' ' || last_name from public.users where id = o_user),
      'location', (select name from public.locations where id = o_location)));
  elsif not exists (select 1 from public.stamp_phones where user_id = o_user and key_hash = v_hash) then
    -- anderes Handy/Browser (z. B. iPhone: Kamera-Scan öffnet Safari statt der App) → Buchung zur Freigabe
    o_unverified := true;
  end if;
end $$;

create or replace function public.stamp_check(p_token text, p_phone_key text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_ctx   record;
  v_state record;
begin
  select * into v_ctx from private.stamp_context(p_token, p_phone_key);
  select * into v_state from private.stamp_state(v_ctx.o_user);
  return jsonb_build_object(
    'location', (select name from public.locations where id = v_ctx.o_location),
    'state', v_state.o_state, 'since', v_state.o_since, 'registered', v_ctx.o_registered,
    'unverified', v_ctx.o_unverified);
end $$;

create or replace function public.stamp(p_token text, p_event public.time_event_type, p_phone_key text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_ctx   record;
  v_state record;
  v_seit  text;
  v_log   public.time_logs;
begin
  select * into v_ctx from private.stamp_context(p_token, p_phone_key);
  select * into v_state from private.stamp_state(v_ctx.o_user);
  v_seit := coalesce(' (seit ' || to_char(v_state.o_since at time zone 'Europe/Berlin', 'HH24:MI') || ')', '');

  if p_event = 'clock_in' and v_state.o_state = 'in' then
    raise exception 'Du bist bereits eingestempelt%.', v_seit;
  elsif p_event = 'clock_in' and v_state.o_state = 'break' then
    raise exception 'Du bist gerade in der Pause%. Bitte „Pause Ende“ wählen.', v_seit;
  elsif p_event = 'break_start' and v_state.o_state = 'out' then
    raise exception 'Du bist nicht eingestempelt. Bitte zuerst „Kommen“ wählen.';
  elsif p_event = 'break_start' and v_state.o_state = 'break' then
    raise exception 'Du bist bereits in der Pause%.', v_seit;
  elsif p_event = 'break_end' and v_state.o_state <> 'break' then
    raise exception 'Du bist gerade nicht in der Pause.';
  elsif p_event = 'clock_out' and v_state.o_state = 'out' then
    raise exception 'Du bist nicht eingestempelt.';
  end if;

  insert into public.time_logs (user_id, location_id, event_type, recorded_at, source, kiosk_device_id,
                                device_unverified, device_key_hash)
  values (v_ctx.o_user, v_ctx.o_location, p_event, now(), 'kiosk', v_ctx.o_device,
          v_ctx.o_unverified, case when v_ctx.o_unverified then v_ctx.o_key_hash end)
  returning * into v_log;

  return jsonb_build_object(
    'id', v_log.id, 'event_type', v_log.event_type, 'recorded_at', v_log.recorded_at,
    'pending', v_log.approval_status = 'pending',
    'location', (select name from public.locations where id = v_ctx.o_location));
end $$;

-- Freigabe einer „anderes Handy“-Buchung → Handy merken, weitere offene Buchungen davon freigeben
create or replace function private.time_logs_trust_device() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.approval_status = 'approved' and old.approval_status = 'pending'
     and new.device_unverified and new.device_key_hash is not null and new.source = 'kiosk' then
    insert into public.stamp_phones (user_id, key_hash) values (new.user_id, new.device_key_hash)
    on conflict do nothing;
    if pg_trigger_depth() = 1 then
      update public.time_logs
         set approval_status = 'approved', review_note = 'Handy freigegeben'
       where user_id = new.user_id and device_key_hash = new.device_key_hash
         and approval_status = 'pending' and id <> new.id;
    end if;
  end if;
  return null;
end $$;
drop trigger if exists trust_device on public.time_logs;
create trigger trust_device after update of approval_status on public.time_logs
  for each row execute function private.time_logs_trust_device();

revoke execute on function public.stamp_check(text, text) from public, anon;
revoke execute on function public.stamp(text, public.time_event_type, text) from public, anon;
grant execute on function public.stamp_check(text, text) to authenticated;
grant execute on function public.stamp(text, public.time_event_type, text) to authenticated;
revoke execute on all functions in schema private from public;
grant execute on all functions in schema private to authenticated, service_role;


-- >>> 20261010120000_vacation_allowances.sql

-- =============================================================================
-- Clock-In · Urlaubsanspruch je Jahr (Admin trägt ihn ein, Standard 20 Tage)
-- =============================================================================
-- * Je Person und Jahr ein Anspruch (z. B. anteilig im Eintrittsjahr). Ohne Eintrag gilt der Standard
--   aus rule_settings.default_vacation_days (20).
-- * Bisherige Werte aus dem Arbeitsvertrag werden fürs laufende Jahr übernommen.
-- * Resturlaub = Anspruch − genommen − eingetragen (zählt runter, sobald Urlaub im Dienstplan steht).
-- (Mehrfach ausführbar.)
-- =============================================================================

alter table public.rule_settings
  add column if not exists default_vacation_days numeric(4,1) not null default 20
    check (default_vacation_days between 0 and 365);

create table if not exists public.vacation_allowances (
  user_id    uuid not null references public.users (id) on delete cascade,
  year       integer not null check (year between 2000 and 2100),
  days       numeric(4,1) not null check (days between 0 and 365),
  updated_at timestamptz not null default now(),
  primary key (user_id, year)
);
alter table public.vacation_allowances enable row level security;
drop policy if exists vacation_allowances_select on public.vacation_allowances;
drop policy if exists vacation_allowances_write on public.vacation_allowances;
-- sehen: die Person selbst und ihre Leitung; ändern: nur Admin
create policy vacation_allowances_select on public.vacation_allowances for select to authenticated
  using (user_id = (select private.current_user_id()) or private.manages_user(user_id));
create policy vacation_allowances_write on public.vacation_allowances for all to authenticated
  using ((select private.is_admin())) with check ((select private.is_admin()));
grant select, insert, update, delete on public.vacation_allowances to authenticated;

insert into public.vacation_allowances (user_id, year, days)
select e.user_id, extract(year from now() at time zone 'Europe/Berlin')::integer, e.vacation_days_per_year
from public.employment_details e
where e.vacation_days_per_year is not null
on conflict do nothing;

create or replace function public.vacation_overview(p_year integer)
returns table (user_id uuid, allowance numeric, taken integer, planned integer)
language sql stable security definer set search_path = '' as $$
  select u.id,
         coalesce(a.days, (select r.default_vacation_days from public.rule_settings r), 20),
         count(distinct s.shift_date) filter (where s.shift_date <= (now() at time zone 'Europe/Berlin')::date)::integer,
         count(distinct s.shift_date) filter (where s.shift_date > (now() at time zone 'Europe/Berlin')::date)::integer
  from public.users u
  left join public.vacation_allowances a on a.user_id = u.id and a.year = p_year
  left join public.shifts s on s.user_id = u.id and s.shift_type = 'vacation'
        and s.shift_date >= make_date(p_year, 1, 1) and s.shift_date < make_date(p_year + 1, 1, 1)
  where u.is_active and (u.id = private.current_user_id() or private.manages_user(u.id))
  group by u.id, a.days
$$;


-- >>> 20261011090000_school_import.sql

-- =============================================================================
-- Clock-In · Schul-Abgleich mit dem IST-Bildungspartner-Portal
-- =============================================================================
-- Importierte Schultage werden markiert (import_source = 'ist'), damit der nächste Abgleich sie
-- anpassen oder entfernen kann. Von Hand eingetragene Schultage (import_source leer) bleiben unberührt.
-- (Mehrfach ausführbar.)
-- =============================================================================

alter table public.shifts add column if not exists import_source text;
create index if not exists shifts_import_source_idx on public.shifts (import_source) where import_source is not null;


-- >>> 20261011120000_saturday_auto_free.sql

-- =============================================================================
-- Clock-In · Samstag: automatisch frei
-- =============================================================================
-- 18-Uhr-Abfrage („Was war los?“): Am Samstag arbeitet meist nur eine Person je Studio. Wer am Samstag
-- weder Schicht noch Abwesenheit noch Stempelung hat, gilt automatisch als frei – es wird nur nachgefragt,
-- wenn im eigenen Studio an dem Tag niemand eingestempelt hat. (Mehrfach ausführbar.)
-- =============================================================================

create or replace function public.absence_candidates(p_day date)
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
    -- Samstag arbeitet meist nur eine Person: alle anderen automatisch frei (keine Frage) –
    -- außer im eigenen Studio hat an dem Tag niemand eingestempelt
    and not (
      extract(isodow from p_day) = 6
      and exists (
        select 1 from public.time_logs t
        where t.location_id = u.home_location_id and t.event_type = 'clock_in' and t.approval_status <> 'rejected'
          and t.recorded_at >= private.berlin_day_start(p_day) and t.recorded_at < private.berlin_day_start(p_day + 1)))
  order by u.last_name, u.first_name
$$;

revoke execute on function public.absence_candidates(date) from public, anon, authenticated;
grant execute on function public.absence_candidates(date) to service_role;


-- >>> 20261012090000_herold_shifts.sql

-- =============================================================================
-- Clock-In · Schichttyp „Herold + Schicht“
-- =============================================================================
-- Zwei Teile an einem Tag: erst Herold im Studio Krailling (dort ein- und auschecken), danach die Schicht
-- im eigenen Studio (dort noch einmal ein- und auschecken). Beide Teile sind normale Arbeitsschichten;
-- der Krailling-Teil ist als Herold markiert. Studioleitung trägt beides für ihre Leute ein.
-- * Herold zählt – wie Akquise – nicht als Besetzung des Studios Krailling.
-- * Einstempeln wird bevorzugt der Schicht im selben Studio zugeordnet (auch bei Verspätung).
-- * Krank statt Herold: Eintrag beim Heimatstudio.
-- (Mehrfach ausführbar.)
-- =============================================================================

alter table public.shifts add column if not exists is_herold boolean not null default false;
alter table public.shifts drop constraint if exists shifts_herold_work;
alter table public.shifts add constraint shifts_herold_work
  check (not is_herold or (shift_type = 'work' and not is_acquisition));

-- Einstempeln → passende Schicht: zuerst im selben Studio, dann die mit dem nächsten Beginn
create or replace function private.time_logs_assign_shift() returns trigger
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
    order by (location_id is not distinct from new.location_id) desc,
             abs(extract(epoch from starts_at - new.recorded_at))
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

-- Erstes Einstempeln des Tages im Studio – Akquise- und Herold-Stempelungen zählen nicht
create or replace function public.is_first_checkin(p_log_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.time_logs me
    where me.id = p_log_id and me.event_type = 'clock_in' and me.approval_status = 'approved'
      and not exists (select 1 from public.shifts a where a.id = me.shift_id and (a.is_acquisition or a.is_herold))
      and not exists (
        select 1 from public.time_logs t
        where t.location_id = me.location_id and t.event_type = 'clock_in' and t.approval_status = 'approved'
          and t.id <> me.id
          and t.recorded_at >= private.berlin_day_start((me.recorded_at at time zone 'Europe/Berlin')::date)
          and t.recorded_at <= me.recorded_at
          and not exists (select 1 from public.shifts a where a.id = t.shift_id and (a.is_acquisition or a.is_herold))
      )
  )
$$;

-- Studio noch nicht besetzt? Nur Trainer-Schichten zählen, Akquise und Herold nicht
create or replace function private.staffing_check() returns integer
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
    where s.shift_type = 'work' and not s.is_acquisition and not s.is_herold
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
        and t.recorded_at >= private.berlin_day_start(v_today)
        and not exists (select 1 from public.shifts a where a.id = t.shift_id and (a.is_acquisition or a.is_herold)));

    insert into public.staffing_alerts (location_id, day) values (v_plan.location_id, v_today)
    on conflict do nothing;
    continue when not found;  -- heute schon gewarnt

    select jsonb_agg(u.first_name || ' ' || u.last_name order by u.first_name) into v_names
    from public.shifts s join public.users u on u.id = s.user_id
    where s.location_id = v_plan.location_id and s.shift_type = 'work' and not s.is_acquisition and not s.is_herold
      and s.starts_at = v_plan.first_start;

    perform private.call_telegram(jsonb_build_object(
      'type', 'studio_unstaffed',
      'location', v_plan.name,
      'start', to_char(v_plan.first_start at time zone 'Europe/Berlin', 'HH24:MI'),
      'names', coalesce(v_names, '[]'::jsonb)));
    v_count := v_count + 1;
  end loop;
  return v_count;
end $$;

-- Krank statt Schicht: Herold-Markierung entfällt, Eintrag (wie bei Akquise) beim Heimatstudio
create or replace function public.report_sick(p_shift_id uuid, p_from timestamptz default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_shift public.shifts;
  v_from  timestamptz;
  v_loc   uuid;
  v_id    uuid;
begin
  select * into v_shift from public.shifts where id = p_shift_id for update;
  if not found or v_shift.shift_type <> 'work' then
    raise exception 'Nur geplante Schichten können gegen Krank getauscht werden.';
  end if;
  if not (private.can_plan_shift(v_shift.location_id, v_shift.user_id, v_shift.is_acquisition)
          or private.manages_user(v_shift.user_id)) then
    raise exception 'Dafür fehlt die Berechtigung.' using errcode = '42501';
  end if;
  v_from := greatest(coalesce(p_from, v_shift.starts_at), v_shift.starts_at);
  if v_from >= v_shift.ends_at then
    raise exception '„Krank ab“ muss vor dem Schichtende liegen.';
  end if;
  -- Krank-Eintrag beim Studio der Schicht; Akquise, Herold oder fremdes Studio → beim Heimatstudio
  v_loc := case when v_shift.is_acquisition or v_shift.is_herold or not private.manages_location(v_shift.location_id)
                then null else v_shift.location_id end;

  if v_from = v_shift.starts_at then
    update public.shifts
       set shift_type = 'sick', is_acquisition = false, is_herold = false, location_id = v_loc,
           note = 'Krank statt Schicht', credit_share = 1, from_shift = true
     where id = p_shift_id
    returning id into v_id;
  else
    update public.shifts set ends_at = v_from where id = p_shift_id;
    insert into public.shifts (user_id, location_id, shift_type, starts_at, ends_at, note, created_by, credit_share, from_shift)
    values (v_shift.user_id, v_loc, 'sick', v_from, v_shift.ends_at, 'Krank statt Schicht', private.current_user_id(),
            round((extract(epoch from v_shift.ends_at - v_from) / extract(epoch from v_shift.ends_at - v_shift.starts_at))::numeric, 3), true)
    returning id into v_id;
  end if;
  return v_id;
end $$;

revoke execute on all functions in schema private from public;
grant execute on all functions in schema private to authenticated, service_role;


-- >>> 20261012120000_school_7h_day_off.sql

-- =============================================================================
-- Clock-In · Schule 7 Std. · „Frei“ für Vollzeitkräfte
-- =============================================================================
-- * Schule zählt je Tag pauschal 7 Std. (rule_settings.school_credit_minutes) – für alle, auch Azubis
--   (bisher Wochenstunden ÷ 5,25, z. B. 7:37 Std.). Krank/Urlaub bleiben wie gehabt.
-- * Neuer Eintrag „Frei“ (day_off): bewusst freier Tag, zählt keine Stunden; der Dienstplan zeigt
--   Mitarbeiter ohne Eintrag unter „Noch ohne Schicht“ – Vollzeitkräfte lassen sich dort auf frei setzen.
--   Wer frei hat, wird um 18 Uhr nicht nachgefragt.
-- (Mehrfach ausführbar. Der neue Wert wird hier nur als Text verglichen – so läuft alles in einem Durchgang.)
-- =============================================================================

alter type public.shift_type add value if not exists 'day_off';

alter table public.rule_settings
  add column if not exists school_credit_minutes integer not null default 420
    check (school_credit_minutes between 0 and 720);

create or replace function public.work_day_summary(p_user uuid, p_from date, p_to date)
returns table (
  day                       date,
  planned_minutes           integer,  -- geplante Arbeitsschichten
  worked_minutes            integer,  -- angerechnete Arbeitszeit (nach Kappung und Pausen)
  break_minutes             integer,  -- abgezogene Pausen
  credit_minutes            integer,  -- Gutschrift Krank / Schule / Urlaub (Frei: 0)
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
  v_daily    numeric;
begin
  -- eigene Daten, Leitung/Admin oder System (Service-Role)
  if auth.uid() is not null and p_user is distinct from private.current_user_id() and not private.manages_user(p_user) then
    raise exception 'Keine Berechtigung für diese Auswertung.';
  end if;
  if p_to - p_from > 92 then
    raise exception 'Zeitraum zu lang (max. 93 Tage).';
  end if;
  select * into v_settings from public.rule_settings;
  -- Azubis: ein Abwesenheitstag = Wochenstunden ÷ 5,25; sonst bleibt v_daily leer (Dauer zählt)
  select e.weekly_target_minutes / v_settings.absence_week_days into v_daily
  from public.employment_details e join public.users u on u.id = e.user_id
  where e.user_id = p_user and u.role = 'trainee';

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

    -- Gutschrift: Schule pauschal (7 Std., für alle); sonst Azubis Tagesanteil (höchstens ein Tag),
    -- sonst Pauschale bzw. Schichtdauer. „Frei“ zählt nichts.
    select (array_agg(s.shift_type order by s.starts_at))[1],
           round(case when bool_or(s.shift_type::text = 'vocational_school')
                      then v_settings.school_credit_minutes
                      when v_daily is null
                      -- ganzer Tag pauschal (höchstens einmal), Krank statt Schicht mit der Schichtdauer
                      then least(count(*) filter (where not s.from_shift and s.shift_type::text <> 'day_off'), 1)
                             * v_settings.absence_credit_minutes
                           + coalesce(sum(extract(epoch from s.ends_at - s.starts_at) / 60) filter (where s.from_shift), 0)
                      else least(coalesce(sum(s.credit_share) filter (where s.shift_type::text <> 'day_off'), 0), 1)
                             * v_daily end)::integer
      into absence, credit_minutes
    from public.shifts s
    where s.user_id = p_user and s.shift_type <> 'work' and s.starts_at >= v_from_ts and s.starts_at < v_to_ts;

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


-- >>> 20261012150000_monthly_report_network.sql

-- =============================================================================
-- Clock-In · Netz-Check lockerer · Monatsübersicht per Mail
-- =============================================================================
-- * Stempeln per Handy: Handy und Tablet müssen nicht mehr exakt dieselbe öffentliche IPv4-Adresse haben,
--   es reicht derselbe Adressbereich (/16, z. B. 93.104.x.x). Grund: Anbieter wie M-net vergeben Adressen
--   aus einem gemeinsamen Pool (CGNAT) – Geräte im selben WLAN erscheinen dann mit verschiedenen Adressen.
--   IPv6 bleibt beim /64-Netz des Studios. Der QR-Code (90 Sek. gültig) bleibt der eigentliche Nachweis.
-- * Monatsübersicht: am 1. jedes Monats (7 Uhr) Mail an rule_settings.monthly_report_email mit Vormonat,
--   aktuellem und kommendem Monat – alle Schichten mit Zeiten, Abwesenheiten, Urlaub genommen/übrig.
--   Versand über die Telegram-Function (Resend, Secret RESEND_API_KEY).
-- (Mehrfach ausführbar.)
-- =============================================================================

-- Gleiches Netz? IPv4: gleicher /16-Bereich, IPv6: gleiches /64-Netz
create or replace function private.same_network(a cidr, b cidr) returns boolean
language sql immutable set search_path = '' as $$
  select family(a) = family(b)
     and set_masklen(a, case when family(a) = 4 then 16 else 64 end)
       = set_masklen(b, case when family(b) = 4 then 16 else 64 end)
$$;

create or replace function private.stamp_context(
  p_token text, p_phone_key text,
  out o_device uuid, out o_location uuid, out o_user uuid, out o_registered boolean,
  out o_unverified boolean, out o_key_hash text)
language plpgsql security definer set search_path = '' as $$
declare
  v_net    cidr := private.client_network();
  v_hash   text;
  v_tablet text;
begin
  o_user := private.current_user_id();
  if o_user is null or not exists (select 1 from public.users where id = o_user and is_active) then
    raise exception 'Bitte im Mitarbeiter-Portal anmelden.';
  end if;

  select q.device_id, q.location_id into o_device, o_location
  from public.kiosk_qr q
  join public.kiosk_devices k on k.id = q.device_id and k.is_active
  where (q.token = p_token and q.issued_at > now() - interval '90 seconds')
     or (q.prev_token = p_token and q.issued_at > now() - interval '30 seconds');
  if o_device is null then
    raise exception 'QR-Code abgelaufen – bitte den aktuellen Code am Tablet scannen.';
  end if;

  if v_net is null or not exists (
       select 1 from public.kiosk_networks n
       where n.device_id = o_device and private.same_network(n.network, v_net)
         and n.last_seen_at > now() - interval '12 hours') then
    select string_agg(host(n.network), ', ' order by n.last_seen_at desc) into v_tablet
    from public.kiosk_networks n where n.device_id = o_device and n.last_seen_at > now() - interval '12 hours';
    raise exception 'Dein Handy ist nicht im WLAN des Studios. Bitte mit dem Studio-WLAN verbinden (mobile Daten aus) und erneut scannen. [Handy %, Tablet %]',
      coalesce(host(v_net), '?'), coalesce(v_tablet, '?');
  end if;

  if coalesce(length(p_phone_key), 0) < 32 then
    raise exception 'Ungültiger Geräteschlüssel.';
  end if;
  v_hash := encode(extensions.digest(p_phone_key, 'sha256'), 'hex');
  o_key_hash := v_hash;
  o_registered := false;
  o_unverified := false;
  if exists (select 1 from public.stamp_phones where key_hash = v_hash and user_id <> o_user) then
    raise exception 'Dieses Handy ist bereits für eine andere Person registriert. Bitte mit deinem eigenen Handy stempeln.';
  end if;
  if not exists (select 1 from public.stamp_phones where user_id = o_user) then
    -- erstes Handy: automatisch registrieren, Admins bekommen eine Meldung
    insert into public.stamp_phones (user_id, key_hash) values (o_user, v_hash);
    o_registered := true;
    perform private.call_telegram(jsonb_build_object(
      'type', 'phone_registered',
      'name', (select first_name || ' ' || last_name from public.users where id = o_user),
      'location', (select name from public.locations where id = o_location)));
  elsif not exists (select 1 from public.stamp_phones where user_id = o_user and key_hash = v_hash) then
    -- anderes Handy/Browser (z. B. iPhone: Kamera-Scan öffnet Safari statt der App) → Buchung zur Freigabe
    o_unverified := true;
  end if;
end $$;

alter table public.rule_settings
  add column if not exists monthly_report_email text default 'gf@bsnewfitness.de',
  add column if not exists monthly_report_hour integer not null default 7 check (monthly_report_hour between 0 and 23);

-- Daten der Monatsübersicht (nur Service-Role / Telegram-Function): p_month = 1. des aktuellen Monats
create or replace function public.monthly_report(p_month date)
returns jsonb
language sql stable security definer set search_path = '' as $$
  with bounds as (
    select (date_trunc('month', p_month) - interval '1 month')::date as d_from,
           (date_trunc('month', p_month) + interval '2 months')::date as d_to,
           (now() at time zone 'Europe/Berlin')::date as today
  ),
  people as (
    select u.id, u.first_name, u.last_name, u.role, l.name as studio, e.weekly_target_minutes
    from public.users u
    left join public.locations l on l.id = u.home_location_id
    left join public.employment_details e on e.user_id = u.id
    where u.is_active and u.role <> 'admin'
  ),
  entries as (
    select s.user_id, s.shift_type::text as type, s.starts_at, s.ends_at, s.note, s.is_acquisition,
           coalesce(s.is_herold, false) as is_herold, l.name as studio,
           (s.starts_at at time zone 'Europe/Berlin')::date as day
    from public.shifts s
    join people p on p.id = s.user_id
    left join public.locations l on l.id = s.location_id, bounds b
    where s.starts_at >= private.berlin_day_start(b.d_from) and s.starts_at < private.berlin_day_start(b.d_to)
  ),
  years as (
    select distinct extract(year from d)::integer as y
    from bounds b, generate_series(b.d_from, b.d_to - 1, interval '1 month') d
  ),
  vacation as (
    select p.id as user_id, y.y as year,
           coalesce(a.days, (select r.default_vacation_days from public.rule_settings r), 20) as allowance,
           count(distinct s.shift_date) filter (where s.shift_date <= b.today) as taken,
           count(distinct s.shift_date) filter (where s.shift_date > b.today) as planned
    from people p cross join years y cross join bounds b
    left join public.vacation_allowances a on a.user_id = p.id and a.year = y.y
    left join public.shifts s on s.user_id = p.id and s.shift_type = 'vacation'
          and s.shift_date >= make_date(y.y, 1, 1) and s.shift_date < make_date(y.y + 1, 1, 1)
    group by p.id, y.y, a.days
  )
  select jsonb_build_object(
    'from', (select d_from from bounds),
    'to', (select d_to from bounds),
    'today', (select today from bounds),
    'people', coalesce((select jsonb_agg(to_jsonb(p) order by p.studio nulls last, p.first_name, p.last_name) from people p), '[]'),
    'entries', coalesce((select jsonb_agg(to_jsonb(e) order by e.starts_at) from entries e), '[]'),
    'vacation', coalesce((select jsonb_agg(to_jsonb(v) order by v.year) from vacation v), '[]')
  )
$$;
revoke execute on function public.monthly_report(date) from public, anon, authenticated;
grant execute on function public.monthly_report(date) to service_role;

-- Stündlich: … + am 1. des Monats die Monatsübersicht
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
  if extract(day from v_local) = 1 and v_hour = v_settings.monthly_report_hour
     and coalesce(v_settings.monthly_report_email, '') <> '' then
    perform private.call_telegram(jsonb_build_object('type', 'monthly_report', 'month', date_trunc('month', v_local)::date));
  end if;
end $$;

revoke execute on all functions in schema private from public;
grant execute on all functions in schema private to authenticated, service_role;


-- >>> 20261013090000_pc_terminals.sql

-- =============================================================================
-- Clock-In · PC als zweites Terminal je Studio · Stempeln nur mit dem eigenen Handy
-- =============================================================================
-- * Am PC die App öffnen → „PC als Terminal einrichten“ → mit dem eigenen Clock-In-Zugang anmelden, Studio
--   wählen → Anfrage. Tobias/Dominik sagen per Telegram-Button (oder in Einstellungen) „Ja, passt“ – dann
--   legt die Telegram-Function das Terminal-Konto an und der PC zeigt den QR-Code wie das Tablet.
--   Die persönliche Anmeldung am PC wird direkt nach der Anfrage wieder beendet.
-- * Stempeln nur noch vom Handy (Browser-Kennung „Mobile“/iPhone): Am Studio-PC oder -Tablet – auch per
--   Kamera auf den QR-Code des anderen Geräts – geht es nicht. Jeder nimmt sein eigenes Handy.
-- (Mehrfach ausführbar.)
-- =============================================================================

alter table public.kiosk_devices add column if not exists kind text not null default 'tablet';
alter table public.kiosk_devices drop constraint if exists kiosk_devices_kind;
alter table public.kiosk_devices add constraint kiosk_devices_kind check (kind in ('tablet', 'pc'));

-- Anfragen: Passwort nur bis zum Anlegen des Kontos, danach gelöscht. Kein direkter Zugriff (nur Funktionen).
create table if not exists public.terminal_requests (
  id           uuid primary key default gen_random_uuid(),
  name         text not null check (length(name) between 2 and 40),
  location_id  uuid not null references public.locations (id) on delete cascade,
  requested_by uuid references public.users (id) on delete set null,
  secret_hash  text not null,
  password     text,
  status       text not null default 'pending' check (status in ('pending', 'approved', 'ready', 'rejected')),
  username     text,
  device_id    uuid references public.kiosk_devices (id) on delete set null,
  decided_by   uuid references public.users (id) on delete set null,
  created_at   timestamptz not null default now(),
  decided_at   timestamptz
);
alter table public.terminal_requests enable row level security;
revoke all on public.terminal_requests from anon, authenticated;

-- Handy? (Browser-Kennung; ohne Kennung nicht sperren)
create or replace function private.is_phone() returns boolean
language sql stable set search_path = '' as $$
  select coalesce(lower(nullif(current_setting('request.headers', true), '')::jsonb ->> 'user-agent'), '') ~ '(mobi|iphone|ipod)'
      or coalesce(nullif(current_setting('request.headers', true), '')::jsonb ->> 'user-agent', '') = ''
$$;

create or replace function private.stamp_context(
  p_token text, p_phone_key text,
  out o_device uuid, out o_location uuid, out o_user uuid, out o_registered boolean,
  out o_unverified boolean, out o_key_hash text)
language plpgsql security definer set search_path = '' as $$
declare
  v_net    cidr := private.client_network();
  v_hash   text;
  v_tablet text;
begin
  o_user := private.current_user_id();
  if o_user is null or not exists (select 1 from public.users where id = o_user and is_active) then
    raise exception 'Bitte im Mitarbeiter-Portal anmelden.';
  end if;
  -- nur mit dem eigenen Handy – nicht am Studio-PC oder -Tablet (auch nicht mit deren Kamera)
  if not private.is_phone() then
    raise exception 'Stempeln geht nur mit deinem eigenen Handy – nicht am PC oder Tablet. (Am Handy? Dann im Browser „Desktop-Version“ ausschalten.)';
  end if;

  select q.device_id, q.location_id into o_device, o_location
  from public.kiosk_qr q
  join public.kiosk_devices k on k.id = q.device_id and k.is_active
  where (q.token = p_token and q.issued_at > now() - interval '90 seconds')
     or (q.prev_token = p_token and q.issued_at > now() - interval '30 seconds');
  if o_device is null then
    raise exception 'QR-Code abgelaufen – bitte den aktuellen Code am Tablet scannen.';
  end if;

  if v_net is null or not exists (
       select 1 from public.kiosk_networks n
       where n.device_id = o_device and private.same_network(n.network, v_net)
         and n.last_seen_at > now() - interval '12 hours') then
    select string_agg(host(n.network), ', ' order by n.last_seen_at desc) into v_tablet
    from public.kiosk_networks n where n.device_id = o_device and n.last_seen_at > now() - interval '12 hours';
    raise exception 'Dein Handy ist nicht im WLAN des Studios. Bitte mit dem Studio-WLAN verbinden (mobile Daten aus) und erneut scannen. [Handy %, Tablet %]',
      coalesce(host(v_net), '?'), coalesce(v_tablet, '?');
  end if;

  if coalesce(length(p_phone_key), 0) < 32 then
    raise exception 'Ungültiger Geräteschlüssel.';
  end if;
  v_hash := encode(extensions.digest(p_phone_key, 'sha256'), 'hex');
  o_key_hash := v_hash;
  o_registered := false;
  o_unverified := false;
  if exists (select 1 from public.stamp_phones where key_hash = v_hash and user_id <> o_user) then
    raise exception 'Dieses Handy ist bereits für eine andere Person registriert. Bitte mit deinem eigenen Handy stempeln.';
  end if;
  if not exists (select 1 from public.stamp_phones where user_id = o_user) then
    -- erstes Handy: automatisch registrieren, Admins bekommen eine Meldung
    insert into public.stamp_phones (user_id, key_hash) values (o_user, v_hash);
    o_registered := true;
    perform private.call_telegram(jsonb_build_object(
      'type', 'phone_registered',
      'name', (select first_name || ' ' || last_name from public.users where id = o_user),
      'location', (select name from public.locations where id = o_location)));
  elsif not exists (select 1 from public.stamp_phones where user_id = o_user and key_hash = v_hash) then
    -- anderes Handy/Browser (z. B. iPhone: Kamera-Scan öffnet Safari statt der App) → Buchung zur Freigabe
    o_unverified := true;
  end if;
end $$;

-- PC fragt an (angemeldete Person, egal welche Rolle); Admins bekommen die Anfrage per Telegram
create or replace function public.request_terminal(p_name text, p_location_id uuid, p_secret text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_me uuid := private.current_user_id();
  v_id uuid;
begin
  if v_me is null or not exists (select 1 from public.users where id = v_me and is_active) then
    raise exception 'Bitte mit deinem Clock-In-Zugang anmelden.';
  end if;
  if coalesce(length(p_secret), 0) < 32 then
    raise exception 'Ungültiger Geräteschlüssel.';
  end if;
  if not exists (select 1 from public.locations where id = p_location_id and is_active) then
    raise exception 'Studio nicht gefunden.';
  end if;
  if (select count(*) from public.terminal_requests where status = 'pending' and created_at > now() - interval '1 day') >= 10 then
    raise exception 'Zu viele offene Anfragen – bitte erst freigeben oder ablehnen lassen.';
  end if;
  insert into public.terminal_requests (name, location_id, requested_by, secret_hash, password)
  values (trim(p_name), p_location_id, v_me, encode(extensions.digest(p_secret, 'sha256'), 'hex'), p_secret)
  returning id into v_id;
  perform private.call_telegram(jsonb_build_object('type', 'terminal_request', 'id', v_id));
  return v_id;
end $$;
revoke execute on function public.request_terminal(text, uuid, text) from public, anon;
grant execute on function public.request_terminal(text, uuid, text) to authenticated;

-- PC fragt nach (ohne Anmeldung, nur mit seinem Schlüssel)
create or replace function public.terminal_request_status(p_id uuid, p_secret text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('status', r.status, 'username', case when r.status = 'ready' then r.username end,
                            'location', l.name, 'name', r.name)
  from public.terminal_requests r join public.locations l on l.id = r.location_id
  where r.id = p_id and r.secret_hash = encode(extensions.digest(coalesce(p_secret, ''), 'sha256'), 'hex')
$$;
revoke execute on function public.terminal_request_status(uuid, text) from public;
grant execute on function public.terminal_request_status(uuid, text) to anon, authenticated;

-- Offene Anfragen (Admin, Einstellungen)
create or replace function public.open_terminal_requests()
returns table (id uuid, name text, location_id uuid, location_name text, requested_by text, created_at timestamptz, status text)
language sql stable security definer set search_path = '' as $$
  select r.id, r.name, r.location_id, l.name, u.first_name || ' ' || u.last_name, r.created_at, r.status
  from public.terminal_requests r
  join public.locations l on l.id = r.location_id
  left join public.users u on u.id = r.requested_by
  where private.is_admin() and r.status in ('pending', 'approved') and r.created_at > now() - interval '7 days'
  order by r.created_at
$$;
revoke execute on function public.open_terminal_requests() from public, anon;
grant execute on function public.open_terminal_requests() to authenticated;

-- Admin entscheidet in der App: Ja → Konto legt die Telegram-Function an; Nein → Anfrage verworfen
create or replace function public.decide_terminal_request(p_id uuid, p_approve boolean) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not private.is_admin() then
    raise exception 'Nur Admins können Terminals freigeben.' using errcode = '42501';
  end if;
  update public.terminal_requests
     set status = case when p_approve then 'approved' else 'rejected' end,
         password = case when p_approve then password end,
         decided_by = private.current_user_id(), decided_at = now()
   where id = p_id and status = 'pending';
  if not found then
    raise exception 'Anfrage ist schon entschieden.';
  end if;
  if p_approve then
    perform private.call_telegram(jsonb_build_object('type', 'terminal_create', 'id', p_id));
  end if;
end $$;
revoke execute on function public.decide_terminal_request(uuid, boolean) from public, anon;
grant execute on function public.decide_terminal_request(uuid, boolean) to authenticated;

revoke execute on all functions in schema private from public;
grant execute on all functions in schema private to authenticated, service_role;


-- >>> 20261013120000_monthly_report_v2.sql

-- =============================================================================
-- Clock-In · Monatsbericht 2.0 (Daten)
-- =============================================================================
-- Zusätzlich zum Dienstplan der drei Monate liefert monthly_report jetzt die Auswertung des Vormonats:
-- je Mitarbeiter und Tag Ist/Gutschrift/Verspätung (wie im Portal, work_day_summary), Verspätungen der
-- letzten 3 Monate, Krankheitstage im Jahr, Vertragsdaten (Wochenstunden, Ein-/Austritt) und die Regeln.
-- Daraus baut die Telegram-Function Kennzahlen, Studio-Tabellen, Wochenübersicht und Excel-Stundenzettel.
-- (Mehrfach ausführbar.)
-- =============================================================================

create or replace function public.monthly_report(p_month date)
returns jsonb
language sql stable security definer set search_path = '' as $$
  with bounds as (
    select (date_trunc('month', p_month) - interval '1 month')::date as d_from,      -- Vormonat
           (date_trunc('month', p_month))::date - 1                as d_last,       -- letzter Tag Vormonat
           (date_trunc('month', p_month) - interval '3 months')::date as d_trend,   -- Trend: 3 Monate
           (date_trunc('month', p_month) + interval '2 months')::date as d_to,
           (now() at time zone 'Europe/Berlin')::date as today
  ),
  people as (
    select u.id, u.first_name, u.last_name, u.role, l.name as studio,
           e.weekly_target_minutes, e.work_days_per_week, e.employment_start, e.employment_end
    from public.users u
    left join public.locations l on l.id = u.home_location_id
    left join public.employment_details e on e.user_id = u.id
    where u.is_active and u.role <> 'admin'
  ),
  entries as (
    select s.user_id, s.shift_type::text as type, s.starts_at, s.ends_at, s.note, s.is_acquisition,
           coalesce(s.is_herold, false) as is_herold, l.name as studio,
           (s.starts_at at time zone 'Europe/Berlin')::date as day
    from public.shifts s
    join people p on p.id = s.user_id
    left join public.locations l on l.id = s.location_id, bounds b
    where s.starts_at >= private.berlin_day_start(b.d_from) and s.starts_at < private.berlin_day_start(b.d_to)
  ),
  -- Tagesauswertung der letzten 3 Monate (Detail nur Vormonat, davor nur für den Verspätungs-Trend)
  days as (
    select p.id as user_id, d.*
    from people p cross join bounds b
    cross join lateral public.work_day_summary(p.id, b.d_trend, b.d_last) d
  ),
  years as (
    select distinct extract(year from d)::integer as y
    from bounds b, generate_series(b.d_from, b.d_to - 1, interval '1 month') d
  ),
  vacation as (
    select p.id as user_id, y.y as year,
           coalesce(a.days, (select r.default_vacation_days from public.rule_settings r), 20) as allowance,
           count(distinct s.shift_date) filter (where s.shift_date <= b.today) as taken,
           count(distinct s.shift_date) filter (where s.shift_date > b.today) as planned
    from people p cross join years y cross join bounds b
    left join public.vacation_allowances a on a.user_id = p.id and a.year = y.y
    left join public.shifts s on s.user_id = p.id and s.shift_type = 'vacation'
          and s.shift_date >= make_date(y.y, 1, 1) and s.shift_date < make_date(y.y + 1, 1, 1)
    group by p.id, y.y, a.days
  ),
  sick_year as (
    select s.user_id, count(distinct s.shift_date) as days
    from public.shifts s cross join bounds b
    where s.shift_type = 'sick' and s.shift_date >= make_date(extract(year from b.d_last)::integer, 1, 1)
      and s.shift_date <= b.d_last
    group by s.user_id
  )
  select jsonb_build_object(
    'from', (select d_from from bounds),
    'to', (select d_to from bounds),
    'trend_from', (select d_trend from bounds),
    'today', (select today from bounds),
    'settings', (select jsonb_build_object('absence_credit_minutes', r.absence_credit_minutes,
                                           'absence_week_days', r.absence_week_days,
                                           'school_credit_minutes', r.school_credit_minutes,
                                           'late_tolerance_minutes', r.late_tolerance_minutes)
                 from public.rule_settings r),
    'people', coalesce((select jsonb_agg(to_jsonb(p) order by p.studio nulls last, p.first_name, p.last_name) from people p), '[]'),
    'entries', coalesce((select jsonb_agg(to_jsonb(e) order by e.starts_at) from entries e), '[]'),
    'days', coalesce((select jsonb_agg(jsonb_build_object(
               'user_id', d.user_id, 'day', d.day, 'planned', d.planned_minutes, 'worked', d.worked_minutes,
               'break', d.break_minutes, 'credit', d.credit_minutes, 'absence', d.absence, 'late', d.late_minutes,
               'ot_pending', d.overtime_pending_minutes, 'ot_approved', d.overtime_approved_minutes, 'open', d.open_session)
             order by d.user_id, d.day)
             from days d
             where d.planned_minutes > 0 or d.worked_minutes > 0 or d.credit_minutes > 0 or d.late_minutes > 0
                or d.absence is not null or d.open_session), '[]'),
    'vacation', coalesce((select jsonb_agg(to_jsonb(v) order by v.year) from vacation v), '[]'),
    'sick_year', coalesce((select jsonb_object_agg(s.user_id, s.days) from sick_year s), '{}')
  )
$$;
revoke execute on function public.monthly_report(date) from public, anon, authenticated;
grant execute on function public.monthly_report(date) to service_role;


-- >>> 20261018090000_split_shifts.sql

-- =============================================================================
-- Clock-In · Split-Schichten: früher gehen (krank / wenig los), Schule/Prüfung + Schicht, Splitschicht
-- =============================================================================
-- * Gehen mehr als 30 Min. vor Schichtende (rule_settings.early_leave_minutes): das Handy fragt nach dem Grund
--   („wenig los / weniger Trainings“ oder „krank“), Tobias/Dominik entscheiden per Telegram:
--     krank        → ab dem Gehen „Krank statt Schicht“ (wie Krank ab Uhrzeit, Gutschrift für den Rest)
--     wenig los OK → zählt bis Schichtende
--     abgelehnt    → nur die gearbeitete Zeit zählt (Minusstunden)
-- * Schule/Nachprüfung + Schicht: Schul-Eintrag mit Uhrzeit (credit_by_time) zählt mit seiner Dauer statt
--   pauschal 7 Std.; Urlaub/Krank am selben Tag werden zusätzlich angerechnet.
-- * Splitschicht (zwei Zeiten im selben Studio) = zwei normale Schichten, je ein- und auschecken.
-- * Gesetzliche Pausen (§ 4 ArbZG) über den ganzen Tag: mehr als 6 Std. → 30 Min., mehr als 9 Std. → 45 Min.;
--   gestempelte Pausen und Lücken zwischen den Teilen zählen mit, Lücken aber erst ab 15 Min. am Stück.
-- (Mehrfach ausführbar.)
-- =============================================================================

alter table public.rule_settings
  add column if not exists early_leave_minutes integer not null default 30 check (early_leave_minutes between 5 and 240);

alter table public.time_logs
  add column if not exists early_reason text,
  add column if not exists early_status text,
  add column if not exists early_reviewed_by uuid references public.users (id) on delete set null,
  add column if not exists early_reviewed_at timestamptz;
alter table public.time_logs drop constraint if exists time_logs_early;
alter table public.time_logs add constraint time_logs_early
  check ((early_reason is null or early_reason in ('slow', 'sick'))
     and (early_status is null or early_status in ('pending', 'approved', 'sick', 'rejected')));

alter table public.shifts add column if not exists credit_by_time boolean not null default false;
alter table public.shifts drop constraint if exists shifts_credit_by_time;
alter table public.shifts add constraint shifts_credit_by_time check (not credit_by_time or shift_type::text = 'vocational_school');

-- Neuer optionaler Grund beim Gehen (alte App-Versionen rufen weiter mit 3 Werten auf)
drop function if exists public.stamp(text, public.time_event_type, text);
create or replace function public.stamp(p_token text, p_event public.time_event_type, p_phone_key text,
                                        p_early_reason text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_ctx   record;
  v_state record;
  v_seit  text;
  v_log   public.time_logs;
begin
  select * into v_ctx from private.stamp_context(p_token, p_phone_key);
  select * into v_state from private.stamp_state(v_ctx.o_user);
  v_seit := coalesce(' (seit ' || to_char(v_state.o_since at time zone 'Europe/Berlin', 'HH24:MI') || ')', '');

  if p_event = 'clock_in' and v_state.o_state = 'in' then
    raise exception 'Du bist bereits eingestempelt%.', v_seit;
  elsif p_event = 'clock_in' and v_state.o_state = 'break' then
    raise exception 'Du bist gerade in der Pause%. Bitte „Pause Ende“ wählen.', v_seit;
  elsif p_event = 'break_start' and v_state.o_state = 'out' then
    raise exception 'Du bist nicht eingestempelt. Bitte zuerst „Kommen“ wählen.';
  elsif p_event = 'break_start' and v_state.o_state = 'break' then
    raise exception 'Du bist bereits in der Pause%.', v_seit;
  elsif p_event = 'break_end' and v_state.o_state <> 'break' then
    raise exception 'Du bist gerade nicht in der Pause.';
  elsif p_event = 'clock_out' and v_state.o_state = 'out' then
    raise exception 'Du bist nicht eingestempelt.';
  end if;

  insert into public.time_logs (user_id, location_id, event_type, recorded_at, source, kiosk_device_id,
                                device_unverified, device_key_hash, early_reason)
  values (v_ctx.o_user, v_ctx.o_location, p_event, now(), 'kiosk', v_ctx.o_device,
          v_ctx.o_unverified, case when v_ctx.o_unverified then v_ctx.o_key_hash end,
          case when p_event = 'clock_out' and p_early_reason in ('slow', 'sick') then p_early_reason end)
  returning * into v_log;

  return jsonb_build_object(
    'id', v_log.id, 'event_type', v_log.event_type, 'recorded_at', v_log.recorded_at,
    'pending', v_log.approval_status = 'pending',
    'early', v_log.early_status = 'pending',
    'location', (select name from public.locations where id = v_ctx.o_location));
end $$;

create or replace function private.time_logs_assign_shift() returns trigger
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
    order by (location_id is not distinct from new.location_id) desc,
             abs(extract(epoch from starts_at - new.recorded_at))
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
    new.early_status := null;
    new.early_reason := null;
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

  -- Gehen deutlich vor Schichtende (Handy/Tablet) → Freigabe: krank, wenig los oder Minusstunden
  new.early_status := null;
  if new.event_type = 'clock_out' and new.shift_id is not null and new.source in ('kiosk', 'offline_sync') then
    select * into v_shift from public.shifts where id = new.shift_id;
    if v_shift.shift_type = 'work'
       and new.recorded_at < v_shift.ends_at - make_interval(mins => v_settings.early_leave_minutes) then
      new.early_status := 'pending';
    end if;
  end if;
  if new.early_status is null then
    new.early_reason := null;
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

create or replace function public.work_day_summary(p_user uuid, p_from date, p_to date)
returns table (
  day                       date,
  planned_minutes           integer,  -- geplante Arbeitsschichten
  worked_minutes            integer,  -- angerechnete Arbeitszeit (nach Kappung und Pausen)
  break_minutes             integer,  -- abgezogene Pausen
  credit_minutes            integer,  -- Gutschrift Krank / Schule / Urlaub (Frei: 0)
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
  v_daily    numeric;
begin
  -- eigene Daten, Leitung/Admin oder System (Service-Role)
  if auth.uid() is not null and p_user is distinct from private.current_user_id() and not private.manages_user(p_user) then
    raise exception 'Keine Berechtigung für diese Auswertung.';
  end if;
  if p_to - p_from > 92 then
    raise exception 'Zeitraum zu lang (max. 93 Tage).';
  end if;
  select * into v_settings from public.rule_settings;
  -- Azubis: ein Abwesenheitstag = Wochenstunden ÷ 5,25; sonst bleibt v_daily leer (Dauer zählt)
  select e.weekly_target_minutes / v_settings.absence_week_days into v_daily
  from public.employment_details e join public.users u on u.id = e.user_id
  where e.user_id = p_user and u.role = 'trainee';

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

    -- Gutschrift: Schule pauschal (7 Std., für alle); sonst Azubis Tagesanteil (höchstens ein Tag),
    -- sonst Pauschale bzw. Schichtdauer. „Frei“ zählt nichts.
    select (array_agg(s.shift_type order by s.starts_at))[1],
           round(
             -- Schule: ganzer Tag pauschal 7 Std.; Teil-Tag (Schule/Prüfung + Schicht) mit der Dauer
             case when bool_or(s.shift_type::text = 'vocational_school' and not s.credit_by_time)
                  then v_settings.school_credit_minutes
                  else coalesce(sum(extract(epoch from s.ends_at - s.starts_at) / 60)
                                  filter (where s.shift_type::text = 'vocational_school' and s.credit_by_time), 0) end
             -- Urlaub/Krank: Azubis Tagesanteil (höchstens ein Tag), sonst Pauschale bzw. Schichtdauer
             + case when v_daily is null
                    then least(count(*) filter (where not s.from_shift and s.shift_type::text in ('vacation', 'sick')), 1)
                           * v_settings.absence_credit_minutes
                         + coalesce(sum(extract(epoch from s.ends_at - s.starts_at) / 60) filter (where s.from_shift), 0)
                    else least(coalesce(sum(s.credit_share) filter (where s.shift_type::text in ('vacation', 'sick')), 0), 1)
                           * v_daily end)::integer
      into absence, credit_minutes
    from public.shifts s
    where s.user_id = p_user and s.shift_type <> 'work' and s.starts_at >= v_from_ts and s.starts_at < v_to_ts;

    for ev in
      select t.event_type, t.recorded_at, t.shift_id, t.overtime_status, t.early_status
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
        -- früher gegangen, freigegeben („wenig los“) → zählt bis Schichtende
        if v_shift.id is not null and ev.early_status = 'approved' and ev.recorded_at < v_shift.ends_at then
          v_end := v_shift.ends_at;
        end if;
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
          -- Lücke zwischen zwei Einsätzen (Splitschicht, Herold + Schicht …) zählt als Pause,
          -- aber nur ab 15 Min. am Stück (Ruhepause nach § 4 ArbZG)
          if v_prev_end is not null and v_start > v_prev_end then
            v_minutes := floor(extract(epoch from v_start - v_prev_end) / 60)::integer;
            if v_minutes >= v_settings.min_break_minutes then
              v_gaps := v_gaps + v_minutes;
            end if;
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

-- Entscheidung (Telegram-Function mit Service-Role oder Admin in der App)
create or replace function public.decide_early_leave(p_log_id uuid, p_decision text, p_reviewer uuid default null)
returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_log   public.time_logs;
  v_shift public.shifts;
  v_by    uuid := coalesce(private.current_user_id(), p_reviewer);
begin
  if auth.uid() is not null and not private.is_admin() then
    raise exception 'Nur Admins entscheiden über früheres Gehen.' using errcode = '42501';
  end if;
  if p_decision not in ('approved', 'sick', 'rejected') then
    raise exception 'Unbekannte Entscheidung.';
  end if;
  select * into v_log from public.time_logs where id = p_log_id for update;
  if not found then
    raise exception 'Buchung nicht gefunden.';
  end if;
  if v_log.early_status is distinct from 'pending' then
    return 'already';
  end if;

  if p_decision = 'sick' then
    select * into v_shift from public.shifts where id = v_log.shift_id for update;
    if v_shift.id is not null and v_shift.shift_type = 'work' and v_log.recorded_at < v_shift.ends_at then
      update public.shifts set ends_at = v_log.recorded_at where id = v_shift.id;
      insert into public.shifts (user_id, location_id, shift_type, starts_at, ends_at, note, created_by, credit_share, from_shift)
      values (v_shift.user_id,
              case when v_shift.is_acquisition or coalesce(v_shift.is_herold, false) then null else v_shift.location_id end,
              'sick', v_log.recorded_at, v_shift.ends_at, 'Krank statt Schicht (früher gegangen)', v_by,
              round((extract(epoch from v_shift.ends_at - v_log.recorded_at)
                     / extract(epoch from v_shift.ends_at - v_shift.starts_at))::numeric, 3), true);
    end if;
  end if;

  update public.time_logs
     set early_status = p_decision, early_reviewed_by = v_by, early_reviewed_at = now()
   where id = p_log_id;
  return p_decision;
end $$;
revoke execute on function public.decide_early_leave(uuid, text, uuid) from public, anon;
grant execute on function public.decide_early_leave(uuid, text, uuid) to authenticated, service_role;

revoke execute on function public.stamp(text, public.time_event_type, text, text) from public, anon;
grant execute on function public.stamp(text, public.time_event_type, text, text) to authenticated;
revoke execute on all functions in schema private from public;
grant execute on all functions in schema private to authenticated, service_role;


-- >>> 20261021090000_day_correction_any_phone.sql

-- =============================================================================
-- Clock-In · Tag korrigieren (Admin) · mehrere Handys je Person erlauben
-- =============================================================================
-- * Admins können die Stempelungen eines Tages komplett neu erfassen: alle Buchungen des Tages werden
--   gelöscht und die neuen (Kommen/Pause/Gehen) in einem Schritt eingetragen – geprüfte Reihenfolge,
--   Grund Pflicht, alles im Änderungsprotokoll (audit_log). Pausen, Schicht-Zuordnung, Überstunden
--   rechnet die Datenbank danach wie bei normalen Stempelungen. Keine Telegram-Meldung je Buchung.
-- * Nachtragen durch Admins ohne 7-Tage-Grenze (Studioleitung weiter höchstens 7 Tage, mit Freigabe).
-- * users.any_phone: Person darf mit verschiedenen Handys/Browsern stempeln, ohne Freigabe.
-- (Mehrfach ausführbar.)
-- =============================================================================

alter table public.users add column if not exists any_phone boolean not null default false;

create or replace function private.stamp_context(
  p_token text, p_phone_key text,
  out o_device uuid, out o_location uuid, out o_user uuid, out o_registered boolean,
  out o_unverified boolean, out o_key_hash text)
language plpgsql security definer set search_path = '' as $$
declare
  v_net    cidr := private.client_network();
  v_hash   text;
  v_tablet text;
begin
  o_user := private.current_user_id();
  if o_user is null or not exists (select 1 from public.users where id = o_user and is_active) then
    raise exception 'Bitte im Mitarbeiter-Portal anmelden.';
  end if;
  -- nur mit dem eigenen Handy – nicht am Studio-PC oder -Tablet (auch nicht mit deren Kamera)
  if not private.is_phone() then
    raise exception 'Stempeln geht nur mit deinem eigenen Handy – nicht am PC oder Tablet. (Am Handy? Dann im Browser „Desktop-Version“ ausschalten.)';
  end if;

  select q.device_id, q.location_id into o_device, o_location
  from public.kiosk_qr q
  join public.kiosk_devices k on k.id = q.device_id and k.is_active
  where (q.token = p_token and q.issued_at > now() - interval '90 seconds')
     or (q.prev_token = p_token and q.issued_at > now() - interval '30 seconds');
  if o_device is null then
    raise exception 'QR-Code abgelaufen – bitte den aktuellen Code am Tablet scannen.';
  end if;

  if v_net is null or not exists (
       select 1 from public.kiosk_networks n
       where n.device_id = o_device and private.same_network(n.network, v_net)
         and n.last_seen_at > now() - interval '12 hours') then
    select string_agg(host(n.network), ', ' order by n.last_seen_at desc) into v_tablet
    from public.kiosk_networks n where n.device_id = o_device and n.last_seen_at > now() - interval '12 hours';
    raise exception 'Dein Handy ist nicht im WLAN des Studios. Bitte mit dem Studio-WLAN verbinden (mobile Daten aus) und erneut scannen. [Handy %, Tablet %]',
      coalesce(host(v_net), '?'), coalesce(v_tablet, '?');
  end if;

  if coalesce(length(p_phone_key), 0) < 32 then
    raise exception 'Ungültiger Geräteschlüssel.';
  end if;
  v_hash := encode(extensions.digest(p_phone_key, 'sha256'), 'hex');
  o_key_hash := v_hash;
  o_registered := false;
  o_unverified := false;
  if exists (select 1 from public.stamp_phones where key_hash = v_hash and user_id <> o_user) then
    raise exception 'Dieses Handy ist bereits für eine andere Person registriert. Bitte mit deinem eigenen Handy stempeln.';
  end if;
  if not exists (select 1 from public.stamp_phones where user_id = o_user) then
    -- erstes Handy: automatisch registrieren, Admins bekommen eine Meldung
    insert into public.stamp_phones (user_id, key_hash) values (o_user, v_hash);
    o_registered := true;
    perform private.call_telegram(jsonb_build_object(
      'type', 'phone_registered',
      'name', (select first_name || ' ' || last_name from public.users where id = o_user),
      'location', (select name from public.locations where id = o_location)));
  elsif not exists (select 1 from public.stamp_phones where user_id = o_user and key_hash = v_hash)
        and not coalesce((select u.any_phone from public.users u where u.id = o_user), false) then
    -- anderes Handy/Browser (z. B. iPhone: Kamera-Scan öffnet Safari statt der App) → Buchung zur Freigabe
    -- (außer ein Admin hat für die Person „mehrere Handys erlauben“ eingeschaltet)
    o_unverified := true;
  end if;
end $$;

-- Nachtrag: Admin ohne Zeitgrenze in die Vergangenheit, Studioleitung höchstens 7 Tage
drop policy if exists time_logs_insert_manual on public.time_logs;
create policy time_logs_insert_manual on public.time_logs for insert to authenticated
  with check (
    source = 'manual' and kiosk_device_id is null
    and recorded_at <= now() + interval '5 minutes'
    and ((select private.is_admin())
         or (private.may_backdate(location_id) and recorded_at >= now() - interval '7 days'))
  );

-- Telegram-Meldung je Buchung – beim Neu-Erfassen eines Tages stumm (clockin.silent)
create or replace function private.notify_time_log() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_url    text;
  v_secret text;
begin
  if current_setting('clockin.silent', true) = 'on' then
    return null;
  end if;
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

-- Tag neu erfassen: p_events = [{"event": "clock_in", "at": "2026-10-19T07:00:00Z"}, …] (leer = Tag löschen)
create or replace function public.replace_day_logs(p_user uuid, p_day date, p_location uuid, p_events jsonb, p_note text)
returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_from  timestamptz := private.berlin_day_start(p_day);
  v_to    timestamptz := private.berlin_day_start(p_day + 1);
  v_state text := 'out';
  v_last  timestamptz;
  v_ev    jsonb;
  v_type  text;
  v_at    timestamptz;
  v_count integer := 0;
begin
  if not private.is_admin() then
    raise exception 'Nur Admins können Stempelzeiten neu erfassen.' using errcode = '42501';
  end if;
  if coalesce(length(trim(p_note)), 0) < 3 then
    raise exception 'Bitte einen Grund angeben (mind. 3 Zeichen).';
  end if;
  if jsonb_typeof(coalesce(p_events, '[]'::jsonb)) <> 'array' or jsonb_array_length(coalesce(p_events, '[]'::jsonb)) > 20 then
    raise exception 'Ungültige Buchungen.';
  end if;
  if jsonb_array_length(coalesce(p_events, '[]'::jsonb)) > 0
     and not exists (select 1 from public.locations where id = p_location) then
    raise exception 'Bitte ein Studio wählen.';
  end if;

  -- Reihenfolge prüfen: Kommen → (Pause Start → Pause Ende)* → Gehen, Zeiten aufsteigend, alles an diesem Tag
  for v_ev in select * from jsonb_array_elements(coalesce(p_events, '[]'::jsonb)) loop
    v_type := v_ev ->> 'event';
    v_at := (v_ev ->> 'at')::timestamptz;
    if v_at < v_from or v_at >= v_to then
      raise exception 'Alle Zeiten müssen am % liegen.', to_char(p_day, 'DD.MM.YYYY');
    end if;
    if v_at > now() + interval '5 minutes' then
      raise exception 'Zeiten in der Zukunft sind nicht möglich.';
    end if;
    if v_last is not null and v_at <= v_last then
      raise exception 'Die Zeiten müssen aufsteigend sein (%).', to_char(v_at at time zone 'Europe/Berlin', 'HH24:MI');
    end if;
    v_state := case
      when v_state = 'out'   and v_type = 'clock_in'    then 'in'
      when v_state = 'in'    and v_type = 'break_start' then 'break'
      when v_state = 'break' and v_type = 'break_end'   then 'in'
      when v_state = 'in'    and v_type = 'clock_out'   then 'out'
      else null end;
    if v_state is null then
      raise exception 'Reihenfolge stimmt nicht bei % Uhr: Kommen → Pause Start → Pause Ende → Gehen.',
        to_char(v_at at time zone 'Europe/Berlin', 'HH24:MI');
    end if;
    v_last := v_at;
  end loop;
  if v_state = 'break' or (v_state = 'in' and p_day < (now() at time zone 'Europe/Berlin')::date) then
    raise exception 'Am Ende fehlt noch „Gehen“ (bzw. „Pause Ende“).';
  end if;

  perform set_config('clockin.silent', 'on', true);
  delete from public.time_logs where user_id = p_user and recorded_at >= v_from and recorded_at < v_to;
  for v_ev in select * from jsonb_array_elements(coalesce(p_events, '[]'::jsonb)) loop
    insert into public.time_logs (user_id, location_id, event_type, recorded_at, source, note)
    values (p_user, p_location, (v_ev ->> 'event')::public.time_event_type, (v_ev ->> 'at')::timestamptz, 'manual',
            'Korrigiert: ' || trim(p_note));
    v_count := v_count + 1;
  end loop;
  perform set_config('clockin.silent', 'off', true);
  return v_count;
end $$;
revoke execute on function public.replace_day_logs(uuid, date, uuid, jsonb, text) from public, anon;
grant execute on function public.replace_day_logs(uuid, date, uuid, jsonb, text) to authenticated;

revoke execute on all functions in schema private from public;
grant execute on all functions in schema private to authenticated, service_role;


-- >>> 20261022090000_presence.sql

-- =============================================================================
-- Clock-In · „Wer ist da?“ – Live-Überblick für Admin und Studioleitung
-- =============================================================================
-- Eine Zeile pro Person mit Bezug zu heute (Stempelung, Arbeitsschicht oder Abwesenheit):
--   in      eingestempelt (arbeitet)            since = letztes Kommen/Pause Ende, clocked_in = Kommen
--           (sonst: clocked_in = erstes Kommen heute, last_out = letztes Gehen heute)
--   break   in Pause                            since = Pause Start
--   missing Schicht hat begonnen (+ Toleranz), noch nicht eingestempelt
--   later   Schicht kommt noch (z. B. Splitschicht, Herold + Schicht)
--   gone    heute schon gegangen                since = letztes Gehen
--   missed  Schicht ist vorbei, nie eingestempelt
--   absent  krank / Urlaub / Schule / frei      tag = Art
-- Nur für Admins.
-- (Mehrfach ausführbar.)
-- =============================================================================

drop function if exists public.presence_today();
create function public.presence_today()
returns table (user_id uuid, first_name text, last_name text, location_id uuid, state text,
               clocked_in timestamptz, since timestamptz, last_out timestamptz,
               shift_start timestamptz, shift_end timestamptz, late_minutes integer, tag text, pending boolean)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_today date := (now() at time zone 'Europe/Berlin')::date;
  v_from  timestamptz := private.berlin_day_start(v_today);
  v_to    timestamptz := private.berlin_day_start(v_today + 1);
  v_tol   integer;
begin
  if not private.is_admin() then
    raise exception 'Dafür fehlt die Berechtigung.' using errcode = '42501';
  end if;
  select r.late_tolerance_minutes into v_tol from public.rule_settings r;

  return query
  with logs as (
    select t.* from public.time_logs t
    where t.approval_status <> 'rejected' and t.recorded_at > least(v_from, now() - interval '16 hours')
  ),
  last_log as (  -- aktueller Status (wie beim Stempeln: letzte Buchung der letzten 16 Std.)
    select distinct on (l.user_id) l.* from logs l
    where l.recorded_at > now() - interval '16 hours'
    order by l.user_id, l.recorded_at desc
  ),
  last_in as (
    select distinct on (l.user_id) l.* from logs l
    where l.event_type = 'clock_in' and l.recorded_at > now() - interval '16 hours'
    order by l.user_id, l.recorded_at desc
  ),
  today as (
    select l.user_id,
           min(l.recorded_at) filter (where l.event_type = 'clock_in')  as first_in,
           max(l.recorded_at) filter (where l.event_type = 'clock_out') as last_out,
           bool_or(l.approval_status = 'pending')                        as pending
    from logs l where l.recorded_at >= v_from
    group by l.user_id
  ),
  work as (
    select s.* from public.shifts s
    where s.shift_type = 'work' and s.starts_at < v_to and s.ends_at > v_from
  ),
  open_shift as (  -- nächste Schicht, die noch läuft oder kommt und noch nicht angetreten ist
    select distinct on (w.user_id) w.* from work w
    where w.ends_at > now()
      and not exists (select 1 from logs l where l.shift_id = w.id and l.event_type = 'clock_in')
    order by w.user_id, w.starts_at
  ),
  missed as (  -- vorbei und nie angetreten
    select distinct on (w.user_id) w.* from work w
    where w.ends_at <= now()
      and not exists (select 1 from logs l where l.shift_id = w.id and l.event_type = 'clock_in')
    order by w.user_id, w.starts_at
  ),
  absent as (
    select distinct on (s.user_id) s.* from public.shifts s
    where s.shift_type::text in ('sick', 'vacation', 'vocational_school', 'day_off')
      and s.starts_at < v_to and s.ends_at > v_from
    order by s.user_id, s.starts_at
  ),
  base as (
    select u.id as uid, u.first_name as fn, u.last_name as ln, u.home_location_id as home,
           ll.event_type as ev, ll.recorded_at as ev_at, li.recorded_at as in_at, li.location_id as in_loc,
           cs.starts_at as cs_start, cs.ends_at as cs_end, cs.is_herold as cs_herold, cs.is_acquisition as cs_acq,
           os.location_id as os_loc, os.starts_at as os_start, os.ends_at as os_end,
           os.is_herold as os_herold, os.is_acquisition as os_acq,
           ms.location_id as ms_loc, ms.starts_at as ms_start, ms.ends_at as ms_end,
           ab.location_id as ab_loc, ab.starts_at as ab_start, ab.ends_at as ab_end, ab.shift_type::text as ab_type,
           td.first_in as t_first, td.last_out as t_out, coalesce(td.pending, false) as t_pending
    from public.users u
    left join last_log ll on ll.user_id = u.id
    left join last_in li on li.user_id = u.id
    left join public.shifts cs on cs.id = li.shift_id
    left join open_shift os on os.user_id = u.id
    left join missed ms on ms.user_id = u.id
    left join absent ab on ab.user_id = u.id
    left join today td on td.user_id = u.id
    where u.is_active
  ),
  classified as (
    select r.*,
           case
             when r.ev in ('clock_in', 'break_end') then 'in'
             when r.ev = 'break_start' then 'break'
             when r.os_start is not null and now() >= r.os_start + make_interval(mins => v_tol) then 'missing'
             when r.os_start is not null then 'later'
             when r.t_first is not null then 'gone'
             when r.ms_start is not null then 'missed'
             when r.ab_start is not null then 'absent'
           end as st
    from base r
  ),
  shaped as (
    select c.uid, c.fn, c.ln, c.st, c.home, c.t_out, c.t_pending,
           case when c.st in ('in', 'break') then c.in_at else c.t_first end as clk,
           case
             when c.st in ('in', 'break', 'gone') then coalesce(c.in_loc, c.home)
             when c.st in ('missing', 'later') then coalesce(c.os_loc, c.home)
             when c.st = 'missed' then coalesce(c.ms_loc, c.home)
             else coalesce(c.ab_loc, c.home)
           end as loc,
           case when c.st in ('in', 'break') then c.ev_at when c.st = 'gone' then c.t_out end as at,
           case when c.st in ('in', 'break', 'gone') then c.cs_start
                when c.st in ('missing', 'later') then c.os_start
                when c.st = 'missed' then c.ms_start else c.ab_start end as s_start,
           case when c.st in ('in', 'break', 'gone') then c.cs_end
                when c.st in ('missing', 'later') then c.os_end
                when c.st = 'missed' then c.ms_end else c.ab_end end as s_end,
           case when c.st in ('in', 'break', 'gone')
                     and c.in_at > c.cs_start + make_interval(mins => v_tol)
                  then (extract(epoch from c.in_at - c.cs_start) / 60)::integer
                when c.st = 'missing' then (extract(epoch from now() - c.os_start) / 60)::integer
           end as late,
           case when c.st = 'absent' then c.ab_type
                when c.st in ('in', 'break', 'gone') and c.cs_herold
                  or c.st in ('missing', 'later') and c.os_herold then 'herold'
                when c.st in ('in', 'break', 'gone') and c.cs_acq
                  or c.st in ('missing', 'later') and c.os_acq then 'acquisition'
           end as tg
    from classified c
    where c.st is not null
  )
  select s.uid, s.fn, s.ln, s.loc, s.st, s.clk, s.at, s.t_out, s.s_start, s.s_end, s.late, s.tg, s.t_pending
  from shaped s
  order by s.fn, s.ln;
end $$;
revoke execute on function public.presence_today() from public, anon;
grant execute on function public.presence_today() to authenticated;


select '✅ Clock-In Datenbank eingerichtet' as status, count(*) as studios from public.locations;
