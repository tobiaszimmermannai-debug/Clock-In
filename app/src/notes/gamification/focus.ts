// Tagesfokus: pro Person und Tag bis zu drei angepinnte Aufgaben (Rang 1–3)
// Gespeichert an der Aufgabe selbst (props.__focus = { <Person>: "<Tag>:<Rang>" }); alte Tage verfallen von allein.
import type { PageMeta, PropValue } from "../types";

export const FOCUS_KEY = "__focus";
export const MAX_FOCUS = 3;

type FocusMap = Record<string, string>;

const mapOf = (props: Record<string, PropValue>): FocusMap => {
  const raw = props[FOCUS_KEY] as unknown;
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as FocusMap) : {};
};

export function focusRank(row: PageMeta, userId: string, day: string): number | null {
  const v = mapOf(row.props)[userId];
  if (!v) return null;
  const [d, r] = v.split(":");
  return d === day ? Number(r) || null : null;
}

export function withFocus(props: Record<string, PropValue>, userId: string, day: string, rank: number | null): Record<string, PropValue> {
  const next: FocusMap = { ...mapOf(props) };
  if (rank === null) delete next[userId];
  else next[userId] = `${day}:${rank}`;
  return { ...props, [FOCUS_KEY]: next as unknown as PropValue };
}

/** Fokus-Aufgaben einer Person für einen Tag, nach Rang */
export function focusTasks(rows: PageMeta[], userId: string, day: string): { row: PageMeta; rank: number }[] {
  return rows
    .map((row) => ({ row, rank: focusRank(row, userId, day) }))
    .filter((x): x is { row: PageMeta; rank: number } => x.rank !== null)
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
