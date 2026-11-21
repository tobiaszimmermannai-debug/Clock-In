// Gesetzliche Feiertage in Bayern (alle Studios: Krailling, Germering, Starnberg, München – Mariä Himmelfahrt gilt dort).
// Gleiche Regel wie in der Datenbank (public.holiday_name) und im Monatsbericht (Telegram-Funktion).
import { addDays } from "./dates";

/** Ostersonntag (gregorianisch, Gauß/Meeus) als YYYY-MM-DD */
export function easter(year: number): string {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

const cache = new Map<number, Map<string, string>>();
function holidaysOf(year: number): Map<string, string> {
  const hit = cache.get(year);
  if (hit) return hit;
  const e = easter(year);
  const y = (md: string) => `${year}-${md}`;
  const map = new Map<string, string>([
    [y("01-01"), "Neujahr"],
    [y("01-06"), "Heilige Drei Könige"],
    [addDays(e, -2), "Karfreitag"],
    [addDays(e, 1), "Ostermontag"],
    [y("05-01"), "Tag der Arbeit"],
    [addDays(e, 39), "Christi Himmelfahrt"],
    [addDays(e, 50), "Pfingstmontag"],
    [addDays(e, 60), "Fronleichnam"],
    [y("08-15"), "Mariä Himmelfahrt"],
    [y("10-03"), "Tag der Deutschen Einheit"],
    [y("11-01"), "Allerheiligen"],
    [y("12-25"), "1. Weihnachtstag"],
    [y("12-26"), "2. Weihnachtstag"],
  ]);
  cache.set(year, map);
  return map;
}

/** Name des Feiertags oder null (Tag als YYYY-MM-DD) */
export const holidayName = (day: string): string | null => holidaysOf(Number(day.slice(0, 4))).get(day) ?? null;

/** Mo–Fr und kein Feiertag → zählt fürs Soll (Wochenstunden ÷ 5) */
export function isWorkday(day: string): boolean {
  const dow = new Date(`${day}T12:00:00Z`).getUTCDay();
  return dow !== 0 && dow !== 6 && !holidayName(day);
}

/** Anzahl Soll-Tage im Zeitraum [from, to] (beide inklusive) */
export function workdaysBetween(from: string, to: string): number {
  let n = 0;
  for (let d = from; d <= to; d = addDays(d, 1)) if (isWorkday(d)) n++;
  return n;
}
