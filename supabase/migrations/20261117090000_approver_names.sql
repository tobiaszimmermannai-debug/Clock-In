-- =============================================================================
-- Clock-In · Wer gibt frei? Name einstellbar statt fest im Text
-- =============================================================================
-- Die App zeigte überall fest „Tobias oder Dominik“. Der Text steht jetzt in rule_settings.approver_names
-- (Supabase → Table Editor → rule_settings) und kann dort geändert werden. (Mehrfach ausführbar.)
-- =============================================================================
alter table public.rule_settings add column if not exists approver_names text not null default 'Tobias oder Dominik';
