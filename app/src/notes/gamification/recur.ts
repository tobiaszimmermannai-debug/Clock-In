// Wiederkehrende Aufgaben und Fotonachweis (ohne UI – gut testbar)
// * Einzelaufgaben: props.__repeat = "daily" | "weekly" | "monthly" → beim Abhaken entsteht die nächste
//   (gleiche Serie, nächstes Fälligkeitsdatum). Feste IDs aus Serie + Datum: kein Doppel bei mehreren Geräten.
// * Teamaufgaben (Wochen & Monat): props.__repeat = "period" → jede neue Woche / jeder neue Monat eine Kopie.
// * Fotonachweis: props.__photo (nur Leitung setzt) oder automatisch ab PHOTO_AFTER_MOVES-mal verschoben
//   (props.__moves zählt jedes Verschieben der Fälligkeit nach hinten); Nachweis in props.__proof.
import type { DbSchema, PageMeta, PropValue } from "../types";
import { addDays } from "../util";
import { doneProps } from "./tasks";

export const REPEAT_KEY = "__repeat";
export const SERIES_KEY = "__series";
export const PHOTO_KEY = "__photo";
export const MOVES_KEY = "__moves";
export const PROOF_KEY = "__proof";
/** Ab so vielen Verschiebungen braucht die Aufgabe einen Fotonachweis */
export const PHOTO_AFTER_MOVES = 2;

export type Repeat = "daily" | "weekly" | "monthly" | "period";
export type Proof = { url: string; at: string; by: string };

export const REPEAT_LABELS: Record<Exclude<Repeat, "period">, string> = { daily: "täglich", weekly: "wöchentlich", monthly: "monatlich" };

export function repeatOf(row: PageMeta): Repeat | null {
  const v = row.props[REPEAT_KEY];
  return v === "daily" || v === "weekly" || v === "monthly" || v === "period" ? v : null;
}

export const seriesOf = (row: PageMeta) => (typeof row.props[SERIES_KEY] === "string" ? (row.props[SERIES_KEY] as string) : row.id);
export const movesOf = (row: PageMeta) => Math.max(0, Number(row.props[MOVES_KEY] ?? 0) || 0);
export const proofOf = (row: PageMeta): Proof | null => {
  const v = row.props[PROOF_KEY] as unknown;
  return v && typeof v === "object" && typeof (v as Proof).url === "string" ? (v as Proof) : null;
};

/** Braucht die Aufgabe einen Fotonachweis (von der Leitung verlangt oder zu oft verschoben)? */
export function needsPhoto(row: PageMeta): { required: boolean; reason: "lead" | "moved" | null } {
  if (row.props[PHOTO_KEY] === true) return { required: true, reason: "lead" };
  if (movesOf(row) >= PHOTO_AFTER_MOVES) return { required: true, reason: "moved" };
  return { required: false, reason: null };
}

/** Fälligkeits-Eigenschaft einer Aufgabenliste (erste Datums-Eigenschaft) */
export const dueProp = (schema: DbSchema) => schema.properties.find((p) => p.type === "date");

/** Wird die Fälligkeit nach hinten verschoben? Dann zählt das als Verschiebung. */
export function postponed(before: PropValue | undefined, after: PropValue | undefined): boolean {
  const a = typeof before === "string" ? before.slice(0, 10) : "";
  const b = typeof after === "string" ? after.slice(0, 10) : "";
  return Boolean(a && b && b > a);
}

/** Datum + 1 Monat (31.01. → 28./29.02.) */
export function addMonth(day: string, n = 1): string {
  const [y, m, d] = day.split("-").map(Number);
  const target = new Date(Date.UTC(y, m - 1 + n, 1));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  return `${target.getUTCFullYear()}-${String(target.getUTCMonth() + 1).padStart(2, "0")}-${String(Math.min(d, last)).padStart(2, "0")}`;
}

export function nextDue(due: string | null, repeat: Exclude<Repeat, "period">, today: string): string {
  // Ohne Datum oder längst vorbei: ab heute rechnen
  const base = due && due.slice(0, 10) >= addDays(today, -31) ? due.slice(0, 10) : today;
  let next = repeat === "daily" ? addDays(base, 1) : repeat === "weekly" ? addDays(base, 7) : addMonth(base);
  while (next <= today && repeat === "daily") next = addDays(next, 1);
  return next;
}

/** Feste, gleich aussehende ID (UUID-Form) aus Teilen – dieselben Teile ergeben überall dieselbe ID */
export function stableId(...parts: string[]): string {
  const text = parts.join("|");
  const hex: string[] = [];
  for (let seed = 0; seed < 4; seed++) {
    let h = 0x811c9dc5 ^ (seed * 0x9e3779b1);
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    hex.push(h.toString(16).padStart(8, "0"));
  }
  const s = hex.join("");
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-4${s.slice(13, 16)}-${"89ab"[parseInt(s[16], 16) % 4]}${s.slice(17, 20)}-${s.slice(20, 32)}`;
}

/** Eigenschaften der nächsten Aufgabe einer Serie: offen, ohne Fokus/Nachweis/Zähler */
export function freshProps(row: PageMeta, schema: DbSchema, extra: Record<string, PropValue>): Record<string, PropValue> {
  const reset = doneProps(row, schema, false) ?? { ...row.props };
  const next: Record<string, PropValue> = { ...reset, ...extra, [SERIES_KEY]: seriesOf(row) };
  for (const key of ["__focus", "__doneAt", PROOF_KEY, MOVES_KEY]) delete next[key];
  return next;
}

/** Nächste Einzelaufgabe einer Serie (beim Abhaken) */
export function nextOccurrence(row: PageMeta, schema: DbSchema, today: string) {
  const repeat = repeatOf(row);
  if (!repeat || repeat === "period") return null;
  const prop = dueProp(schema);
  const due = prop && typeof row.props[prop.id] === "string" ? (row.props[prop.id] as string) : null;
  const next = nextDue(due, repeat, today);
  return {
    id: stableId(seriesOf(row), next),
    title: row.title,
    icon: row.icon,
    props: freshProps(row, schema, prop ? { [prop.id]: next } : {}),
  };
}
