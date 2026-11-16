-- =============================================================================
-- Aufgaben · faire Punkte: Gutschrift behält ihr erstes Datum, Team-Wertung nur mit Anwesenden
-- =============================================================================
-- 1) Wer eine erledigte Aufgabe wieder öffnet und neu abhakt, bekam die Gutschrift mit neuem Datum – so hielt eine
--    einzige Aufgabe die Serie am Leben und alte Punkte wanderten in die neue Woche. Jetzt merkt sich die Datenbank
--    das erste Erledigt-Datum je Aufgabe und Person; erneutes Abhaken bekommt wieder dieses Datum.
--    Das Datum setzt immer die Datenbank (nicht das Gerät).
-- 2) Team-Wertung: geteilt wird nur durch Personen, die in der Woche gearbeitet haben (nicht Urlaub/Krank/Schule).
--    note_week_active liefert diese Personen. (Mehrfach ausführbar.)
-- Voraussetzung: 20261102090000_notes_streak_days.sql
-- =============================================================================

create table if not exists public.note_task_first (
  page_id       uuid not null references public.note_pages (id) on delete cascade,
  user_id       uuid not null references auth.users (id) on delete cascade,
  first_done_at timestamptz not null,
  primary key (page_id, user_id)
);
alter table public.note_task_first enable row level security;  -- nur über den Trigger
revoke all on public.note_task_first from anon, authenticated;

insert into public.note_task_first (page_id, user_id, first_done_at)
select e.page_id, e.user_id, min(e.done_at) from public.note_task_events e group by 1, 2
on conflict do nothing;

create or replace function private.note_task_events_first() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_first timestamptz;
begin
  select f.first_done_at into v_first from public.note_task_first f
  where f.page_id = new.page_id and f.user_id = new.user_id;
  if found then
    new.done_at := v_first;
  else
    if (select auth.uid()) is not null then
      new.done_at := now();
    end if;
    insert into public.note_task_first (page_id, user_id, first_done_at)
    values (new.page_id, new.user_id, new.done_at)
    on conflict do nothing;
  end if;
  return new;
end $$;

drop trigger if exists first_done on public.note_task_events;
create trigger first_done before insert on public.note_task_events
  for each row execute function private.note_task_events_first();

-- Wer hat im Zeitraum gearbeitet? (eingestempelt, ohne Schule/Urlaub/Krank/Frei) – für den Teiler der Team-Wertung
create or replace function public.note_week_active(p_from date, p_to date) returns setof uuid
language sql stable security definer set search_path = '' as $$
  select u.auth_user_id
  from public.users u
  where u.is_active and u.auth_user_id is not null
    and ((select auth.uid()) is null or private.is_note_user())
    and exists (select 1 from private.note_counting_days(u.id, p_from) as d where d < p_to)
$$;

revoke execute on function private.note_task_events_first() from public, anon, authenticated;
revoke execute on function public.note_week_active(date, date) from public, anon;
grant execute on function public.note_week_active(date, date) to authenticated, service_role;
