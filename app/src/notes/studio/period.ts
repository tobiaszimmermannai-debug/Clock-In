// Zeiträume für Wochen- und Monatsaufgaben: "2026-W45" bzw. "2026-11"
import { addDays, isoDay, MONTHS, pad } from "../util";

export type Rhythm = "week" | "month";

/** ISO-Kalenderwoche (Montag–Sonntag) */
export function isoWeek(day: string): { year: number; week: number } {
  const [y, m, d] = day.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  const wd = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - wd);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  return { year: date.getUTCFullYear(), week: Math.ceil(((date.getTime() - yearStart.getTime()) / 864e5 + 1) / 7) };
}

export function periodOf(rhythm: Rhythm, day: string): string {
  if (rhythm === "month") return day.slice(0, 7);
  const { year, week } = isoWeek(day);
  return `${year}-W${pad(week)}`;
}

/** Erster und letzter Tag eines Zeitraums */
export function periodRange(period: string): { start: string; end: string } {
  const w = period.match(/^(\d{4})-W(\d{2})$/);
  if (w) {
    // Montag der ISO-Woche: Woche 1 enthält den 4. Januar
    const jan4 = isoDay(new Date(Number(w[1]), 0, 4));
    const wd = (new Date(Number(w[1]), 0, 4).getDay() + 6) % 7;
    const start = addDays(addDays(jan4, -wd), (Number(w[2]) - 1) * 7);
    return { start, end: addDays(start, 6) };
  }
  const [y, m] = period.split("-").map(Number);
  return { start: `${y}-${pad(m)}-01`, end: isoDay(new Date(y, m, 0)) };
}

export function shiftPeriod(period: string, by: number): string {
  if (/W/.test(period)) return periodOf("week", addDays(periodRange(period).start, 7 * by));
  const [y, m] = period.split("-").map(Number);
  return isoDay(new Date(y, m - 1 + by, 1)).slice(0, 7);
}

export function periodLabel(period: string): string {
  const w = period.match(/^(\d{4})-W(\d{2})$/);
  if (w) {
    const { start, end } = periodRange(period);
    const s = start.split("-").map(Number);
    const e = end.split("-").map(Number);
    return `KW ${Number(w[2])} · ${s[2]}.${s[1] === e[1] ? "" : `${s[1]}.`}–${e[2]}.${e[1]}.`;
  }
  const [y, m] = period.split("-").map(Number);
  return `${MONTHS[m - 1]} ${y}`;
}
