// Erfolge: Serie (Tage am Stück), Tagesziel ("Akku"), Wochenpunkte, Rangliste, Blitzis Stimmung
import type { Completion, Member } from "../types";
import { isoWeek } from "../studio/period";
import { addDays, isoDay } from "../util";

/** Aufgaben pro Tag für einen vollen Akku */
export const DAILY_GOAL = 3;
/** Punkt je erledigter Aufgabe … */
export const POINTS = 1;
/** … höchstens so viele pro Person und Tag (mehr Aufgaben zählen nur noch für die Serie) */
export const DAILY_POINTS = 3;

export const dayOf = (iso: string) => isoDay(new Date(iso));

/**
 * Punkte nach Tagen: je Aufgabe 1, je Person und Tag höchstens DAILY_POINTS.
 * Gespeicherte Punktwerte (früher 10–20) werden bewusst ignoriert – so gilt die Regel auch für alte Einträge.
 */
export function pointsByDay(completions: Completion[], fromDay?: string, toDay?: string): Map<string, Map<string, number>> {
  const out = new Map<string, Map<string, number>>();
  for (const c of completions) {
    const day = dayOf(c.doneAt);
    if ((fromDay && day < fromDay) || (toDay && day >= toDay)) continue;
    const days = out.get(c.userId) ?? new Map<string, number>();
    days.set(day, Math.min(DAILY_POINTS, (days.get(day) ?? 0) + POINTS));
    out.set(c.userId, days);
  }
  return out;
}

const sum = (days: Map<string, number> | undefined) => [...(days?.values() ?? [])].reduce((s, n) => s + n, 0);

/** Punkte, die eine weitere Aufgabe heute noch bringt (0 = Tagesmaximum erreicht) */
export const pointsLeftToday = (doneToday: number) => Math.max(0, Math.min(POINTS, DAILY_POINTS - doneToday * POINTS));

/** Montag der Woche */
export function weekStart(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  const wd = (new Date(y, m - 1, d).getDay() + 6) % 7;
  return addDays(day, -wd);
}

const weekday = (day: string) => {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y, m - 1, d).getDay();
};

/** Arbeitstage einer Person aus der Liste aller (leer = unbekannt, z. B. wer nie stempelt) */
export function daysFor(all: Record<string, string[]> | null, userId: string): string[] | null {
  const days = all?.[userId];
  return days && days.length ? days : null;
}

/**
 * Serie: Tage mit mindestens einer erledigten Aufgabe, rückwärts ab heute.
 * Heute zählt mit, bricht die Serie aber noch nicht. "Neutrale" Tage (frei, Sonntag) werden übersprungen.
 */
export function streakOf(active: Set<string>, today: string, isNeutral: (day: string) => boolean, maxDays = 180): number {
  let streak = active.has(today) ? 1 : 0;
  let day = today;
  for (let i = 0; i < maxDays; i++) {
    day = addDays(day, -1);
    if (active.has(day)) streak++;
    else if (!isNeutral(day)) break;
  }
  return streak;
}

export type MyStats = {
  today: number;
  todayPoints: number;
  week: number;
  weekPoints: number;
  streak: number;
  goal: number;
  goalReached: boolean;
};

/**
 * Werte einer Person. workDays = Tage, an denen sie gearbeitet hat (eingestempelt, ohne Schule/Urlaub/Krank/frei);
 * nur diese können die Serie unterbrechen. Ohne Stempeldaten sind Samstag und Sonntag neutral.
 */
export function myStats(userId: string, completions: Completion[], opts: { today: string; workDays: string[] | null; goal?: number }): MyStats {
  const mine = completions.filter((c) => c.userId === userId);
  const week = weekStart(opts.today);
  const todays = mine.filter((c) => dayOf(c.doneAt) === opts.today);
  const weeks = mine.filter((c) => dayOf(c.doneAt) >= week);
  const worked = opts.workDays ? new Set(opts.workDays) : null;
  const neutral = (day: string) => {
    const wd = weekday(day);
    if (wd === 0) return true;
    return worked ? !worked.has(day) : wd === 6;
  };
  const goal = opts.goal ?? DAILY_GOAL;
  const points = pointsByDay(mine, week).get(userId);
  return {
    today: todays.length,
    todayPoints: points?.get(opts.today) ?? 0,
    week: weeks.length,
    weekPoints: sum(points),
    streak: streakOf(new Set(mine.map((c) => dayOf(c.doneAt))), opts.today, neutral),
    goal,
    goalReached: todays.length >= goal,
  };
}

