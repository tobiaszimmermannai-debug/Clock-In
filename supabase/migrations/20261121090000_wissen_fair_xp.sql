-- =============================================================================
-- Wissen · faire Punkte und Level
-- =============================================================================
-- Punkte (XP) vergibt jetzt die Datenbank über wissen_answer – nicht mehr die App:
--   · falsch = 0 XP
--   · richtig = XP nur, wenn die Frage/Karte neu oder wieder fällig ist UND damit eine NEUE beste Stufe erreicht
--     (best_box). Wer dieselbe Frage
--     wiederholt (auch nach absichtlich falscher Antwort), bekommt keine weiteren Punkte. Üben bleibt erlaubt.
--   · Bonus „fehlerfrei“ nur, wenn in der letzten halben Stunde mindestens 5 Antworten Punkte gebracht haben.
-- Gesamt-XP stehen in wissen_profile.xp_total (Grundlage für das Level). Ältere App-Versionen, die noch direkt
-- schreiben, funktionieren weiter, bekommen aber 0 XP. Bestehende XP bleiben erhalten. (Mehrfach ausführbar.)
-- Voraussetzung: 20261111090000_wissen.sql
-- =============================================================================

alter table public.wissen_item_progress add column if not exists best_box smallint not null default 0;
-- Start: bisher erreichte Stufe gilt als beste (einmalig, nur wo noch 0)
update public.wissen_item_progress set best_box = box where best_box = 0 and times_correct > 0;

-- Gesamt-XP aus den bisherigen Antworten übernehmen
insert into public.wissen_profile (user_id, xp_total)
select a.user_id, sum(a.xp_earned) from public.wissen_attempts a group by a.user_id
on conflict (user_id) do update set xp_total = greatest(public.wissen_profile.xp_total, excluded.xp_total);

-- Direktes Schreiben (ältere App): XP und beste Stufe kann nur wissen_answer setzen
create or replace function private.wissen_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if coalesce(current_setting('clockin.wissen', true), '') = 'on' or (select auth.uid()) is null then
    return new;
  end if;
  if tg_table_name = 'wissen_attempts' then
    new.xp_earned := 0;
  elsif tg_table_name = 'wissen_item_progress' then
    new.best_box := case when tg_op = 'UPDATE' then old.best_box else 0 end;
  elsif tg_table_name = 'wissen_profile' then
    new.xp_total := case when tg_op = 'UPDATE' then old.xp_total else 0 end;
  end if;
  return new;
end $$;

drop trigger if exists guard on public.wissen_attempts;
create trigger guard before insert on public.wissen_attempts for each row execute function private.wissen_guard();
drop trigger if exists guard on public.wissen_item_progress;
create trigger guard before insert or update on public.wissen_item_progress for each row execute function private.wissen_guard();
drop trigger if exists guard on public.wissen_profile;
create trigger guard before insert or update on public.wissen_profile for each row execute function private.wissen_guard();

-- Eine Antwort speichern. p_xp = Punktwert der Frage (10/15/20) bzw. Karte (5); die Datenbank entscheidet, ob er zählt.
-- p_item 'bonus:…' = Bonus „fehlerfrei“.
create or replace function public.wissen_answer(p_item text, p_type text, p_correct boolean, p_mode text,
                                                p_answer text[] default null, p_xp integer default 0)
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
    if p_correct and v_prev.item_id is not null and v_prev.due_at > now() then
      -- noch nicht wieder fällig: reine Übung – Stufe und Fälligkeit bleiben, keine Punkte
      v_box := v_prev.box; v_best := v_prev.best_box; v_due := v_prev.due_at;
    else
      v_box  := case when p_correct then least(6, coalesce(v_prev.box, 1) + 1) else 1 end;
      v_best := greatest(coalesce(v_prev.best_box, 0), case when p_correct then v_box else 0 end);
      v_due  := now() + make_interval(days => v_days[v_box]);
    end if;
    if p_correct and v_box > coalesce(v_prev.best_box, 0) then
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

revoke execute on function public.wissen_answer(text, text, boolean, text, text[], integer) from public, anon;
grant execute on function public.wissen_answer(text, text, boolean, text, text[], integer) to authenticated;

revoke execute on all functions in schema private from public;
grant execute on all functions in schema private to authenticated, service_role;
