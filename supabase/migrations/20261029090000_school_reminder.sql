-- =============================================================================
-- Clock-In · Erinnerung „Tobi: Bitte Schule aktualisieren“
-- =============================================================================
-- Am ersten Montag jedes Monats um 9 Uhr per Telegram an Tobias (Admin, Vorname „Tobi…“) –
-- gibt es ihn nicht, an alle Admins. (Mehrfach ausführbar.)
-- =============================================================================

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
  if v_hour = v_settings.absence_check_hour and extract(isodow from v_local) <> 7 then  -- Sonntag nie
    perform private.call_telegram(jsonb_build_object('type', 'absence_check', 'date', v_local::date));
  end if;
  if extract(isodow from v_local) = v_settings.weekly_report_dow and v_hour = v_settings.weekly_report_hour then
    perform private.call_telegram(jsonb_build_object(
      'type', 'weekly_report', 'from', date_trunc('week', v_local)::date, 'to', v_local::date));
  end if;
  -- Erste Woche im Monat (erster Montag, 9 Uhr): Erinnerung an Tobias, die Schultermine (IST) zu aktualisieren
  if extract(isodow from v_local) = 1 and extract(day from v_local) <= 7 and v_hour = 9 then
    perform private.call_telegram(jsonb_build_object(
      'type', 'school_reminder',
      'user_id', (select u.id from public.users u
                  where u.role = 'admin' and u.is_active and u.first_name ilike 'Tobi%'
                  order by u.first_name limit 1)));
  end if;
  if extract(day from v_local) = 1 and v_hour = v_settings.monthly_report_hour
     and coalesce(v_settings.monthly_report_email, '') <> '' then
    perform private.call_telegram(jsonb_build_object('type', 'monthly_report', 'month', date_trunc('month', v_local)::date));
  end if;
end $$;

revoke execute on all functions in schema private from public;
grant execute on all functions in schema private to authenticated, service_role;
