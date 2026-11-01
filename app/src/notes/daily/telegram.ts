// Telegram-Texte und Zeitlogik für die Aufgaben-Benachrichtigungen (ohne Netzwerk – gut testbar).
// Benutzt von supabase/functions/aufgaben (Server). Texte bauen immer auf dailyStatus auf.
import { displayValue } from "../database/logic";
import type { Member, PageMeta } from "../types";
import type { DayStatus, FocusItem, PersonDay } from "./status";

// ---------------- Zeit (Berlin) ----------------

export type BerlinNow = { day: string; hour: number; weekday: number /* 1 = Mo … 7 = So */ };

const WEEKDAY_INDEX: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

/** Berliner Kalendertag, Stunde (0–23) und Wochentag – unabhängig von der Server-Zeitzone (UTC) */
export function berlinNow(date = new Date()): BerlinNow {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Berlin",
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    weekday: "short",
  }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "";
  const hour = Number(get("hour"));
  const weekday = WEEKDAY_INDEX[get("weekday")];
  if (!Number.isInteger(hour) || hour < 0 || hour > 23 || !weekday) throw new Error(`Berliner Zeit nicht lesbar: ${JSON.stringify(parts)}`);
  return { day: `${get("year")}-${get("month")}-${get("day")}`, hour, weekday };
}

export type ReminderKind = "frueh" | "mittag" | "abend";
export type ReminderHours = Record<ReminderKind, number>;

export function parseHours(env: (key: string) => string | undefined): ReminderHours {
  const read = (key: string, fallback: number) => {
    const n = Number(env(key) ?? fallback);
    return Number.isInteger(n) && n >= 0 && n <= 23 ? n : fallback;
  };
  return { frueh: read("AUFGABEN_STUNDE_FRUEH", 6), mittag: read("AUFGABEN_STUNDE_MITTAG", 14), abend: read("AUFGABEN_STUNDE_ABEND", 20) };
}

/** Welcher Reminder ist jetzt dran? Nur Montag–Freitag zur jeweiligen Berliner Stunde. */
export function dueReminder(now: BerlinNow, hours: ReminderHours): ReminderKind | null {
  if (now.weekday > 5) return null;
  return (Object.keys(hours) as ReminderKind[]).find((k) => hours[k] === now.hour) ?? null;
}

// ---------------- Empfänger ----------------

export type Recipient = { id: number; kz: string; name: string };

/** AUFGABEN_EMPFAENGER: [{"id":123456789,"kz":"TZ","name":"Tobias"}, …] */
export function parseRecipients(raw: string | undefined): { recipients: Recipient[]; errors: string[] } {
  if (!raw?.trim()) return { recipients: [], errors: ["AUFGABEN_EMPFAENGER ist leer"] };
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return { recipients: [], errors: ["AUFGABEN_EMPFAENGER ist kein gültiges JSON"] };
  }
  if (!Array.isArray(data)) return { recipients: [], errors: ["AUFGABEN_EMPFAENGER muss eine Liste sein"] };
  const recipients: Recipient[] = [];
  const errors: string[] = [];
  data.forEach((r, i) => {
    const o = r as Partial<Recipient>;
    if (typeof o?.id === "number" && Number.isFinite(o.id) && typeof o.name === "string" && o.name.trim()) {
      recipients.push({ id: o.id, kz: String(o.kz ?? "").trim(), name: o.name.trim() });
    } else errors.push(`Eintrag ${i + 1} braucht id (Zahl) und name`);
  });
  return { recipients, errors };
}

/** Kürzel aus Vor- und Nachname: "Tobias Zimmermann" → "TZ" */
export const initialsOf = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase())
    .join("");

/**
 * Ist dieser Empfänger der Absender? Sicher über die Telegram-Verknüpfung aus ClockIn (chat_id);
 * sonst nur, wenn Vorname UND Kürzel passen – kein Raten über den Vornamen allein.
 */
export function isSender(r: Recipient, sender: { chatIds: number[]; name: string }): boolean {
  if (sender.chatIds.includes(r.id)) return true;
  const first = sender.name.split(/\s+/)[0]?.toLowerCase() ?? "";
  return Boolean(r.kz) && r.kz.toUpperCase() === initialsOf(sender.name) && r.name.split(/\s+/)[0]!.toLowerCase() === first;
}

// ---------------- Texte ----------------

const WD = ["", "Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"];

export function dayLabel(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay() || 7;
  return `${WD[wd]} ${String(d).padStart(2, "0")}.${String(m).padStart(2, "0")}.`;
}

export const shorten = (text: string, max = 120) => {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
};

/** Link zu einer Aufgabe: AUFGABEN_APP_URL mit {id} oder als Basis (dann …#/p/<id>) */
export function entryLink(base: string | undefined, id: string): string | null {
  if (!base?.trim()) return null;
  const b = base.trim();
  return b.includes("{id}") ? b.replace("{id}", encodeURIComponent(id)) : `${b.replace(/\/+$/, "")}/#/p/${encodeURIComponent(id)}`;
}

