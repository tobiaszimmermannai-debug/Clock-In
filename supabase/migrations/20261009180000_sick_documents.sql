-- =============================================================================
-- Clock-In · Krankheit: Attest / Karenztag-Zettel abhaken (nur Admin)
-- =============================================================================
-- Je Krank-Eintrag zwei Haken; die Übersicht „Krankheit“ fasst zusammenhängende Tage zu einem
-- Fall zusammen und setzt die Haken für alle Tage des Falls. Studioleitung kann sie nicht setzen.
-- (Mehrfach ausführbar.)
-- =============================================================================

alter table public.shifts
  add column if not exists attest_received boolean not null default false,
  add column if not exists karenz_received boolean not null default false;

alter table public.shifts drop constraint if exists shifts_sick_documents;
alter table public.shifts add constraint shifts_sick_documents
  check (shift_type = 'sick' or (not attest_received and not karenz_received));

-- Anlegen: Haken nur durch Admin (Ändern von Krank-Einträgen ist ohnehin nur Admin erlaubt)
drop policy if exists shifts_insert on public.shifts;
create policy shifts_insert on public.shifts for insert to authenticated
  with check (private.can_plan_shift(location_id, user_id, is_acquisition)
              and (not from_shift or private.is_admin())
              and ((not attest_received and not karenz_received) or private.is_admin()));
