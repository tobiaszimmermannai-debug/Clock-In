// Wer gibt frei? Der Name steht in rule_settings.approver_names (statt fest im Text) – Standard „Tobias oder Dominik“.
import type { SupabaseClient } from "@supabase/supabase-js";
import { DEFAULT_RULES, type RuleSettings } from "./types";

let names = "Tobias oder Dominik";
let rules: RuleSettings = DEFAULT_RULES;

/** z. B. „Tobias oder Dominik“ */
export const approvers = () => names;
/** Regel-Werte (Toleranz, Pausen …) für Erklärtexte; verbindlich rechnet die Datenbank */
export const currentRules = () => rules;

/** Einmal nach der Anmeldung laden; ohne Verbindung oder mit älterer Datenbank bleibt der Standard */
export async function loadApprovers(db: SupabaseClient): Promise<void> {
  try {
    const { data } = await db.from("rule_settings").select("*").maybeSingle();
    if (!data) return;
    const row = data as Partial<RuleSettings> & { approver_names?: string | null };
    if (row.approver_names?.trim()) names = row.approver_names.trim();
    rules = { ...DEFAULT_RULES, ...Object.fromEntries(Object.entries(row).filter(([k, v]) => k in DEFAULT_RULES && typeof v === "number")) } as RuleSettings;
  } catch {
    // Standard bleibt
  }
}
