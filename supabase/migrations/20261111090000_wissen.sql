-- =============================================================================
-- Clock-In · Reiter „Wissen“: Lernfortschritt (Inhalte liegen statisch im Repo, app/src/content/wissen)
-- =============================================================================
-- user_id = Supabase-Auth-Konto (auth.uid()); jede Person schreibt nur ihre eigenen Zeilen.
-- Lesen dürfen zusätzlich Admins und die Studioleitung des Heimatstudios (für die spätere Auswertung:
-- Fortschritt je Lektion, häufigste Fehler). (Mehrfach ausführbar.)
-- =============================================================================

create table if not exists public.wissen_profile (
  user_id          uuid primary key references auth.users (id) on delete cascade,
  xp_total         integer not null default 0,
  daily_goal_xp    integer not null default 30,
  streak_days      integer not null default 0,
  longest_streak   integer not null default 0,
  last_active_date date,
  updated_at       timestamptz not null default now()
);

create table if not exists public.wissen_item_progress (
  user_id        uuid not null references auth.users (id) on delete cascade,
  item_id        text not null,                       -- Question.id oder Flashcard.id
  item_type      text not null check (item_type in ('question', 'card')),
  box            smallint not null default 1 check (box between 1 and 6),
  due_at         timestamptz not null default now(),
  times_correct  integer not null default 0,
  times_wrong    integer not null default 0,
  last_seen_at   timestamptz,
  primary key (user_id, item_id)
);
create index if not exists wissen_item_progress_due_idx on public.wissen_item_progress (user_id, due_at);

create table if not exists public.wissen_attempts (
  id          bigint generated always as identity primary key,
  user_id     uuid not null references auth.users (id) on delete cascade,
  item_id     text not null,
  item_type   text not null check (item_type in ('question', 'card')),
  correct     boolean not null,
  answer      text[],                                  -- gewählte Options-IDs (bei Karten null)
  mode        text not null check (mode in ('lesson', 'review', 'blitzi', 'blitzrunde')),
  xp_earned   integer not null default 0 check (xp_earned between 0 and 50),
  created_at  timestamptz not null default now()
);
create index if not exists wissen_attempts_user_idx on public.wissen_attempts (user_id, created_at desc);
create index if not exists wissen_attempts_item_idx on public.wissen_attempts (item_id, correct);

-- XP pro Tag (Tagesziel, Wochen-XP, Serie)
create or replace view public.wissen_daily_xp
with (security_invoker = true) as
select user_id, (created_at at time zone 'Europe/Berlin')::date as day, sum(xp_earned)::int as xp, count(*)::int as answers
from public.wissen_attempts group by 1, 2;

alter table public.wissen_profile       enable row level security;
alter table public.wissen_item_progress enable row level security;
alter table public.wissen_attempts      enable row level security;

-- Leitung: Admin oder Studioleitung des Heimatstudios der Person
create or replace function private.wissen_can_read(p_auth uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select p_auth = (select auth.uid())
      or exists (select 1 from public.users u where u.auth_user_id = p_auth and private.manages_user(u.id))
$$;
revoke execute on function private.wissen_can_read(uuid) from public;
grant execute on function private.wissen_can_read(uuid) to authenticated;

drop policy if exists "own profile" on public.wissen_profile;
drop policy if exists wissen_profile_select on public.wissen_profile;
drop policy if exists wissen_profile_write on public.wissen_profile;
create policy wissen_profile_select on public.wissen_profile for select to authenticated using ((select private.wissen_can_read(user_id)));
create policy wissen_profile_write on public.wissen_profile for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

drop policy if exists "own progress" on public.wissen_item_progress;
drop policy if exists wissen_progress_select on public.wissen_item_progress;
drop policy if exists wissen_progress_write on public.wissen_item_progress;
create policy wissen_progress_select on public.wissen_item_progress for select to authenticated using ((select private.wissen_can_read(user_id)));
create policy wissen_progress_write on public.wissen_item_progress for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

drop policy if exists "own attempts read" on public.wissen_attempts;
drop policy if exists "own attempts insert" on public.wissen_attempts;
drop policy if exists wissen_attempts_select on public.wissen_attempts;
drop policy if exists wissen_attempts_insert on public.wissen_attempts;
create policy wissen_attempts_select on public.wissen_attempts for select to authenticated using ((select private.wissen_can_read(user_id)));
create policy wissen_attempts_insert on public.wissen_attempts for insert to authenticated with check (user_id = (select auth.uid()));

grant select, insert, update, delete on public.wissen_profile, public.wissen_item_progress to authenticated;
grant select, insert on public.wissen_attempts to authenticated;
grant select on public.wissen_daily_xp to authenticated;
