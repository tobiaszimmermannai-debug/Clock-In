-- =============================================================================
-- Wissen · „Am Ende richtig“ zählt + Reparatur der Wiederholungen
-- =============================================================================
-- Wer eine Frage in einer Lektion erst falsch und dann (beim zweiten Anlauf) richtig hat, bekam sie bisher sofort
-- wieder als „fällig“ (Stufe 1). Jetzt gilt sie als gelernt: Stufe 2, wieder fällig frühestens morgen, ohne
-- Punkte (p_retry). Bestehende Lernstände werden einmal repariert: Stand eine Frage auf Stufe 1, war aber die
-- letzte Antwort richtig, kommt sie auf Stufe 2 (fällig 1 Tag nach dieser Antwort). (Mehrfach ausführbar.)
-- Voraussetzung: 20261121090000_wissen_fair_xp.sql
-- =============================================================================

-- alte Fassung (6 Parameter) entfernen, sonst gäbe es zwei gleichnamige Funktionen
drop function if exists public.wissen_answer(text, text, boolean, text, text[], integer);

create or replace function public.wissen_answer(p_item text, p_type text, p_correct boolean, p_mode text,
                                                p_answer text[] default null, p_xp integer default 0,
                                                p_retry boolean default false)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_me   uuid := (select auth.uid());
  v_prev public.wissen_item_progress;
  v_box  smallint;
  v_best smallint;
  v_due  timestamptz;
  v_xp   integer := 0;
  v_days integer[] := array[0, 1, 3, 7, 14, 30];
  v_total integer;
begin
  if v_me is null then
    raise exception 'Bitte anmelden.';
  end if;
  if p_type not in ('question', 'card') or p_mode not in ('lesson', 'review', 'blitzi', 'blitzrunde') or coalesce(length(p_item), 0) not between 1 and 80 then
    raise exception 'Ungültige Angaben.';
  end if;
  perform set_config('clockin.wissen', 'on', true);

  if p_item like 'bonus:%' then
    -- Bonus: höchstens einer je 10 Min., nur nach mindestens 5 Antworten mit Punkten in der letzten halben Stunde
    if (select count(*) from public.wissen_attempts a
        where a.user_id = v_me and a.xp_earned > 0 and a.item_id not like 'bonus:%' and a.created_at > now() - interval '30 minutes') >= 5
       and not exists (select 1 from public.wissen_attempts a
                       where a.user_id = v_me and a.item_id like 'bonus:%' and a.xp_earned > 0 and a.created_at > now() - interval '10 minutes') then
      v_xp := least(greatest(coalesce(p_xp, 0), 0), 10);
    end if;
  else
    select * into v_prev from public.wissen_item_progress where user_id = v_me and item_id = p_item for update;
    if p_retry and p_correct and v_prev.item_id is not null then
      -- in derselben Lektion erst falsch, dann richtig: sitzt jetzt – Stufe 2 (morgen wieder), keine Punkte
      v_box := greatest(v_prev.box, 2); v_best := v_prev.best_box;
      v_due := greatest(v_prev.due_at, now() + make_interval(days => v_days[v_box]));
    elsif p_correct and v_prev.item_id is not null and v_prev.due_at > now() then
      -- noch nicht wieder fällig: reine Übung – Stufe und Fälligkeit bleiben, keine Punkte
      v_box := v_prev.box; v_best := v_prev.best_box; v_due := v_prev.due_at;
    else
      v_box  := case when p_correct then least(6, coalesce(v_prev.box, 1) + 1) else 1 end;
      v_best := greatest(coalesce(v_prev.best_box, 0), case when p_correct then v_box else 0 end);
      v_due  := now() + make_interval(days => v_days[v_box]);
    end if;
    if p_correct and not p_retry and v_box > coalesce(v_prev.best_box, 0) then
      v_xp := least(greatest(coalesce(p_xp, 0), 0), case when p_type = 'card' then 5 else 20 end);
    end if;
    insert into public.wissen_item_progress (user_id, item_id, item_type, box, best_box, due_at, times_correct, times_wrong, last_seen_at)
    values (v_me, p_item, p_type, v_box, v_best, v_due, (p_correct)::int, (not p_correct)::int, now())
    on conflict (user_id, item_id) do update
      set box = excluded.box, best_box = excluded.best_box, due_at = excluded.due_at, last_seen_at = now(),
          times_correct = public.wissen_item_progress.times_correct + excluded.times_correct,
          times_wrong = public.wissen_item_progress.times_wrong + excluded.times_wrong;
  end if;

  insert into public.wissen_attempts (user_id, item_id, item_type, correct, answer, mode, xp_earned)
  values (v_me, p_item, p_type, p_correct, p_answer, p_mode, v_xp);
  insert into public.wissen_profile (user_id, xp_total, last_active_date)
  values (v_me, v_xp, (now() at time zone 'Europe/Berlin')::date)
  on conflict (user_id) do update
    set xp_total = public.wissen_profile.xp_total + excluded.xp_total, last_active_date = excluded.last_active_date, updated_at = now()
  returning xp_total into v_total;
  perform set_config('clockin.wissen', 'off', true);

  return jsonb_build_object('xp', v_xp, 'xp_total', v_total, 'box', v_box, 'best_box', v_best, 'due_at', v_due);
end $$;

revoke execute on function public.wissen_answer(text, text, boolean, text, text[], integer, boolean) from public, anon;
grant execute on function public.wissen_answer(text, text, boolean, text, text[], integer, boolean) to authenticated;

-- Reparatur: letzte Antwort richtig, Stufe aber noch 1 → Stufe 2
do $$ begin
  perform set_config('clockin.wissen', 'on', true);
  update public.wissen_item_progress p
     set box = 2, due_at = l.last_at + interval '1 day'
    from (select distinct on (a.user_id, a.item_id) a.user_id, a.item_id, a.correct, a.created_at as last_at
          from public.wissen_attempts a
          where a.item_id not like 'bonus:%'
          order by a.user_id, a.item_id, a.created_at desc) l
   where p.user_id = l.user_id and p.item_id = l.item_id and p.box = 1 and l.correct;
  perform set_config('clockin.wissen', 'off', true);
end $$;
