-- =============================================================================
-- Clock-In · Schichtwünsche · Dienstplan am Studio-PC (QR der Studioleitung) · Ausstempel-Statistik
-- =============================================================================
-- 1) Schichtwünsche: Mitarbeitende wünschen sich pro Tag eine Lage („früh“, „mittel“, „spät“) in einem
--    Studio – nur heute bis heute + 56 Tage (Europe/Berlin). Die Studioleitung gibt frei (→ normale Schicht
--    mit den Zeiten der Lage) oder lehnt ab. Keine Benachrichtigung an Admins, nichts in deren Freigaben.
--    Zeiten der Lagen: shift_slots (Standard für alle Studios, je Studio überschreibbar).
-- 2) Studio-PC: sieht den ganzen Dienstplan (nur lesen). Planen erst, wenn die Studioleitung den QR-Code am
--    PC mit ihrem registrierten Stempel-Handy scannt (pc_plan_tokens). Die Edge Function „pc-plan“ holt danach
--    eine Sitzung dieser Studioleitung für den PC; die App sperrt nach 5 Min. ohne Bedienung wieder.
-- 3) Ausstempel-Statistik: 10 Kennzahlen je „Gehen“, fest der Person zugeordnet (shift_reports).
-- (Mehrfach ausführbar.)
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1) Schichtwünsche
-- ---------------------------------------------------------------------------
create table if not exists public.shift_slots (
  id          uuid primary key default gen_random_uuid(),
  location_id uuid references public.locations (id) on delete cascade,  -- leer = Standard für alle Studios
  slot        text not null check (slot in ('early', 'mid', 'late')),
  starts      time not null,
  ends        time not null check (ends > starts)
);
create unique index if not exists shift_slots_unique on public.shift_slots (coalesce(location_id, '00000000-0000-0000-0000-000000000000'::uuid), slot);
comment on table public.shift_slots is 'Zeiten der Wunsch-Lagen früh/mittel/spät (location_id leer = Standard für alle Studios)';

-- Studiostandard (aus den üblichen Schichten): früh 08:00–14:30, mittel 11:00–17:30, spät 14:30–21:00
insert into public.shift_slots (location_id, slot, starts, ends) values
  (null, 'early', '08:00', '14:30'),
  (null, 'mid',   '11:00', '17:30'),
  (null, 'late',  '14:30', '21:00')
on conflict do nothing;

alter table public.shift_slots enable row level security;
drop policy if exists shift_slots_select on public.shift_slots;
create policy shift_slots_select on public.shift_slots for select to authenticated
  using ((select private.is_staff()) or (select private.current_kiosk_id()) is not null);
drop policy if exists shift_slots_write on public.shift_slots;
create policy shift_slots_write on public.shift_slots for all to authenticated
  using ((select private.is_admin())) with check ((select private.is_admin()));
grant select on public.shift_slots to authenticated;
grant insert, update, delete on public.shift_slots to authenticated;

create table if not exists public.shift_wishes (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.users (id) on delete cascade,
  location_id uuid not null references public.locations (id) on delete cascade,
  day         date not null,
  slot        text not null check (slot in ('early', 'mid', 'late')),
  status      text not null default 'open' check (status in ('open', 'approved', 'rejected')),
  shift_id    uuid references public.shifts (id) on delete set null,
  decided_by  uuid references public.users (id) on delete set null,
  decided_at  timestamptz,
  created_at  timestamptz not null default now()
);
create unique index if not exists shift_wishes_unique on public.shift_wishes (user_id, day, location_id, slot) where status <> 'rejected';
create index if not exists shift_wishes_day on public.shift_wishes (day, location_id);
comment on table public.shift_wishes is 'Dienstplanwünsche (früh/mittel/spät) – noch keine fixe Schichteinteilung';

alter table public.shift_wishes enable row level security;
-- Sehen: eigene Wünsche; Studioleitung (und Admin) die Wünsche ihrer Studios; Studio-PC (nur lesen)
drop policy if exists shift_wishes_select on public.shift_wishes;
create policy shift_wishes_select on public.shift_wishes for select to authenticated
  using (
    user_id = (select private.current_user_id())
    or private.manages_location(location_id)
    or (select private.current_kiosk_id()) is not null
  );
-- Schreiben nur über die Funktionen unten
revoke insert, update, delete on public.shift_wishes from authenticated, anon;
grant select on public.shift_wishes to authenticated;

-- Zeiten einer Lage in einem Studio (Studio vor Standard)
create or replace function private.slot_times(p_location uuid, p_slot text, out o_starts time, out o_ends time)
language sql stable security definer set search_path = '' as $$
  select s.starts, s.ends from public.shift_slots s
  where s.slot = p_slot and (s.location_id = p_location or s.location_id is null)
  order by s.location_id is null
  limit 1
