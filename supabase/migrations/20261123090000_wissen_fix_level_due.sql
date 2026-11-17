-- =============================================================================
-- Wissen · Level und Wiederholungen korrigieren (einmalig)
-- =============================================================================
-- 1) Level zu hoch: Beim Umstieg auf faire Punkte wurden ALLE alten Punkte übernommen – auch die aus der alten
--    App, die für jedes erneute Durchspielen derselben Frage wieder Punkte gab. Neu berechnet: je Frage/Karte
--    zählen die alten Punkte nur einmal (höchster Wert), Bonus „fehlerfrei“ höchstens einmal pro Tag.
-- 2) Zu viele fällige Wiederholungen: Fragen, deren letzte Antwort richtig war, gelten als gelernt. Sie kommen
--    nicht alle auf einmal wieder, sondern verteilt über die nächsten 2–8 Tage. Falsch beantwortete bleiben fällig.
-- Läuft nur EINMAL (Merker in job_runs) – ein erneutes Ausführen ändert nichts. Voraussetzung: 20261122090000_wissen_retry.sql
-- =============================================================================

do $$
begin
  insert into public.job_runs (job, day) values ('wissen_fix_level_due', date '2000-01-01') on conflict do nothing;
  if not found then
    return;  -- schon gelaufen
  end if;
  perform set_config('clockin.wissen', 'on', true);

  -- 1) Gesamt-XP fair neu berechnen
  update public.wissen_profile p
     set xp_total = coalesce(x.items, 0) + coalesce(x.bonus, 0), updated_at = now()
    from (
      select u.user_id,
             (select sum(m) from (select max(a.xp_earned) m from public.wissen_attempts a
                                  where a.user_id = u.user_id and a.item_id not like 'bonus:%' group by a.item_id) i) as items,
             (select sum(m) from (select max(a.xp_earned) m from public.wissen_attempts a
                                  where a.user_id = u.user_id and a.item_id like 'bonus:%'
                                  group by (a.created_at at time zone 'Europe/Berlin')::date) b) as bonus
      from (select distinct user_id from public.wissen_profile) u
    ) x
   where p.user_id = x.user_id;

  -- 2) Gelernte Fragen verteilt wiedervorlegen (2–8 Tage), nicht alle sofort
  update public.wissen_item_progress p
     set box = greatest(p.box, 2),
         due_at = now() + make_interval(days => 2 + abs(hashtext(p.user_id::text || p.item_id)) % 7)
    from (select distinct on (a.user_id, a.item_id) a.user_id, a.item_id, a.correct
          from public.wissen_attempts a
          where a.item_id not like 'bonus:%'
          order by a.user_id, a.item_id, a.created_at desc) l
   where p.user_id = l.user_id and p.item_id = l.item_id and l.correct and p.due_at <= now() + interval '1 day';

  perform set_config('clockin.wissen', 'off', true);
end $$;