export type LeaderRow = { member: Member; points: number; count: number; rank: number };

/** Rangliste ab einem Tag (Standard: Wochenbeginn), optional bis vor toDay; Geräte zählen nicht */
export function leaderboard(completions: Completion[], members: Member[], fromDay: string, toDay?: string): LeaderRow[] {
  const sums = new Map<string, { points: number; count: number }>();
  const points = pointsByDay(completions, fromDay, toDay);
  for (const c of completions) {
    if (dayOf(c.doneAt) < fromDay || (toDay && dayOf(c.doneAt) >= toDay)) continue;
    const s = sums.get(c.userId) ?? { points: sum(points.get(c.userId)), count: 0 };
    s.count++;
    sums.set(c.userId, s);
  }
  const rows = members
    .filter((m) => !m.device && sums.has(m.id))
    .map((m) => ({ member: m, ...sums.get(m.id)!, rank: 0 }))
    .sort((a, b) => b.points - a.points || b.count - a.count || a.member.name.localeCompare(b.member.name, "de"));
  rows.forEach((r, i) => (r.rank = i > 0 && rows[i - 1].points === r.points ? rows[i - 1].rank : i + 1));
  return rows;
}

export type Mood = "party" | "proud" | "happy" | "neutral" | "sleepy" | "sad";

export function moodFor(s: MyStats, open: number, hour: number): Mood {
  if (s.goalReached) return s.streak >= 3 ? "party" : "proud";
  if (s.today > 0 || open === 0) return "happy";
  if (hour >= 15) return "sad";
  if (hour < 9) return "sleepy";
  return "neutral";
}

const LINES: Record<Mood, string[]> = {
  party: [
    "{streak} Tage am Stück unter Strom – du bist nicht zu stoppen!",
    "Tagesziel geknackt! Ich sprühe Funken!",
    "Volle Ladung! Heute leuchtet das ganze Studio.",
  ],
  proud: ["Tagesziel erreicht – mein Akku ist randvoll!", "Stark! Kurz, intensiv, erledigt – wie ein gutes EMS-Training.", "Geschafft! Gönn dir einen Shake."],
  happy: ["Läuft! Noch {rest} bis zum vollen Akku.", "Jede erledigte Aufgabe ist ein Stromstoß für mich!", "Weiter so – ich lade gerade auf."],
  neutral: ["Na, wollen wir eine Aufgabe wegblitzen?", "{open} Aufgaben warten – fang mit der kleinsten an.", "Ein Impuls genügt: die erste Aufgabe!"],
  sleepy: ["Zzz … Guten Morgen! Weck mich mit einer erledigten Aufgabe.", "Noch etwas müde … eine Aufgabe und ich bin wach!"],
  sad: [
    "Mein Akku ist fast leer … eine kleine Aufgabe lädt mich auf.",
    "Heute noch nichts erledigt – ich glaub an dich!",
    "Ohne Strom kein Blitz … {open} Aufgaben warten auf dich.",
  ],
};

/** Spruch passend zur Stimmung; variant wechselt beim Antippen */
export function speech(mood: Mood, s: MyStats, open: number, variant = 0): string {
  const list = LINES[mood];
  const day = Number(new Date().toISOString().slice(8, 10));
  const line = list[(day + variant) % list.length];
  return line
    .replace("{streak}", String(s.streak))
    .replace("{rest}", String(Math.max(0, s.goal - s.today)))
    .replace("{open}", String(open));
}

/** Zeitraum des Wochenrankings */
export type RankingInfo = { label: string; from: string; to: string; range: string };

/** Vorwoche (Montag–Sonntag) zu einem Tag */
export function lastWeek(day: string): RankingInfo {
  const thisMonday = weekStart(day);
  const from = addDays(thisMonday, -7);
  const [, m1, d1] = from.split("-").map(Number);
  const [, m2, d2] = addDays(thisMonday, -1).split("-").map(Number);
  const week = isoWeek(from).week;
  return { label: `KW ${week}`, from, to: thisMonday, range: `${d1}.${m1}.–${d2}.${m2}.` };
}
