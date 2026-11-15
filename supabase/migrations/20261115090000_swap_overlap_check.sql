-- =============================================================================
-- Clock-In · Schichttausch: Überschneidung früh und verständlich melden
-- =============================================================================
-- Bisher scheiterte die Freigabe erst beim Umschreiben der Schichten mit dem Datenbank-Text
-- „conflicting key value violates exclusion constraint shifts_no_overlap“ (die Person hatte zur selben Zeit
-- schon einen Eintrag: Schicht, Schule, Urlaub, Krank, Frei …). Jetzt wird das schon beim Antrag und noch einmal
-- bei der Freigabe geprüft – mit Name, Tag und dem Eintrag, der im Weg ist. (Mehrfach ausführbar.)
-- =============================================================================

create or replace function private.swap_conflict(p_user uuid, p_from timestamptz, p_to timestamptz, p_ignore uuid[])
returns text
language sql stable security definer set search_path = '' as $$
  select
    u.first_name || ' ' || u.last_name || ' hat am '
    || to_char(s.starts_at at time zone 'Europe/Berlin', 'DD.MM.') || ' schon einen Eintrag ('
    || case s.shift_type::text
         when 'work' then 'Schicht ' || to_char(s.starts_at at time zone 'Europe/Berlin', 'HH24:MI') || '–'
                          || to_char(s.ends_at at time zone 'Europe/Berlin', 'HH24:MI')
                          || coalesce(' · ' || l.name, '')
         when 'vocational_school' then 'Schule'
         when 'vacation' then 'Urlaub'
         when 'sick' then 'Krank'
         when 'day_off' then 'Frei'
         else s.shift_type::text
       end
    || ')'
  from public.shifts s
  join public.users u on u.id = s.user_id
  left join public.locations l on l.id = s.location_id
  where s.user_id = p_user
    and not coalesce(s.id = any (array_remove(p_ignore, null)), false)
    and tstzrange(s.starts_at, s.ends_at) && tstzrange(p_from, p_to)
  order by s.starts_at
  limit 1
$$;

create or replace function private.swap_requests_overlap_check() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_req  public.shifts;
  v_tgt  public.shifts;
  v_hit  text;
  v_what text;
begin
  -- nur beim Anlegen und beim Freigeben prüfen
  if not (tg_op = 'INSERT' or (new.status = 'approved' and old.status = 'pending')) then
    return new;
  end if;
  select * into v_req from public.shifts where id = new.requester_shift_id;
  if not found then
    return new;  -- die eigentliche Prüfung meldet das
  end if;
  if new.target_shift_id is not null then
    select * into v_tgt from public.shifts where id = new.target_shift_id;
  end if;
  v_what := case when new.target_shift_id is null then 'Übernahme' else 'Tausch' end;

  -- Wer übernimmt, bekommt die Zeit der abgegebenen Schicht (die eigene Gegenschicht wird ja abgegeben)
  v_hit := private.swap_conflict(new.target_user_id, v_req.starts_at, v_req.ends_at,
                                 array[new.requester_shift_id, new.target_shift_id]);
  if v_hit is not null then
    raise exception 'Schichttausch: % – % nicht möglich. Bitte den Eintrag zuerst ändern oder jemand anderen fragen.', v_hit, v_what
      using errcode = 'P0001';
  end if;
  -- Beim Tausch bekommt die anfragende Person die Gegenschicht
  if v_tgt.id is not null then
    v_hit := private.swap_conflict(new.requester_id, v_tgt.starts_at, v_tgt.ends_at,
                                   array[new.requester_shift_id, new.target_shift_id]);
    if v_hit is not null then
      raise exception 'Schichttausch: % – % nicht möglich. Bitte den Eintrag zuerst ändern.', v_hit, v_what
        using errcode = 'P0001';
    end if;
  end if;
  return new;
end $$;

-- läuft vor „validate“ (Trigger feuern alphabetisch)
drop trigger if exists overlap_check on public.swap_requests;
create trigger overlap_check before insert or update on public.swap_requests
  for each row execute function private.swap_requests_overlap_check();

revoke execute on function private.swap_conflict(uuid, timestamptz, timestamptz, uuid[]), private.swap_requests_overlap_check() from public;
grant execute on function private.swap_conflict(uuid, timestamptz, timestamptz, uuid[]), private.swap_requests_overlap_check() to authenticated, service_role;
