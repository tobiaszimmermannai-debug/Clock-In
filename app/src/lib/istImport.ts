// Schul-Abgleich: kopierten Text der IST-Bildungspartner-Seite „Termine“ lesen und mit dem Dienstplan abgleichen.
// Format je Termin (wie auf der Seite): „TT.MM.JJ HH:MM Uhr - TT.MM.JJ HH:MM Uhr <Name> <Titel>“, mehrtägig auch
// ohne Uhrzeit („07.11.26 - 08.11.26“). „Abgesagt“ vor dem Termin bzw. in derselben Zeile = storniert.
// Termine nur mit Monat („März 27“) haben noch kein Datum und werden ignoriert.
import { addDays, berlinDate, berlinToISO } from "./dates";

export type IstPerson = { id: string; first_name: string; last_name: string };
export type IstRecord = {
  from: string; // YYYY-MM-DD
  to: string;
  startTime?: string; // HH:MM
  endTime?: string;
  userId: string | null; // null = Name nicht erkannt
  label: string; // erkannter Name bzw. Textanfang (zur Anzeige)
  title: string;
  cancelled: boolean;
};
export type IstParse = { records: IstRecord[]; monthOnly: number };

// Datum (+ Uhrzeit) [- Datum (+ Uhrzeit) | - Uhrzeit]
const D = String.raw`(\d{1,2})\.(\d{1,2})\.(\d{2,4})`;
const T = String.raw`(?:,?\s*(\d{1,2})[:.](\d{2})\s*(?:Uhr)?)?`;
const RANGE = new RegExp(`${D}${T}(?:\\s*[-–]\\s*(?:${D}${T}|(\\d{1,2})[:.](\\d{2})\\s*(?:Uhr)?))?`, "g");
const MONTH_ONLY = /^\s*(jan|feb|m(ä|ae)r|apr|mai|jun|jul|aug|sep|okt|nov|dez)[a-zä]*\.?\s+\d{2,4}\b/i;
const CANCELLED = /\babgesagt\b/i;

const pad = (n: string | number) => String(n).padStart(2, "0");
const year = (y: string) => (y.length === 2 ? `20${y}` : y);
const iso = (d: string, m: string, y: string) => `${year(y)}-${pad(m)}-${pad(d)}`;
const time = (h?: string, m?: string) => (h && m ? `${pad(h)}:${m}` : undefined);

// Kleinbuchstaben ohne Akzente (Konaté → konate, ß → ss) – mit Rückverweis auf die Original-Position
function normalize(text: string): { norm: string; at: number[] } {
  let norm = "";
  const at: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i].toLowerCase() === "ß" ? "ss" : text[i].toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    for (const ch of c) {
      norm += ch;
      at.push(i);
    }
  }
  at.push(text.length);
  return { norm, at };
}
const norm = (s: string) => normalize(s).norm.replace(/\s+/g, " ").trim();

/** Ersten bekannten Namen im Text finden: voller Name, sonst eindeutiger Nachname */
function findPerson(text: string, people: IstPerson[]): { person: IstPerson; start: number; end: number } | null {
  const { norm: n, at } = normalize(text);
  const lastCount = new Map<string, number>();
  for (const p of people) lastCount.set(norm(p.last_name), (lastCount.get(norm(p.last_name)) ?? 0) + 1);
  let best: { person: IstPerson; start: number; end: number } | null = null;
  const consider = (person: IstPerson, needle: string) => {
    if (!needle) return;
    const re = new RegExp(`(^|[^a-z])${needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "\\s+")}(?=$|[^a-z])`);
    const m = re.exec(n);
    if (!m) return;
    const start = m.index + m[1].length;
    const end = m.index + m[0].length;
    if (!best || start < best.start || (start === best.start && end > best.end)) best = { person, start: at[start], end: at[end] };
  };
  for (const p of people) {
    const first = norm(p.first_name);
    const last = norm(p.last_name);
    consider(p, `${first} ${last}`);
    if (lastCount.get(last) === 1 && last.length >= 3) consider(p, last);
  }
  return best;
}

