-- =============================================================================
-- Clock-In · Schicht-Statistik nach dem Ausstempeln: 12 Std. statt 30 Min. Zeit (mehrfach ausführbar)
-- =============================================================================
-- Die App fragt die Zahlen jetzt erneut ab, wenn die Abfrage verloren ging (Neuladen, Reiterwechsel, iPhone im
-- Hintergrund). Damit das klappt, nimmt die Datenbank sie bis 12 Std. nach dem „Gehen“ an – solange danach
-- nicht wieder gestempelt wurde (es zählt immer das letzte Ausstempeln).
-- =============================================================================
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
  if not found or v_log.event_type <> 'clock_out' or v_log.received_at < now() - interval '12 hours' then
    raise exception 'Die Statistik wird nach dem Ausstempeln eingetragen (bis 12 Std. danach).';
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
