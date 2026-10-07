-- =============================================================================
-- Clock-In · Aushilfe anfragen und stellen
-- =============================================================================
-- * Studioleitung fragt für ihr Studio eine Aushilfe an (Tag, von–bis, Hinweis).
--   Alle sehen offene Anfragen im Dienstplan („Aushilfe gesucht“).
-- * Leitung eines anderen Studios „stellt“ die Aushilfe: wählt eigenen Mitarbeiter → Schicht wird
--   direkt im anfragenden Studio eingetragen (fill_help_request). Ohne Anfrage bleiben normale
--   Schichten in fremden Studios gesperrt.
-- * Wird die gestellte Schicht gelöscht, ist die Anfrage automatisch wieder offen.
-- (Mehrfach ausführbar.)
-- =============================================================================

create table if not exists public.help_requests (
  id              uuid primary key default gen_random_uuid(),
  location_id     uuid not null references public.locations (id) on delete cascade,
  starts_at       timestamptz not null,
  ends_at         timestamptz not null,
  note            text check (char_length(note) <= 200),
  status          text not null default 'open' check (status in ('open', 'filled')),
  created_by      uuid default private.current_user_id() references public.users (id) on delete set null,
  created_at      timestamptz not null default now(),
  filled_shift_id uuid references public.shifts (id) on delete set null,
  filled_by       uuid references public.users (id) on delete set null,
  filled_at       timestamptz,
  constraint help_requests_time check (ends_at > starts_at and ends_at - starts_at <= interval '24 hours')
);
create index if not exists help_requests_start_idx on public.help_requests (starts_at);

alter table public.help_requests enable row level security;
-- sehen: alle Angemeldeten aus dem Team; anfragen/zurückziehen: Leitung des Studios
drop policy if exists help_requests_select on public.help_requests;
drop policy if exists help_requests_insert on public.help_requests;
drop policy if exists help_requests_delete on public.help_requests;
create policy help_requests_select on public.help_requests for select to authenticated
  using ((select private.is_staff()));
create policy help_requests_insert on public.help_requests for insert to authenticated
  with check (private.manages_location(location_id) and status = 'open'
              and filled_shift_id is null and filled_by is null and filled_at is null);
create policy help_requests_delete on public.help_requests for delete to authenticated
  using (private.manages_location(location_id) and status = 'open');
grant select, insert, delete on public.help_requests to authenticated;

-- Gestellte Schicht gelöscht → Anfrage wieder offen
create or replace function private.help_request_reopen() returns trigger
language plpgsql set search_path = '' as $$
begin
  if old.filled_shift_id is not null and new.filled_shift_id is null and new.status = 'filled' then
    new.status := 'open';
    new.filled_by := null;
    new.filled_at := null;
  end if;
  return new;
end $$;
drop trigger if exists help_request_reopen on public.help_requests;
create trigger help_request_reopen before update on public.help_requests
  for each row execute function private.help_request_reopen();

-- Aushilfe stellen: eigener Mitarbeiter (bzw. Admin: jeder) übernimmt die angefragte Zeit
create or replace function public.fill_help_request(p_request_id uuid, p_user_id uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_req   public.help_requests;
  v_home  text;
  v_shift uuid;
begin
  select * into v_req from public.help_requests where id = p_request_id for update;
  if not found then
    raise exception 'Anfrage nicht gefunden.';
  end if;
  if v_req.status <> 'open' then
    raise exception 'Diese Anfrage ist schon vergeben.';
  end if;
  if not private.manages_user(p_user_id) then
    raise exception 'Du kannst nur eigene Mitarbeiter als Aushilfe stellen.' using errcode = '42501';
  end if;
  if not exists (select 1 from public.users where id = p_user_id and is_active and role <> 'admin') then
    raise exception 'Mitarbeiter nicht gefunden.';
  end if;

  select l.name into v_home from public.users u join public.locations l on l.id = u.home_location_id where u.id = p_user_id;
  insert into public.shifts (user_id, location_id, shift_type, starts_at, ends_at, note, created_by)
  values (p_user_id, v_req.location_id, 'work', v_req.starts_at, v_req.ends_at,
          'Aushilfe' || coalesce(' aus ' || regexp_replace(v_home, '^Studio\s+', ''), ''), private.current_user_id())
  returning id into v_shift;

  update public.help_requests
     set status = 'filled', filled_shift_id = v_shift, filled_by = private.current_user_id(), filled_at = now()
   where id = p_request_id;
  return v_shift;
end $$;

revoke execute on function public.fill_help_request(uuid, uuid) from public, anon;
grant execute on function public.fill_help_request(uuid, uuid) to authenticated;
revoke execute on all functions in schema private from public;
grant execute on all functions in schema private to authenticated, service_role;