/** Kopierten Text der IST-Termine-Seite in Termine zerlegen */
export function parseIst(text: string, people: IstPerson[]): IstParse {
  // Zeilen; mehrere Termine in einer Zeile werden vor jedem Datum getrennt
  const lines: string[] = [];
  for (const raw of text.replace(/\r/g, "").split("\n")) {
    const starts = [...raw.matchAll(RANGE)].map((m) => m.index ?? 0);
    if (starts.length <= 1) lines.push(raw);
    else starts.forEach((s, i) => lines.push(raw.slice(i === 0 ? 0 : s, starts[i + 1] ?? raw.length)));
  }

  const records: IstRecord[] = [];
  let monthOnly = 0;
  let pendingCancel = false;
  let current: { rec: IstRecord; rest: string[] } | null = null;
  const finish = () => {
    if (!current) return;
    const { rec, rest } = current;
    const content = rest.join("\n");
    const hit = findPerson(content, people);
    const afterName = hit ? content.slice(hit.end) : content;
    // Titel: Rest der Zeile nach dem Namen, sonst die nächste Zeile mit Text
    const titleLines = afterName.split("\n").map((l) => l.replace(CANCELLED, "").replace(/^[\s\t:\-–|]+|[\s\t|]+$/g, ""));
    rec.title = (titleLines.find((l) => l.length > 0) ?? "").replace(/\s+/g, " ");
    rec.userId = hit?.person.id ?? null;
    rec.label = hit ? `${hit.person.first_name} ${hit.person.last_name}` : content.split("\n").find((l) => l.trim())?.trim().slice(0, 60) ?? "?";
    records.push(rec);
    current = null;
  };

  for (const line of lines) {
    RANGE.lastIndex = 0;
    const m = RANGE.exec(line);
    if (!m) {
      if (MONTH_ONLY.test(line)) {
        finish();
        monthOnly++;
      } else if (CANCELLED.test(line) && line.replace(CANCELLED, "").trim() === "") {
        finish();
        pendingCancel = true; // eigene Zeile „Abgesagt“ gehört zum nächsten Termin
      } else if (current) {
        current.rest.push(line);
      }
      continue;
    }
    finish();
    const [, d1, mo1, y1, h1, mi1, d2, mo2, y2, h2, mi2, hOnly, miOnly] = m;
    const from = iso(d1, mo1, y1);
    const to = d2 ? iso(d2, mo2, y2) : from;
    current = {
      rec: {
        from: to < from ? to : from,
        to: to < from ? from : to,
        startTime: time(h1, mi1),
        endTime: time(h2, mi2) ?? time(hOnly, miOnly),
        userId: null,
        label: "",
        title: "",
        cancelled: pendingCancel || CANCELLED.test(line),
      },
      rest: [line.slice((m.index ?? 0) + m[0].length)],
    };
    pendingCancel = false;
  }
  finish();
  return { records, monthOnly };
}

// ---------------------------------------------------------------------------------------------
// Abgleich mit dem Dienstplan
// ---------------------------------------------------------------------------------------------
export const IST_SOURCE = "ist";
export const IST_NOTE_PREFIX = "IST: ";
const DEFAULT_TIMES = { from: "08:00", to: "16:00" };
const MAX_DAYS = 31;

export type SchoolDay = { userId: string; date: string; from: string; to: string; title: string };
export type DayEntry = {
  id: string;
  user_id: string;
  shift_type: string;
  starts_at: string;
  ends_at: string;
  note: string | null;
  import_source?: string | null;
};
export type SyncPlan = {
  add: SchoolDay[];
  update: { entry: DayEntry; day: SchoolDay }[];
  remove: DayEntry[];
  unchanged: number;
  conflicts: { day: SchoolDay; entry: DayEntry }[]; // geplante Schicht überschneidet sich → nicht eingetragen
  absent: { day: SchoolDay; entry: DayEntry }[]; // Urlaub/Krank/Schule (von Hand) an dem Tag → nicht eingetragen
};

