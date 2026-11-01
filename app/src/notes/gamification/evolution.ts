// Blitzis Entwicklung: ohne Serie Stufe 1, jeder Tag der Serie schaltet die nächste Stufe frei (bis 30),
// danach gibt es je weiterem Tag eine Goldmünze.
// Stufe 1 = gemütlicher Couch-Blitzi, ~15 = sportlich-normal, 30 = Muskelpaket.

export const MAX_STAGE = 30;

export type BlitziKind = "m" | "w";

/** Stufe zur Serie: 0 Tage = Stufe 1, 1 Tag = Stufe 2 … ab 29 Tagen Stufe 30 */
export const stageOf = (streak: number) => Math.min(MAX_STAGE, Math.max(0, Math.floor(streak)) + 1);

/** Goldmünzen: jeder Serien-Tag nach Erreichen von Stufe 30 */
export const coinsOf = (streak: number) => Math.max(0, Math.floor(streak) - (MAX_STAGE - 1));

/** 0 (rund) … 1 (Muskelpaket) */
export const buffOf = (stage: number) => (Math.min(MAX_STAGE, Math.max(1, stage)) - 1) / (MAX_STAGE - 1);

const NAMES: [number, string, string][] = [
  [1, "Sofa-Blitzi", "Sofa-Blitzi"],
  [6, "Aufwärm-Blitzi", "Aufwärm-Blitzi"],
  [11, "Fit-Blitzi", "Fit-Blitzi"],
  [16, "Athlet", "Athletin"],
  [21, "Kraftpaket", "Kraftpaket"],
  [26, "Muskelmonster", "Muskelmonster"],
  [30, "Legende", "Legende"],
];

export function stageName(stage: number, kind?: BlitziKind | null): string {
  let name = NAMES[0];
  for (const n of NAMES) if (stage >= n[0]) name = n;
  return kind === "w" ? name[2] : name[1];
}

/** Was mit einer Stufe neu dazukommt (für die Übersicht) */
export const UNLOCKS: Record<number, string> = {
  5: "legt den Donut weg",
  10: "Schweißbänder",
  12: "EMS-Gurt",
  18: "Sixpack",
  23: "zeigt immer die Muskeln",
  26: "Adern",
  30: "goldener Gurt",
};
