// Blitzis Entwicklung: ohne Serie Stufe 1, jeder Tag der Serie schaltet die nächste Stufe frei (bis 30).
// Auf Stufe 30 wählt man ein Item (Prestige) – danach fängt Blitzi wieder bei Stufe 1 an, die Items bleiben.
// Stufe 1–3 klein und kugelrund, ab 8 schlank und sportlich, ab 20 Bodybuilder, 28–30 extreme Definition.

export const MAX_STAGE = 30;

/** Stufe zur Serie: 0 Tage = Stufe 1, 1 Tag = Stufe 2 … ab 29 Tagen Stufe 30 */
export const stageOf = (streak: number) => Math.min(MAX_STAGE, Math.max(0, Math.floor(streak)) + 1);

/** Höchstens so viele Prestige-Stufen (= Items im Katalog) */
export const MAX_PRESTIGE = 100;

const clampStage = (stage: number) => Math.min(MAX_STAGE, Math.max(1, stage));

/** Eckpunkte der Entwicklung (Stufen), dazwischen wird stufenlos übergeblendet */
export const ANCHORS = [1, 4, 8, 14, 20, 27, 30] as const;

/** Wert je Stufe aus den Werten an den Eckpunkten */
export function atStage(stage: number, values: readonly number[]): number {
  const s = clampStage(stage);
  for (let i = 1; i < ANCHORS.length; i++) {
    if (s <= ANCHORS[i]) {
      const a = ANCHORS[i - 1];
      const f = (s - a) / (ANCHORS[i] - a);
      return values[i - 1] + (values[i] - values[i - 1]) * f;
    }
  }
  return values[values.length - 1];
}

/** Ausprägung der Details 0 … max je Stufe */
export function detailOf(stage: number) {
  const s = clampStage(stage);
  return {
    /** 0 keine, 1 Arme, 2 + Unterarme/Brust, 3 + Beine, 4 überall */
    veins: s >= 30 ? 4 : s >= 29 ? 3 : s >= 28 ? 2 : s >= 23 ? 1 : 0,
    /** 0 keins, 1 angedeutet, 2 Sixpack, 3 tief, 4 Achtpack, 5 Achtpack + seitliche Bauchmuskeln */
    abs: s >= 30 ? 5 : s >= 29 ? 4 : s >= 28 ? 3 : s >= 17 ? 2 : s >= 12 ? 1 : 0,
    /** Brust: 0 keine Linien, 1 Kontur, 2 Faserung */
    pecs: s >= 28 ? 2 : s >= 14 ? 1 : 0,
    /** Oberschenkel: 0 glatt, 1 Kontur, 2 starke Trennung */
    quads: s >= 29 ? 2 : s >= 16 ? 1 : 0,
    /** Laten-Kontur */
    lats: s >= 28,
  };
}

const NAMES: [number, string][] = [
  [1, "Sofa-Blitzi"],
  [4, "Pummel-Blitzi"],
  [8, "Fit-Blitzi"],
  [14, "Athlet"],
  [20, "Bodybuilder"],
  [25, "Kraftpaket"],
  [28, "Muskelmonster"],
  [30, "Legende"],
];

export function stageName(stage: number): string {
  let name = NAMES[0][1];
  for (const [from, n] of NAMES) if (stage >= from) name = n;
  return name;
}

/** Was mit einer Stufe neu dazukommt (für die Übersicht) */
export const UNLOCKS: Record<number, string> = {
  4: "legt den Donut weg",
  8: "in Form",
  10: "Schweißbänder",
  12: "EMS-Gurt",
  14: "erste Muskeln",
  17: "Sixpack",
  20: "Bodybuilder",
  23: "Adern",
  28: "mehr Adern, Brustfasern",
  29: "Achtpack, Laten, Beine",
  30: "Adern überall, Goldgurt – Item wählen (Prestige)",
};