/** Titel und die ersten Felder einer Aufgabe, gekürzt auf 120 Zeichen */
export function entrySummary(row: PageMeta, db: PageMeta | undefined, ctx: { pages: Map<string, PageMeta>; members: Member[] }): string {
  const parts = [row.title.trim() || "Ohne Titel"];
  for (const prop of db?.schema?.properties ?? []) {
    if (prop.type === "title" || prop.type === "created_by" || prop.type === "created_time" || prop.type === "last_edited_time") continue;
    const v = displayValue(row, prop, ctx);
    if (v) parts.push(`${prop.name}: ${v}`);
    if (parts.length >= 4) break;
  }
  return shorten(parts.join(" · "), 120);
}

export type Source = "App" | "Studio-PC" | "Telegram";

export function focusMessage(m: {
  pending: boolean;
  actor: string;
  target: string;
  source: Source;
  rank: number;
  summary: string;
  link: string | null;
}): string {
  const self = m.actor === m.target;
  const head = m.pending
    ? `🙋 Freigabe Tagesaufgabe\n${m.target} (${m.source}) möchte als Nr. ${m.rank}:`
    : `📌 Neue Tagesaufgabe\n${m.actor} (${m.source}) → ${self ? "für sich" : m.target}, Nr. ${m.rank}:`;
  return [head, m.summary, m.link].filter(Boolean).join("\n");
}

const first = (p: PersonDay) => p.member.name.split(" ")[0] || p.member.name;
const names = (list: PersonDay[]) => list.map((p) => p.member.name).join(", ");
const focusLine = (f: FocusItem) => `${f.done ? "✅" : `${f.rank})`} ${shorten(f.row.title.trim() || "Ohne Titel", 60)}${f.pending ? " ⏳" : ""}`;

/** Zeile mit den Abwesenden – entfällt, wenn niemand abwesend ist */
export const absentLine = (s: DayStatus) => (s.absent.length ? `Krank, Schule oder Urlaub: ${names(s.absent)}` : null);

export function reminderText(kind: ReminderKind, s: DayStatus, studioName: (id: string | null | undefined) => string): string {
  const title = { frueh: "☀️ Tagesaufgaben", mittag: "⏳ Zwischenstand", abend: "🌙 Tagesabschluss" }[kind];
  const lines: string[] = [`${title} · ${dayLabel(s.day)}`];

  if (kind === "frueh") {
    let studio: string | null = null;
    for (const p of s.people) {
      const st = studioName(p.member.studioId);
      if (st !== studio) {
        studio = st;
        lines.push("", st);
      }
      const what = p.absent ? "-" : p.focus.length ? p.focus.map(focusLine).join("  ") : "noch keine Tagesaufgabe";
      lines.push(`• ${first(p)}: ${what}`);
    }
    if (!s.people.length) lines.push("", "Heute ist niemand eingeplant.");
    lines.push("");
    if (s.dueToday || s.overdue) lines.push(`Fällig heute: ${s.dueToday}${s.overdue ? ` · überfällig: ${s.overdue}` : ""}`);
    if (s.pending.length) lines.push(`Warten auf Freigabe: ${s.pending.length}`);
  } else if (kind === "mittag") {
    lines.push("");
    const open = s.outstanding.filter((p) => p.state === "open");
    lines.push(open.length ? `Noch offen: ${open.map((p) => `${first(p)} (${p.done}/${p.focus.length})`).join(", ")}` : "Alle Tagesaufgaben erledigt 🎉");
    if (s.withoutFocus.length) lines.push(`Ohne Tagesaufgabe: ${s.withoutFocus.map(first).join(", ")}`);
    if (s.finished.length) lines.push(`Fertig: ${s.finished.map(first).join(", ")} ✅`);
    if (s.pending.length) lines.push(`Warten auf Freigabe: ${s.pending.length}`);
  } else {
    lines.push("");
    const open = s.outstanding.filter((p) => p.state === "open");
    if (open.length) {
      lines.push("Nicht erledigt:");
      for (const p of open) lines.push(`• ${first(p)}: ${p.focus.filter((f) => !f.done).map((f) => shorten(f.row.title || "Ohne Titel", 60)).join(", ")}`);
    } else lines.push("Alle Tagesaufgaben erledigt 🎉");
    if (s.withoutFocus.length) lines.push(`Ohne Tagesaufgabe: ${s.withoutFocus.map(first).join(", ")}`);
    if (s.finished.length) lines.push(`Alles erledigt: ${s.finished.map(first).join(", ")}`);
    if (s.overdue) lines.push(`Überfällige Aufgaben im Team: ${s.overdue}`);
  }
  const absent = absentLine(s);
  if (absent) lines.push(absent);
  return lines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
