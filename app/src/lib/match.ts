// Gesichtsabgleich: kleinste euklidische Distanz zu den gespeicherten Embeddings
import type { RosterEntry } from "./types";

// face-api: < 0.6 gilt als gleiche Person; wir sind strenger
export const MATCH_THRESHOLD = 0.5;
// Abstand zum zweitbesten Kandidaten, sonst gilt der Treffer als unsicher
export const AMBIGUITY_MARGIN = 0.06;

export function euclidean(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    sum += d * d;
  }
  return Math.sqrt(sum);
}

export type Match = { entry: RosterEntry; distance: number };

// Beste Distanz pro Person, aufsteigend sortiert
export function rankCandidates(descriptor: ArrayLike<number>, roster: RosterEntry[]): Match[] {
  return roster
    .filter((entry) => entry.descriptors.length > 0)
    .map((entry) => ({
      entry,
      distance: Math.min(...entry.descriptors.map((d) => euclidean(descriptor, d))),
    }))
    .sort((a, b) => a.distance - b.distance);
}

export function identify(descriptor: ArrayLike<number>, roster: RosterEntry[]): Match | null {
  const [best, second] = rankCandidates(descriptor, roster);
  if (!best || best.distance >= MATCH_THRESHOLD) return null;
  if (second && second.distance - best.distance < AMBIGUITY_MARGIN) return null;
  return best;
}
