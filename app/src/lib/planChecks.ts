// Hinweise bei der Planung (kein Verbot): Ruhezeit, lange Tage, über den Wochenstunden
import { addDays, berlinDate, fmtDay, fmtHM } from "./dates";
import { requiredBreak } from "./dayEdit";

export type CheckShift = { user_id: string; shift_type: string; starts_at: string; ends_at: string };
export type CheckPerson = { id: string; first_name: string; last_name: string; weekly_target_minutes?: number | null };

/** Mindest-Ruhezeit zwischen zwei Arbeitstagen (§ 5 ArbZG) */
export const MIN_REST_MINUTES = 11 * 60;
/** Höchstens so viel geplante Arbeitszeit an einem Tag (§ 3 ArbZG) */
export const MAX_DAY_MINUTES = 10 * 60;

const minutes = (s: CheckShift) => Math.round((Date.parse(s.ends_at) - Date.parse(s.starts_at)) / 60_000);

/**
 * Hinweise für die übergebenen Personen aus den Arbeitsschichten einer Woche (Mo–So ab weekStart).
 * Arbeitszeit immer netto: je Tag die gesetzliche Pause abgezogen (wie beim Stempeln).
 */
export function planWarnings(shifts: CheckShift[], people: CheckPerson[], weekStart?: string): string[] {
  const out: string[] = [];
  const inWeek = (s: CheckShift) => !weekStart || (berlinDate(s.starts_at) >= weekStart && berlinDate(s.starts_at) < addDays(weekStart, 7));
  for (const p of people) {
    const work = shifts.filter((s) => s.user_id === p.id && s.shift_type === "work" && inWeek(s)).sort((a, b) => a.starts_at.localeCompare(b.starts_at));
    if (!work.length) continue;
    const name = `${p.first_name} ${p.last_name}`;
    const byDay = new Map<string, CheckShift[]>();
    for (const s of work) byDay.set(berlinDate(s.starts_at), [...(byDay.get(berlinDate(s.starts_at)) ?? []), s]);
    const days = [...byDay.keys()].sort();
    // netto je Tag: Anwesenheit minus Pflichtpause (bis 6 Std. 0, ab 6 Std. 30 Min., ab 9 Std. 45 Min.)
    const net = new Map<string, number>();
    for (const d of days) {
      const gross = byDay.get(d)!.reduce((n, s) => n + minutes(s), 0);
      net.set(d, gross - requiredBreak(gross));
    }
    for (const d of days) {
      const total = net.get(d)!;
      if (total > MAX_DAY_MINUTES) out.push(`${name}: ${fmtDay(d)} ${fmtHM(total)} Std. Arbeitszeit geplant (mehr als 10 Std., ohne Pausen).`);
    }
    for (let i = 1; i < days.length; i++) {
      const prev = byDay.get(days[i - 1])!;
      const next = byDay.get(days[i])!;
      const rest = Math.round((Date.parse(next[0].starts_at) - Math.max(...prev.map((s) => Date.parse(s.ends_at)))) / 60_000);
      if (rest < MIN_REST_MINUTES) out.push(`${name}: nur ${fmtHM(rest)} Std. Ruhezeit vor ${fmtDay(days[i])} (mindestens 11 Std.).`);
    }
    const week = [...net.values()].reduce((n, m) => n + m, 0);
    if (p.weekly_target_minutes && week > p.weekly_target_minutes) {
      out.push(`${name}: ${fmtHM(week)} Std. geplant (Mo–So, ohne Pausen) bei ${fmtHM(p.weekly_target_minutes)} Wochenstunden.`);
    }
  }
  return out;
}
