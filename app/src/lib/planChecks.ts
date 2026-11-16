// Hinweise bei der Planung (kein Verbot): Ruhezeit, lange Tage, über den Wochenstunden
import { berlinDate, fmtDay, fmtHM } from "./dates";

export type CheckShift = { user_id: string; shift_type: string; starts_at: string; ends_at: string };
export type CheckPerson = { id: string; first_name: string; last_name: string; weekly_target_minutes?: number | null };

/** Mindest-Ruhezeit zwischen zwei Arbeitstagen (§ 5 ArbZG) */
export const MIN_REST_MINUTES = 11 * 60;
/** Höchstens so viel geplante Arbeitszeit an einem Tag (§ 3 ArbZG) */
export const MAX_DAY_MINUTES = 10 * 60;

const minutes = (s: CheckShift) => Math.round((Date.parse(s.ends_at) - Date.parse(s.starts_at)) / 60_000);

/** Hinweise für die übergebenen Personen aus den Arbeitsschichten einer Woche */
export function planWarnings(shifts: CheckShift[], people: CheckPerson[]): string[] {
  const out: string[] = [];
  for (const p of people) {
    const work = shifts.filter((s) => s.user_id === p.id && s.shift_type === "work").sort((a, b) => a.starts_at.localeCompare(b.starts_at));
    if (!work.length) continue;
    const name = `${p.first_name} ${p.last_name}`;
    const byDay = new Map<string, CheckShift[]>();
    for (const s of work) byDay.set(berlinDate(s.starts_at), [...(byDay.get(berlinDate(s.starts_at)) ?? []), s]);
    const days = [...byDay.keys()].sort();
    for (const d of days) {
      const total = byDay.get(d)!.reduce((n, s) => n + minutes(s), 0);
      if (total > MAX_DAY_MINUTES) out.push(`${name}: ${fmtDay(d)} ${fmtHM(total)} Std. geplant (mehr als 10 Std.).`);
    }
    for (let i = 1; i < days.length; i++) {
      const prev = byDay.get(days[i - 1])!;
      const next = byDay.get(days[i])!;
      const rest = Math.round((Date.parse(next[0].starts_at) - Math.max(...prev.map((s) => Date.parse(s.ends_at)))) / 60_000);
      if (rest < MIN_REST_MINUTES) out.push(`${name}: nur ${fmtHM(rest)} Std. Ruhezeit vor ${fmtDay(days[i])} (mindestens 11 Std.).`);
    }
    const week = work.reduce((n, s) => n + minutes(s), 0);
    if (p.weekly_target_minutes && week > p.weekly_target_minutes) {
      out.push(`${name}: ${fmtHM(week)} Std. geplant bei ${fmtHM(p.weekly_target_minutes)} Wochenstunden.`);
    }
  }
  return out;
}
