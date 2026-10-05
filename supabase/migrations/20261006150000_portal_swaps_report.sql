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
