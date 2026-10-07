// Feste Farbe je Studio – überall gleich: Kalender, Dienstplan, Mitarbeiter-Kreise, Studio-Auswahl
import type { Location } from "./types";

// Dunkle Töne, damit weiße Schrift gut lesbar bleibt
const COLORS: Record<string, string> = {
  KRAILLING: "#c2410c", // Orange
  GERMERING: "#15803d", // Grün
  STARNBERG: "#1d4ed8", // Blau
  MOOSACH: "#7e22ce",   // Lila
};
const FALLBACK = ["#0e7490", "#be123c", "#4d7c0f", "#a16207"];
export const NO_STUDIO_COLOR = "#64748b";

const byId = new Map<string, string>();

/** Studios bekannt machen (nach dem Laden), damit Farben auch über die ID gefunden werden */
export function registerStudios(locations: Location[]) {
  for (const l of locations) {
    let hash = 0;
    for (const ch of l.code) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
    byId.set(l.id, COLORS[l.code] ?? FALLBACK[hash % FALLBACK.length]);
  }
}

export function studioColor(locationId: string | null | undefined): string {
  return (locationId && byId.get(locationId)) || NO_STUDIO_COLOR;
}

/** "Fürstenfeldbruck" → "FUERSTENFE" (Kürzel: 2–10 Großbuchstaben) */
export function studioCode(name: string): string {
  return name
    .toUpperCase()
    .replace(/Ä/g, "AE").replace(/Ö/g, "OE").replace(/Ü/g, "UE").replace(/ß/g, "SS")
    .replace(/[^A-Z]/g, "")
    .slice(0, 10);
}
