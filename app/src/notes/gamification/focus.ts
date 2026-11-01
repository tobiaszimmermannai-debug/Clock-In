// Tagesfokus ("Tagesaufgaben"): pro Person und Tag bis zu drei angepinnte Aufgaben (Rang 1–3)
// Gespeichert an der Aufgabe selbst (props.__focus = { <Person>: "<Tag>:<Rang>" }); alte Tage verfallen von allein.
// Selbst eingetragene Aufgaben von Mitarbeitern warten auf Freigabe der Leitung: "<Tag>:<Rang>:?"
// (die Datenbank erzwingt das, siehe note_pages_focus_guard).
import type { PageMeta, PropValue } from "../types";

export const FOCUS_KEY = "__focus";
export const MAX_FOCUS = 3;

type FocusMap = Record<string, string>;

const mapOf = (props: Record<string, PropValue>): FocusMap => {
  const raw = props[FOCUS_KEY] as unknown;
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as FocusMap) : {};
};

export type FocusEntry = { rank: number; pending: boolean };

/** Eintrag einer Person für einen Tag (null = nicht angepinnt) */
export function focusEntry(row: PageMeta, userId: string, day: string): FocusEntry | null {
  const v = mapOf(row.props)[userId];
  if (typeof v !== "string") return null;
  const [d, r, flag] = v.split(":");
  const rank = Number(r);
  return d === day && rank >= 1 ? { rank, pending: flag === "?" } : null;
}

export function focusRank(row: PageMeta, userId: string, day: string): number | null {
  return focusEntry(row, userId, day)?.rank ?? null;
}

export function withFocus(
  props: Record<string, PropValue>,
  userId: string,
  day: string,
  rank: number | null,
  pending = false,
): Record<string, PropValue> {
  const next: FocusMap = { ...mapOf(props) };
  if (rank === null) delete next[userId];
  else next[userId] = `${day}:${rank}${pending ? ":?" : ""}`;
  return { ...props, [FOCUS_KEY]: next as unknown as PropValue };
}

/** Fokus-Aufgaben einer Person für einen Tag, nach Rang */
export function focusTasks(rows: PageMeta[], userId: string, day: string): { row: PageMeta; rank: number; pending: boolean }[] {
  return rows
    .map((row) => ({ row, entry: focusEntry(row, userId, day) }))
    .filter((x): x is { row: PageMeta; entry: FocusEntry } => x.entry !== null)
    .map(({ row, entry }) => ({ row, ...entry }))
    .sort((a, b) => a.rank - b.rank)
    .slice(0, MAX_FOCUS);
}

/**
 * Neue Reihenfolge, wenn eine Aufgabe auf Rang `rank` gesetzt (oder mit null entfernt) wird.
 * Liefert die Ränge aller betroffenen Aufgaben (null = nicht mehr im Fokus).
 */
export function reorderFocus(current: { id: string; rank: number }[], id: string, rank: number | null): Map<string, number | null> {
  const order = current.filter((x) => x.id !== id).sort((a, b) => a.rank - b.rank).map((x) => x.id);
  if (rank !== null) order.splice(Math.max(0, Math.min(rank - 1, order.length)), 0, id);
  const out = new Map<string, number | null>();
  order.forEach((x, i) => out.set(x, i < MAX_FOCUS ? i + 1 : null));
  if (rank === null) out.set(id, null);
  // Nur geänderte zurückgeben
  for (const x of current) if (out.get(x.id) === x.rank) out.delete(x.id);
  return out;
}
