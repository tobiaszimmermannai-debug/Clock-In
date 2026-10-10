-- =============================================================================
-- Clock-In · Schul-Abgleich mit dem IST-Bildungspartner-Portal
-- =============================================================================
-- Importierte Schultage werden markiert (import_source = 'ist'), damit der nächste Abgleich sie
-- anpassen oder entfernen kann. Von Hand eingetragene Schultage (import_source leer) bleiben unberührt.
-- (Mehrfach ausführbar.)
-- =============================================================================

alter table public.shifts add column if not exists import_source text;
create index if not exists shifts_import_source_idx on public.shifts (import_source) where import_source is not null;
