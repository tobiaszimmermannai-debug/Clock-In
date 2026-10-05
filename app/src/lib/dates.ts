// Kalenderrechnung in Berliner Zeit (unabhängig von der Zeitzone des Geräts)
const TZ = "Europe/Berlin";

const ymdFmt = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" });
const hmFmt = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const partsFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: TZ,
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});
const dayFmt = new Intl.DateTimeFormat("de-DE", { timeZone: "UTC", weekday: "short", day: "2-digit", month: "2-digit" });
const longDayFmt = new Intl.DateTimeFormat("de-DE", { timeZone: "UTC", weekday: "long", day: "numeric", month: "long" });

/** "YYYY-MM-DD" des Berliner Kalendertags */
export const berlinDate = (d: Date | string = new Date()) => ymdFmt.format(new Date(d));
/** "HH:MM" in Berliner Zeit */
export const berlinTime = (d: Date | string) => hmFmt.format(new Date(d));

// Abstand Berlin ↔ UTC in Minuten zu einem Zeitpunkt (Sommerzeit +120, Winterzeit +60)
function offsetMinutes(date: Date): number {
  const p = Object.fromEntries(partsFmt.formatToParts(date).map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return Math.round((asUtc - date.getTime()) / 60_000);
}

/** Berliner Datum + Uhrzeit → ISO-Zeitpunkt (UTC) */
export function berlinToISO(date: string, time = "00:00"): string {
  const [y, m, d] = date.split("-").map(Number);
  const [hh, mm] = time.split(":").map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  let ts = guess - offsetMinutes(new Date(guess)) * 60_000;
  const corrected = guess - offsetMinutes(new Date(ts)) * 60_000; // Umstellungstag
  if (corrected !== ts) ts = corrected;
  return new Date(ts).toISOString();
}

export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** Montag der Woche */
export function weekStart(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  const weekday = (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7; // Mo = 0
  return addDays(date, -weekday);
}

export const monthStart = (date: string) => `${date.slice(0, 7)}-01`;

export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

export const fmtDay = (date: string) => dayFmt.format(new Date(`${date}T12:00:00Z`));
export const fmtLongDay = (date: string) => longDayFmt.format(new Date(`${date}T12:00:00Z`));

/** Minuten → "6:30" */
export function fmtHM(minutes: number): string {
  const sign = minutes < 0 ? "−" : "";
  const abs = Math.abs(Math.round(minutes));
  return `${sign}${Math.floor(abs / 60)}:${String(abs % 60).padStart(2, "0")}`;
}

/** Minuten → "6,5 Std." */
export const fmtHours = (minutes: number) =>
  `${(minutes / 60).toLocaleString("de-DE", { maximumFractionDigits: 2 })} Std.`;

/** ISO-Kalenderwoche */
export function isoWeek(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  t.setUTCDate(t.getUTCDate() + 3 - ((t.getUTCDay() + 6) % 7));
  const firstThursday = new Date(Date.UTC(t.getUTCFullYear(), 0, 4));
  return 1 + Math.round(((t.getTime() - firstThursday.getTime()) / 86_400_000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
}

const WEEKDAYS = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"];
const MONTHS = ["Jan.", "Feb.", "März", "Apr.", "Mai", "Juni", "Juli", "Aug.", "Sept.", "Okt.", "Nov.", "Dez."];

/** "Mo" … "So" */
export function weekdayShort(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  return WEEKDAYS[(new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7];
}

export const dayOfMonth = (date: string) => Number(date.slice(8, 10));

/** "5.–11. Okt." bzw. "29. Sept. – 5. Okt." */
export function weekRangeLabel(start: string): string {
  const end = addDays(start, 6);
  const month = (date: string) => MONTHS[Number(date.slice(5, 7)) - 1];
  return start.slice(5, 7) === end.slice(5, 7)
    ? `${dayOfMonth(start)}.–${dayOfMonth(end)}. ${month(end)}`
    : `${dayOfMonth(start)}. ${month(start)} – ${dayOfMonth(end)}. ${month(end)}`;
}