/** Termine → einzelne Schultage (nur erkannte, nicht abgesagte) */
export function schoolDays(records: IstRecord[]): SchoolDay[] {
  const out = new Map<string, SchoolDay>();
  for (const r of records) {
    if (!r.userId || r.cancelled) continue;
    const timed = r.startTime && r.endTime && r.startTime < r.endTime;
    let d = r.from;
    for (let i = 0; d <= r.to && i < MAX_DAYS; i++, d = addDays(d, 1)) {
      out.set(`${r.userId}|${d}`, {
        userId: r.userId,
        date: d,
        from: timed ? r.startTime! : DEFAULT_TIMES.from,
        to: timed ? r.endTime! : DEFAULT_TIMES.to,
        title: r.title,
      });
    }
  }
  return [...out.values()].sort((a, b) => a.date.localeCompare(b.date) || a.userId.localeCompare(b.userId));
}

const overlaps = (day: SchoolDay, e: DayEntry) =>
  Date.parse(berlinToISO(day.date, day.from)) < Date.parse(e.ends_at) && Date.parse(e.starts_at) < Date.parse(berlinToISO(day.date, day.to));

/**
 * Abgleich: existing = alle Einträge der Personen im Zeitraum. Gelöscht werden nur früher importierte
 * Schultage von Personen, die im eingefügten Text vorkommen, innerhalb des abgedeckten Zeitraums.
 */
export function planSync(days: SchoolDay[], existing: DayEntry[], scope: { users: Set<string>; from: string; to: string }): SyncPlan {
  const plan: SyncPlan = { add: [], update: [], remove: [], unchanged: 0, conflicts: [], absent: [] };
  const wanted = new Set(days.map((d) => `${d.userId}|${d.date}`));
  const imported = new Map<string, DayEntry>();
  for (const e of existing) {
    if (e.import_source === IST_SOURCE && e.shift_type === "vocational_school") imported.set(`${e.user_id}|${berlinDate(e.starts_at)}`, e);
  }

  for (const day of days) {
    const mine = imported.get(`${day.userId}|${day.date}`);
    if (mine) {
      const same = berlinToISO(day.date, day.from) === new Date(mine.starts_at).toISOString()
        && berlinToISO(day.date, day.to) === new Date(mine.ends_at).toISOString()
        && (mine.note ?? "") === IST_NOTE_PREFIX + day.title;
      if (same) plan.unchanged++;
      else plan.update.push({ entry: mine, day });
      continue;
    }
    const sameDay = existing.filter((e) => e.user_id === day.userId && berlinDate(e.starts_at) === day.date && e.import_source !== IST_SOURCE);
    const absence = sameDay.find((e) => e.shift_type !== "work");
    if (absence) {
      plan.absent.push({ day, entry: absence });
      continue;
    }
    const clash = sameDay.find((e) => e.shift_type === "work" && overlaps(day, e));
    if (clash) plan.conflicts.push({ day, entry: clash });
    else plan.add.push(day);
  }

  for (const [key, e] of imported) {
    const date = key.split("|")[1];
    if (!wanted.has(key) && scope.users.has(e.user_id) && date >= scope.from && date <= scope.to) plan.remove.push(e);
  }
  return plan;
}

/** Zeitraum und Personen, die der eingefügte Text abdeckt */
export function coverage(records: IstRecord[]): { users: Set<string>; from: string; to: string } | null {
  if (records.length === 0) return null;
  return {
    users: new Set(records.flatMap((r) => (r.userId ? [r.userId] : []))),
    from: records.reduce((m, r) => (r.from < m ? r.from : m), records[0].from),
    to: records.reduce((m, r) => (r.to > m ? r.to : m), records[0].to),
  };
}
