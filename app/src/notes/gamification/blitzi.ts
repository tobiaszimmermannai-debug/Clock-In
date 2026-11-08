// Blitzi einer Person: Stufe (Serie seit dem letzten Prestige), Prestige, Items, Spitzname – eine Berechnung für
// Karte, Dashboard, Team-Szene, Siegerehrung, Belohnung und Feierabend.
import type { BlitziProfile, Completion } from "../types";
import { stageOf } from "./evolution";
import { blitziStreak, myStats, type MyStats } from "./stats";

export type BlitziInfo = {
  stage: number;
  /** Serie seit dem letzten Prestige (für die Stufe) */
  streak: number;
  prestige: number;
  items: string[];
  nickname: string | null;
  stats: MyStats;
};

export function blitziInfo(userId: string, completions: Completion[], workDays: string[] | null, today: string, profile?: BlitziProfile | null): BlitziInfo {
  const stats = myStats(userId, completions, { today, workDays });
  const streak = blitziStreak(userId, completions, workDays, today, profile);
  return {
    stage: stageOf(streak),
    streak,
    prestige: profile?.prestige ?? 0,
    items: profile?.items ?? [],
    nickname: profile?.nickname ?? null,
    stats,
  };
}
