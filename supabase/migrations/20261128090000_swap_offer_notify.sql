-- =============================================================================
-- Clock-In · Tauschanfragen sichtbarer machen (mehrfach ausführbar)
-- =============================================================================
-- 1) Neue Anfrage: Mitteilung an die angefragte Person (wie bisher) UND an die Studioleitung(en) zur Info.
-- 2) Neue Anfrage: Telegram-Info an die Admins („wartet auf Zustimmung von …“), Freigabe-Knöpfe wie bisher erst
--    nach der Zustimmung.
-- 3) Gegenseitige Doppel-Anfrage (beide fragen sich gegenseitig für dieselben Schichten) wird verhindert – mit Hinweis,
--    der Anfrage des anderen zuzustimmen.
-- =============================================================================

-- ---------------- 1) Mitteilungen ----------------
create or replace function private.swap_requests_inform() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_req  text := (select first_name from public.users where id = new.requester_id);
  v_tgt  text := (select first_name from public.users where id = new.target_user_id);
  v_what text := (select private.fmt_shift(s.starts_at, s.ends_at) from public.shifts s where s.id = new.requester_shift_id);
  v_back text := (select private.fmt_shift(s.starts_at, s.ends_at) from public.shifts s where s.id = new.target_shift_id);
  v_lead uuid;
begin
  if tg_op = 'INSERT' then
    perform private.notify_user(new.target_user_id, 'swap', v_req || ' möchte mit dir tauschen',
      'Du übernimmst ' || coalesce(v_what, '?') || coalesce(', dafür gibst du ' || v_back || ' ab', '')
      || ' – bitte zustimmen oder ablehnen.', new.id::text);
    -- Studioleitung(en) der beteiligten Studios zur Info (nicht die Beteiligten selbst)
    for v_lead in
      select distinct m.user_id
      from public.location_managers m
      join public.shifts s on s.location_id = m.location_id and s.id in (new.requester_shift_id, new.target_shift_id)
      join public.users u on u.id = m.user_id and u.is_active
      where m.user_id not in (new.requester_id, new.target_user_id)
    loop
      perform private.notify_user(v_lead, 'swap', 'Tauschanfrage: ' || v_req || ' → ' || v_tgt,
        'Schicht ' || coalesce(v_what, '?') || coalesce(' gegen ' || v_back, '') || ' – wartet auf ' || v_tgt || 's Zustimmung.',
        'lead:' || new.id::text);
    end loop;
  elsif old.target_accepted_at is null and new.target_accepted_at is not null and new.status = 'pending' then
    perform private.notify_user(new.requester_id, 'swap', v_tgt || ' hat dem Tausch zugestimmt',
      'Schicht ' || coalesce(v_what, '?') || ' – jetzt entscheidet die Studioleitung.');
  elsif old.status = 'pending' and new.status = 'approved' then
    perform private.notify_user(new.requester_id, 'swap', 'Tausch freigegeben', 'Schicht ' || coalesce(v_what, '?') || ' übernimmt ' || v_tgt || '.');
    perform private.notify_user(new.target_user_id, 'swap', 'Tausch freigegeben', 'Du übernimmst die Schicht ' || coalesce(v_what, '?') || ' von ' || v_req || '.');
  elsif old.status = 'pending' and new.status = 'rejected' then
    perform private.notify_user(new.requester_id, 'swap', 'Tausch abgelehnt',
      'Schicht ' || coalesce(v_what, '?') || coalesce(' – ' || nullif(new.decision_note, 'per Telegram'), ''));
    if old.target_accepted_at is not null then
      perform private.notify_user(new.target_user_id, 'swap', 'Tausch abgelehnt', 'Schicht ' || coalesce(v_what, '?') || ' von ' || v_req || '.');
    end if;
  end if;
  return null;
end $$;

drop trigger if exists inform on public.swap_requests;
create trigger inform after insert or update on public.swap_requests
  for each row execute function private.swap_requests_inform();

-- ---------------- 2) Telegram ----------------
create or replace function private.notify_swap_request() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' and new.status = 'pending' and new.target_accepted_at is null then
    -- nur Info: neue Anfrage, wartet auf die angefragte Person
    perform private.call_telegram(jsonb_build_object('type', 'swap_new', 'id', new.id));
  elsif new.status = 'pending' and new.target_accepted_at is not null
     and (tg_op = 'INSERT' or old.target_accepted_at is null) then
    perform private.call_telegram(jsonb_build_object('type', 'swap_request', 'id', new.id));
  end if;
  return null;
end $$;

drop trigger if exists notify_telegram on public.swap_requests;
create trigger notify_telegram after insert or update of target_accepted_at on public.swap_requests
  for each row execute function private.notify_swap_request();

-- ---------------- 3) Gegenseitige Doppel-Anfrage ----------------
create or replace function private.swap_requests_mutual() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.status = 'pending' and new.target_shift_id is not null and exists (
       select 1 from public.swap_requests r
       where r.status = 'pending'
         and r.requester_id = new.target_user_id and r.target_user_id = new.requester_id
         and r.requester_shift_id = new.target_shift_id and r.target_shift_id = new.requester_shift_id) then
    raise exception 'Schichttausch: % hat dir genau diesen Tausch schon angeboten – stimme unter Mitteilungen (Glocke) zu.',
      (select first_name from public.users where id = new.target_user_id);
  end if;
  return new;
end $$;

drop trigger if exists mutual on public.swap_requests;
create trigger mutual before insert on public.swap_requests
  for each row execute function private.swap_requests_mutual();

revoke execute on function private.swap_requests_mutual() from public, anon, authenticated;
