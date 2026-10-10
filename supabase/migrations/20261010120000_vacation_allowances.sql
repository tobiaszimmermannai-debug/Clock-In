-- =============================================================================
-- Clock-In · Urlaubsanspruch je Jahr (Admin trägt ihn ein, Standard 20 Tage)
-- =============================================================================
-- * Je Person und Jahr ein Anspruch (z. B. anteilig im Eintrittsjahr). Ohne Eintrag gilt der Standard
--   aus rule_settings.default_vacation_days (20).
-- * Bisherige Werte aus dem Arbeitsvertrag werden fürs laufende Jahr übernommen.
-- * Resturlaub = Anspruch − genommen − eingetragen (zählt runter, sobald Urlaub im Dienstplan steht).
-- (Mehrfach ausführbar.)
-- =============================================================================

alter table public.rule_settings
  add column if not exists default_vacation_days numeric(4,1) not null default 20
    check (default_vacation_days between 0 and 365);

create table if not exists public.vacation_allowances (
  user_id    uuid not null references public.users (id) on delete cascade,
  year       integer not null check (year between 2000 and 2100),
  days       numeric(4,1) not null check (days between 0 and 365),
  updated_at timestamptz not null default now(),
  primary key (user_id, year)
);
alter table public.vacation_allowances enable row level security;
drop policy if exists vacation_allowances_select on public.vacation_allowances;
drop policy if exists vacation_allowances_write on public.vacation_allowances;
-- sehen: die Person selbst und ihre Leitung; ändern: nur Admin
create policy vacation_allowances_select on public.vacation_allowances for select to authenticated
  using (user_id = (select private.current_user_id()) or private.manages_user(user_id));
create policy vacation_allowances_write on public.vacation_allowances for all to authenticated
  using ((select private.is_admin())) with check ((select private.is_admin()));
grant select, insert, update, delete on public.vacation_allowances to authenticated;

insert into public.vacation_allowances (user_id, year, days)
select e.user_id, extract(year from now() at time zone 'Europe/Berlin')::integer, e.vacation_days_per_year
from public.employment_details e
where e.vacation_days_per_year is not null
on conflict do nothing;

create or replace function public.vacation_overview(p_year integer)
returns table (user_id uuid, allowance numeric, taken integer, planned integer)
language sql stable security definer set search_path = '' as $$
  select u.id,
         coalesce(a.days, (select r.default_vacation_days from public.rule_settings r), 20),
         count(distinct s.shift_date) filter (where s.shift_date <= (now() at time zone 'Europe/Berlin')::date)::integer,
         count(distinct s.shift_date) filter (where s.shift_date > (now() at time zone 'Europe/Berlin')::date)::integer
  from public.users u
  left join public.vacation_allowances a on a.user_id = u.id and a.year = p_year
  left join public.shifts s on s.user_id = u.id and s.shift_type = 'vacation'
        and s.shift_date >= make_date(p_year, 1, 1) and s.shift_date < make_date(p_year + 1, 1, 1)
  where u.is_active and (u.id = private.current_user_id() or private.manages_user(u.id))
  group by u.id, a.days
$$;