$$;

-- Wunsch eintragen (eigener Account)
create or replace function public.shift_wish_create(p_location uuid, p_day date, p_slot text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_user  uuid := private.current_user_id();
  v_today date := (now() at time zone 'Europe/Berlin')::date;
  v_id    uuid;
begin
  if v_user is null then
    raise exception 'Bitte im Mitarbeiter-Portal anmelden.';
  end if;
  if p_slot not in ('early', 'mid', 'late') then
    raise exception 'Bitte „früh“, „mittel“ oder „spät“ wählen.';
  end if;
  if p_day < v_today or p_day > v_today + 56 then
    raise exception 'Wünsche gehen nur für heute bis in 8 Wochen.';
  end if;
  if not exists (select 1 from public.locations where id = p_location and is_active) then
    raise exception 'Studio nicht gefunden.';
  end if;
  insert into public.shift_wishes (user_id, location_id, day, slot)
  values (v_user, p_location, p_day, p_slot)
  on conflict do nothing
  returning id into v_id;
  if v_id is null then
    raise exception 'Diesen Wunsch hast du schon eingetragen.';
  end if;
  return v_id;
end $$;

-- Eigenen offenen Wunsch zurückziehen
create or replace function public.shift_wish_withdraw(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  delete from public.shift_wishes
  where id = p_id and user_id = private.current_user_id() and status = 'open';
  if not found then
    raise exception 'Nur eigene, noch offene Wünsche können zurückgezogen werden.';
  end if;
end $$;

-- Studioleitung: freigeben (→ feste Schicht) oder ablehnen
create or replace function public.shift_wish_decide(p_id uuid, p_ok boolean) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_wish  public.shift_wishes;
  v_slot  record;
  v_shift uuid;
begin
  select * into v_wish from public.shift_wishes where id = p_id for update;
  if not found or v_wish.status <> 'open' then
    raise exception 'Der Wunsch ist nicht mehr offen.';
  end if;
  if not private.manages_location(v_wish.location_id) then
    raise exception 'Nur die Studioleitung dieses Studios kann Wünsche freigeben.' using errcode = '42501';
  end if;
  if p_ok then
    select * into v_slot from private.slot_times(v_wish.location_id, v_wish.slot);
    insert into public.shifts (user_id, location_id, shift_type, starts_at, ends_at, note, created_by)
    values (v_wish.user_id, v_wish.location_id, 'work',
            (v_wish.day + v_slot.o_starts) at time zone 'Europe/Berlin',
            (v_wish.day + v_slot.o_ends) at time zone 'Europe/Berlin',
            null, private.current_user_id())
    returning id into v_shift;
  end if;
  update public.shift_wishes
     set status = case when p_ok then 'approved' else 'rejected' end,
         shift_id = v_shift, decided_by = private.current_user_id(), decided_at = now()
   where id = p_id;
  return v_shift;
exception when exclusion_violation then
  raise exception 'Die Person hat zu dieser Zeit schon einen Eintrag im Dienstplan.';
end $$;

revoke execute on function public.shift_wish_create(uuid, date, text), public.shift_wish_withdraw(uuid),
  public.shift_wish_decide(uuid, boolean) from public, anon;
grant execute on function public.shift_wish_create(uuid, date, text), public.shift_wish_withdraw(uuid),
  public.shift_wish_decide(uuid, boolean) to authenticated;

-- ---------------------------------------------------------------------------
-- 2) Dienstplan am Studio-PC
-- ---------------------------------------------------------------------------
-- Studio-PC sieht den ganzen Plan (bisher nur ±1 Tag für die Tablets)
drop policy if exists shifts_select on public.shifts;
create policy shifts_select on public.shifts for select to authenticated
  using (
    (select private.is_staff())
    or (select private.is_studio_pc())
    or ((select private.current_kiosk_id()) is not null
        and starts_at between now() - interval '1 day' and now() + interval '1 day')
  );

create table if not exists public.pc_plan_tokens (
  token        text primary key,
  device_id    uuid not null references public.kiosk_devices (id) on delete cascade,
  created_at   timestamptz not null default now(),
  unlocked_by  uuid references public.users (id) on delete cascade,
  unlocked_at  timestamptz,
  claimed_at   timestamptz
);
alter table public.pc_plan_tokens enable row level security;
revoke all on public.pc_plan_tokens from authenticated, anon;  -- nur über die Funktionen

-- PC: neuen QR-Code für die Planungs-Freigabe holen
create or replace function public.pc_plan_challenge() returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_device uuid;
  v_token  text := encode(extensions.gen_random_bytes(16), 'hex');
begin
  select k.id into v_device from public.kiosk_devices k
  where k.auth_user_id = (select auth.uid()) and k.is_active and k.kind = 'pc';
  if v_device is null then
    raise exception 'Nur am Studio-PC.';
  end if;
  delete from public.pc_plan_tokens where device_id = v_device or created_at < now() - interval '1 hour';
  insert into public.pc_plan_tokens (token, device_id) values (v_token, v_device);
  return v_token;
end $$;

-- PC: wurde der Code von einer Studioleitung bestätigt?
create or replace function public.pc_plan_status(p_token text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('unlocked', t.unlocked_by is not null and t.claimed_at is null,
                            'name', u.first_name || ' ' || u.last_name)
  from public.pc_plan_tokens t
  join public.kiosk_devices k on k.id = t.device_id and k.auth_user_id = (select auth.uid())
  left join public.users u on u.id = t.unlocked_by
  where t.token = p_token
$$;

-- Handy der Studioleitung: Code bestätigen. Geprüft: aktive Studioleitung, eigenes registriertes Stempel-Handy,
-- Code frisch (2 Min.), PC im Heimatstudio der Studioleitung oder in einem anderen Studio (dort nur lesen).
create or replace function public.pc_plan_unlock(p_token text, p_phone_key text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_user public.users;
  v_tok  public.pc_plan_tokens;
  v_loc  text;
begin
  select * into v_user from public.users where id = private.current_user_id() and is_active;
  if not found or v_user.role <> 'manager' then
    raise exception 'Nur eine Studioleitung kann die Schichtplanung am PC freigeben.' using errcode = '42501';
  end if;
  if coalesce(p_phone_key, '') = '' or not exists (
       select 1 from public.stamp_phones
       where user_id = v_user.id and key_hash = encode(extensions.digest(p_phone_key, 'sha256'), 'hex')) then
    raise exception 'Bitte mit deinem registrierten Stempel-Handy scannen.' using errcode = '42501';
  end if;
  select * into v_tok from public.pc_plan_tokens where token = p_token for update;
  if not found or v_tok.created_at < now() - interval '2 minutes' or v_tok.claimed_at is not null then
    raise exception 'QR-Code abgelaufen – bitte am PC neu laden.';
  end if;
  update public.pc_plan_tokens set unlocked_by = v_user.id, unlocked_at = now() where token = p_token;
  select l.name into v_loc from public.kiosk_devices k join public.locations l on l.id = k.location_id
  where k.id = v_tok.device_id;
  return jsonb_build_object('studio', v_loc);
end $$;

-- Edge Function „pc-plan“ (Aufruf mit der Sitzung des PCs): Freigabe einlösen → Login-Name der Studioleitung
create or replace function public.pc_plan_claim(p_token text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_tok  public.pc_plan_tokens;
  v_auth uuid;
  v_home uuid;
begin
  select t.* into v_tok from public.pc_plan_tokens t
  join public.kiosk_devices k on k.id = t.device_id and k.auth_user_id = (select auth.uid()) and k.is_active
  where t.token = p_token for update of t;
  if not found or v_tok.unlocked_by is null or v_tok.claimed_at is not null
     or v_tok.unlocked_at < now() - interval '2 minutes' then
    raise exception 'Freigabe nicht gültig – bitte erneut scannen.' using errcode = '42501';
  end if;
  update public.pc_plan_tokens set claimed_at = now() where token = p_token;
  select u.auth_user_id, u.home_location_id into v_auth, v_home
  from public.users u where u.id = v_tok.unlocked_by and u.is_active and u.role = 'manager';
  if v_auth is null then
    raise exception 'Studioleitung nicht mehr aktiv.' using errcode = '42501';
  end if;
  return jsonb_build_object('auth_user_id', v_auth, 'user_id', v_tok.unlocked_by, 'home_location_id', v_home);
end $$;

revoke execute on function public.pc_plan_challenge(), public.pc_plan_status(text), public.pc_plan_unlock(text, text),
  public.pc_plan_claim(text) from public, anon;
grant execute on function public.pc_plan_challenge(), public.pc_plan_status(text), public.pc_plan_unlock(text, text),
  public.pc_plan_claim(text) to authenticated;

-- ---------------------------------------------------------------------------
-- 3) Ausstempel-Statistik
-- ---------------------------------------------------------------------------
create table if not exists public.shift_reports (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references public.users (id) on delete cascade,
  location_id      uuid references public.locations (id) on delete set null,
  time_log_id      uuid unique references public.time_logs (id) on delete set null,
  created_at       timestamptz not null default now(),
  trainings        integer not null default 0 check (trainings >= 0),
  kvs              integer not null default 0 check (kvs >= 0),
  pts_given        integer not null default 0 check (pts_given >= 0),
  direct_contacts  integer not null default 0 check (direct_contacts >= 0),
  vip_contacts     integer not null default 0 check (vip_contacts >= 0),
  flyers           integer not null default 0 check (flyers >= 0),
  called_former    integer not null default 0 check (called_former >= 0),
  called_wellpass  integer not null default 0 check (called_wellpass >= 0),
  called_leads     integer not null default 0 check (called_leads >= 0),
  pts_booked       integer not null default 0 check (pts_booked >= 0),
  constraint shift_reports_not_all_zero check (
    trainings + kvs + pts_given + direct_contacts + vip_contacts + flyers
    + called_former + called_wellpass + called_leads + pts_booked > 0)
);
create index if not exists shift_reports_user on public.shift_reports (user_id, created_at);
create index if not exists shift_reports_created on public.shift_reports (created_at);
comment on table public.shift_reports is 'Statistik-Feedback beim Ausstempeln (eine Zeile je „Gehen“, fest der Person zugeordnet)';
comment on column public.shift_reports.trainings is 'Gegebene Trainings (einzelne Personen)';
comment on column public.shift_reports.kvs is 'Gemachte KVs';
comment on column public.shift_reports.pts_given is 'Gegebene PTs (einzelne Personen)';
comment on column public.shift_reports.direct_contacts is 'Direktansprachen';
comment on column public.shift_reports.vip_contacts is 'VIP Ansprachen';
comment on column public.shift_reports.flyers is 'Verteilte Flyer';
comment on column public.shift_reports.called_former is 'Angerufene Ehemalige';
comment on column public.shift_reports.called_wellpass is 'Angerufene Wellpassler';
comment on column public.shift_reports.called_leads is 'Angerufene Interessenten/Leads';
comment on column public.shift_reports.pts_booked is 'Ausgemachte PTs';

alter table public.shift_reports enable row level security;
-- Sehen: eigene Zahlen; Studioleitung die Leute ihres Heimatstudios; Admins alles
drop policy if exists shift_reports_select on public.shift_reports;
create policy shift_reports_select on public.shift_reports for select to authenticated
  using (user_id = (select private.current_user_id()) or private.manages_user(user_id));
revoke insert, update, delete on public.shift_reports from authenticated, anon;  -- nur beim Gehen (Funktion)
grant select on public.shift_reports to authenticated;

-- Beim Gehen: Kennzahlen der Schicht speichern (nur die ausstempelnde Person, direkt nach ihrem „Gehen“)
create or replace function public.shift_report_submit(p_values jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid := private.current_user_id();
  v_log  public.time_logs;
  v_id   uuid;
  n      integer[];
begin
  if v_user is null then
    raise exception 'Bitte im Mitarbeiter-Portal anmelden.';
  end if;
  select * into v_log from public.time_logs
  where user_id = v_user and approval_status <> 'rejected' and recorded_at > now() - interval '16 hours'
  order by recorded_at desc limit 1;
  if not found or v_log.event_type <> 'clock_out' or v_log.received_at < now() - interval '30 minutes' then
    raise exception 'Die Statistik wird direkt nach dem Ausstempeln eingetragen.';
  end if;
  n := array[
    coalesce((p_values ->> 'trainings')::integer, 0), coalesce((p_values ->> 'kvs')::integer, 0),
    coalesce((p_values ->> 'pts_given')::integer, 0), coalesce((p_values ->> 'direct_contacts')::integer, 0),
    coalesce((p_values ->> 'vip_contacts')::integer, 0), coalesce((p_values ->> 'flyers')::integer, 0),
    coalesce((p_values ->> 'called_former')::integer, 0), coalesce((p_values ->> 'called_wellpass')::integer, 0),
    coalesce((p_values ->> 'called_leads')::integer, 0), coalesce((p_values ->> 'pts_booked')::integer, 0)];
  if exists (select 1 from unnest(n) x where x < 0 or x > 10000) then
    raise exception 'Bitte nur ganze Zahlen ab 0 eintragen.';
  end if;
  if (select sum(x) from unnest(n) x) = 0 then
    raise exception 'Bitte trag mindestens eine Kennzahl ein – überall 0 geht nicht.';
  end if;
  insert into public.shift_reports (user_id, location_id, time_log_id, trainings, kvs, pts_given, direct_contacts,
                                    vip_contacts, flyers, called_former, called_wellpass, called_leads, pts_booked)
  values (v_user, v_log.location_id, v_log.id, n[1], n[2], n[3], n[4], n[5], n[6], n[7], n[8], n[9], n[10])
  on conflict (time_log_id) do nothing
  returning id into v_id;
  if v_id is null then
    raise exception 'Für dieses Ausstempeln ist die Statistik schon gespeichert.';
  end if;
  return v_id;
end $$;
revoke execute on function public.shift_report_submit(jsonb) from public, anon;
grant execute on function public.shift_report_submit(jsonb) to authenticated;

revoke execute on all functions in schema private from public;
grant execute on all functions in schema private to authenticated, service_role;
