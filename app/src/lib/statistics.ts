// Statistik (Verwaltung): Kennzahlen aus dem Ausstempeln je Person und Studio zusammenfassen
import { addDays, weekStart } from "./dates";
import { REPORT_FIELDS, type ReportKey } from "./shiftReport";

export type ReportRow = { user_id: string; location_id: string | null; created_at: string } & Record<ReportKey, number>;
export type Period = "week" | "month" | "year" | "all";
export type StatRow = { key: string; label: string; sub?: string; shifts: number; values: Record<ReportKey, number>; sum: number };

const MONTHS = ["Januar", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober", "November", "Dezember"];

/** Zeitraum (Berliner Kalendertage, Ende exklusiv) zu einem Bezugstag; offset blättert vor/zurück */
export function periodRange(period: Period, day: string, offset = 0): { from: string | null; to: string | null; label: string } {
  if (period === "all") return { from: null, to: null, label: "Gesamter Zeitraum" };
  if (period === "week") {
    const from = addDays(weekStart(day), offset * 7);
    const to = addDays(from, 7);
    return { from, to, label: `${from.slice(8, 10)}.${from.slice(5, 7)}. – ${addDays(to, -1).slice(8, 10)}.${addDays(to, -1).slice(5, 7)}.${to.slice(0, 4)}` };
  }
  const [y, m] = day.split("-").map(Number);
  if (period === "month") {
    const d = new Date(Date.UTC(y, m - 1 + offset, 1));
    const from = d.toISOString().slice(0, 10);
    const to = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString().slice(0, 10);
    return { from, to, label: `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}` };
  }
  const year = y + offset;
  return { from: `${year}-01-01`, to: `${year + 1}-01-01`, label: String(year) };
}

const empty = () => Object.fromEntries(REPORT_FIELDS.map((f) => [f.key, 0])) as Record<ReportKey, number>;

/** Summen je Gruppe (Person oder Studio) */
export function groupReports(rows: ReportRow[], keyOf: (r: ReportRow) => string, labelOf: (key: string) => { label: string; sub?: string }): StatRow[] {
  const map = new Map<string, StatRow>();
  for (const r of rows) {
    const key = keyOf(r);
    const g = map.get(key) ?? { key, ...labelOf(key), shifts: 0, values: empty(), sum: 0 };
    g.shifts++;
    for (const f of REPORT_FIELDS) {
      g.values[f.key] += r[f.key] ?? 0;
      g.sum += r[f.key] ?? 0;
    }
    map.set(key, g);
  }
  return [...map.values()];
}

export function totalRow(rows: StatRow[]): StatRow {
  const t: StatRow = { key: "total", label: "Gesamt", shifts: 0, values: empty(), sum: 0 };
  for (const r of rows) {
    t.shifts += r.shifts;
    t.sum += r.sum;
    for (const f of REPORT_FIELDS) t.values[f.key] += r.values[f.key];
  }
  return t;
}

/** CSV für Excel (Semikolon, deutsches Format) */
export function toCsv(rows: StatRow[], first: string): string {
  const head = [first, "Schichten", ...REPORT_FIELDS.map((f) => f.short), "Summe"];
  const esc = (v: string | number) => {
    const s = String(v);
    return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return "﻿" + [head, ...rows.map((r) => [r.label, r.shifts, ...REPORT_FIELDS.map((f) => r.values[f.key]), r.sum])]
    .map((line) => line.map(esc).join(";")).join("\r\n");
}
