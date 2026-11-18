// Reiter „Wissen“: Lernlogik im Duolingo-Stil (Lektionen, Blitzi-Karteikarten, Blitzrunde, Leitner-Wiederholung).
// Inhalte liegen statisch im Repo (src/content/wissen/*.json) und werden NICHT verändert – nur angezeigt.
// Gespeichert wird nur der Lernfortschritt (Supabase: wissen_item_progress, wissen_attempts, wissen_profile).
import decksJson from "../content/wissen/decks.json";
import cardsJson from "../content/wissen/flashcards.json";
import questionsJson from "../content/wissen/questions.json";
import topicsJson from "../content/wissen/topics.json";
import unitsJson from "../content/wissen/units.json";

/** Thema (Kapitel) im Wissen – z. B. Einarbeitung, Strahlenschutz (NiSV). Units ohne topicId gehören zur Einarbeitung. */
export type Topic = { id: string; order: number; title: string; icon: string; description: string };
export type Unit = { id: string; order: number; title: string; source: string; icon: string; questionCount: number; topicId?: string };
export type Option = { id: string; text: string };
export type Question = {
  id: string;
  unitId: string;
  type: "single" | "multi";
  difficulty: 1 | 2 | 3;
  prompt: string;
  image: string | null;
  options: Option[];
  correct: string[];
  explanation: string;
  source: string;
};
export type Deck = { id: string; week: number; title: string; kind: "aufgabe" | "uebung" | "workshop"; needsContent: boolean; cardCount: number };
export type Flashcard = { id: string; deckId: string; front: string; back: string; source: string };

export const DEFAULT_TOPIC = "einarbeitung";
export const TOPICS = ([...topicsJson.items] as Topic[]).sort((a, b) => a.order - b.order);
export const UNITS = ([...unitsJson.items] as Unit[]).sort((a, b) => a.order - b.order);
export const topicOf = (u: Unit) => u.topicId ?? DEFAULT_TOPIC;
export const unitsOf = (topicId: string) => UNITS.filter((u) => topicOf(u) === topicId);
export const QUESTIONS = questionsJson.items as Question[];
export const DECKS = decksJson.items as Deck[];
export const CARDS = cardsJson.items as Flashcard[];
export const QUESTION_BY_ID = new Map(QUESTIONS.map((q) => [q.id, q]));
export const CARD_BY_ID = new Map(CARDS.map((c) => [c.id, c]));

export const LESSON_SIZE = 10;
export const MAX_REVIEWS_IN_LESSON = 4;
export const DAILY_GOAL_XP = 30;
export const BLITZ_SECONDS = 60;
export const UNLOCK_SHARE = 0.8;
export const XP_BY_DIFFICULTY: Record<1 | 2 | 3, number> = { 1: 10, 2: 15, 3: 20 };
export const PERFECT_BONUS = 10;
export const CARD_XP = 5;

export type ItemType = "question" | "card";
/** best_box: höchste je erreichte Stufe – Punkte gibt es nur für eine neue Bestmarke */
export type Progress = { item_id: string; item_type: ItemType; box: number; best_box?: number; due_at: string; times_correct: number; times_wrong: number };
export type ProgressMap = Map<string, Progress>;

// ---------------- Leitner ----------------
/** Tage bis zur nächsten Fälligkeit je Box (Box 1 = sofort / nächste Sitzung) */
export const BOX_DAYS: Record<number, number> = { 1: 0, 2: 1, 3: 3, 4: 7, 5: 14, 6: 30 };

/** Gleiche Regel wie in der Datenbank (wissen_answer): richtig, aber noch nicht wieder fällig = reine Übung */
const isPractice = (prev: Progress | undefined, correct: boolean, now: Date) =>
  correct && !!prev && new Date(prev.due_at).getTime() > now.getTime();

/**
 * Bringt diese Antwort Punkte? Nur richtig + neu oder fällig + neue Bestmarke. Falsch = 0, Wiederholen derselben
 * Frage (auch nach absichtlich falscher Antwort) = 0. Verbindlich entscheidet die Datenbank.
 */
export function earnsXp(prev: Progress | undefined, correct: boolean, now = new Date()): boolean {
  if (!correct || isPractice(prev, correct, now)) return false;
  return Math.min(6, (prev?.box ?? 1) + 1) > (prev?.best_box ?? 0);
}

/** retry: in derselben Lektion erst falsch, dann richtig → gilt als gelernt (Stufe 2, morgen wieder fällig) */
export function nextProgress(prev: Progress | undefined, id: string, type: ItemType, correct: boolean, now = new Date(), retry = false): Progress {
  if (retry && correct && prev) {
    const box = Math.max(prev.box, 2);
    const due = Math.max(new Date(prev.due_at).getTime(), now.getTime() + BOX_DAYS[box] * 864e5);
    return { ...prev, box, due_at: new Date(due).toISOString(), times_correct: prev.times_correct + 1 };
  }
  if (isPractice(prev, correct, now)) return { ...prev!, times_correct: prev!.times_correct + 1 };
  const box = correct ? Math.min(6, (prev?.box ?? 1) + 1) : 1;
  const due = new Date(now.getTime() + BOX_DAYS[box] * 864e5);
  return {
    item_id: id,
    item_type: type,
    box,
    best_box: Math.max(prev?.best_box ?? 0, correct ? box : 0),
    due_at: due.toISOString(),
    times_correct: (prev?.times_correct ?? 0) + (correct ? 1 : 0),
    times_wrong: (prev?.times_wrong ?? 0) + (correct ? 0 : 1),
  };
}

export const isDue = (p: Progress | undefined, now = new Date()) => Boolean(p) && new Date(p!.due_at).getTime() <= now.getTime();

// ---------------- Lernpfad ----------------
const unitQuestions = new Map<string, Question[]>();
for (const q of QUESTIONS) unitQuestions.set(q.unitId, [...(unitQuestions.get(q.unitId) ?? []), q]);
export const questionsOf = (unitId: string) => unitQuestions.get(unitId) ?? [];

const share = (unitId: string, progress: ProgressMap, minBox: number) => {
  const list = questionsOf(unitId);
  if (!list.length) return 0;
  return list.filter((q) => (progress.get(q.id)?.box ?? 0) >= minBox).length / list.length;
};

/** Fortschrittsring: Anteil der Fragen in Box ≥ 3 */
export const unitRing = (unitId: string, progress: ProgressMap) => share(unitId, progress, 3);

/** Freigeschaltet: Unit 1 immer; Unit n+1, wenn in Unit n ≥ 80 % der Fragen mindestens Box 2 haben */
export function unlockedUnits(progress: ProgressMap): Set<string> {
  // je Thema eine eigene Kette: die erste Unit ist offen, nach der ersten gesperrten ist der Rest gesperrt
  const result = new Set<string>();
  for (const t of TOPICS) {
    const list = unitsOf(t.id);
    for (let i = 0; i < list.length; i++) {
      if (i > 0 && share(list[i - 1].id, progress, 2) < UNLOCK_SHARE) break;
      result.add(list[i].id);
    }
  }
  return result;
}

/** Aktuelle Unit eines Themas: die letzte freigeschaltete */
export function currentUnit(progress: ProgressMap, topicId = DEFAULT_TOPIC): Unit | undefined {
  const open = unlockedUnits(progress);
  const list = unitsOf(topicId);
  return [...list].reverse().find((u) => open.has(u.id)) ?? list[0];
}

/**
 * Fortschritt eines Themas: Anteil der Fragen, die schon mindestens einmal (am Ende) richtig beantwortet wurden.
 * (Früher Stufe ≥ 4 – die erreicht man erst nach Wiederholungen über eine Woche, daher stand dort lange 0 %.)
 */
export function topicMastery(topicId: string, progress: ProgressMap): number {
  const list = unitsOf(topicId).flatMap((u) => questionsOf(u.id));
  const learned = (id: string) => {
    const p = progress.get(id);
    return Boolean(p && (p.box >= 2 || (p.best_box ?? 0) >= 2 || p.times_correct > 0));
  };
  return list.length ? list.filter((q) => learned(q.id)).length / list.length : 0;
}

/** Fällige Wiederholungen (nur schon gesehene Fragen) aus freigeschalteten Units */
export function dueQuestions(progress: ProgressMap, now = new Date()): Question[] {
  const open = unlockedUnits(progress);
  return QUESTIONS.filter((q) => open.has(q.unitId) && isDue(progress.get(q.id), now)).sort(
    (a, b) => new Date(progress.get(a.id)!.due_at).getTime() - new Date(progress.get(b.id)!.due_at).getTime(),
  );
}

export const dueCards = (progress: ProgressMap, now = new Date()) => CARDS.filter((c) => isDue(progress.get(c.id), now));

/**
 * Lektion (10 Fragen): bis zu 4 fällige Wiederholungen aus allen freigeschalteten Units, dann neue Fragen der gewählten
 * Unit (leicht → schwer). Sind keine neuen mehr übrig, Fragen der Unit mit der niedrigsten Box.
 */
export function composeLesson(unitId: string, progress: ProgressMap, now = new Date()): Question[] {
  // Wiederholungen nur aus demselben Thema (Einarbeitung und Strahlenschutz bleiben getrennt)
  const topic = topicOf(UNITS.find((u) => u.id === unitId) ?? UNITS[0]);
  const sameTopic = new Set(unitsOf(topic).map((u) => u.id));
  const reviews = dueQuestions(progress, now).filter((q) => sameTopic.has(q.unitId)).slice(0, MAX_REVIEWS_IN_LESSON);
  const picked = new Set(reviews.map((q) => q.id));
  const own = questionsOf(unitId).filter((q) => !picked.has(q.id));
  const fresh = own.filter((q) => !progress.has(q.id)).sort((a, b) => a.difficulty - b.difficulty || a.id.localeCompare(b.id));
  const rest = own
    .filter((q) => progress.has(q.id))
    .sort((a, b) => (progress.get(a.id)!.box - progress.get(b.id)!.box) || a.difficulty - b.difficulty);
  return [...reviews, ...fresh, ...rest].slice(0, LESSON_SIZE);
}

/** Antwort prüfen: alles oder nichts */
export function isCorrect(q: Question, chosen: string[]): boolean {
  const a = [...new Set(chosen)].sort();
  const b = [...q.correct].sort();
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/** Mischen (Fisher-Yates) */
export function shuffle<T>(list: T[], rnd = Math.random): T[] {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// ---------------- Serie & XP ----------------
export type DayXp = { day: string; xp: number; active: boolean };

const isoDay = (d: Date) => d.toLocaleDateString("sv-SE", { timeZone: "Europe/Berlin" });

/** Serie: Tage in Folge mit Lernen (heute zählt mit, ein noch leerer heutiger Tag bricht sie nicht) */
export function streakOf(days: DayXp[], now = new Date()): number {
  const active = new Set(days.filter((d) => d.active).map((d) => d.day));
  let n = 0;
  const cur = new Date(now);
  if (!active.has(isoDay(cur))) cur.setDate(cur.getDate() - 1);
  while (active.has(isoDay(cur))) {
    n++;
    cur.setDate(cur.getDate() - 1);
  }
  return n;
}

export const todayXp = (days: DayXp[], now = new Date()) => days.find((d) => d.day === isoDay(now))?.xp ?? 0;

/** Wochen-XP (Mo–So, Berliner Zeit) */
export function weekXp(days: DayXp[], now = new Date()): number {
  const today = new Date(`${isoDay(now)}T00:00:00Z`);
  const monday = new Date(today.getTime() - ((today.getUTCDay() + 6) % 7) * 864e5);
  const from = monday.toISOString().slice(0, 10);
  return days.filter((x) => x.day >= from).reduce((s, x) => s + x.xp, 0);
}

export const WEEK_TITLES: Record<number, string> = { 1: "Woche 1", 2: "Woche 2", 3: "Woche 3", 4: "Woche 4", 5: "Woche 5", 6: "Woche 6" };
export const DECK_KIND: Record<Deck["kind"], string> = { aufgabe: "Aufgabe", uebung: "Übung", workshop: "Workshop" };

// ---------------- Level ----------------
/** Gesamt-XP, die für ein Level nötig sind: Level 1 = 0, 2 = 100, 3 = 300, 4 = 600 … (50 · (n−1) · n) */
export const xpForLevel = (level: number) => 50 * (level - 1) * level;

const LEVEL_TITLES: [number, string][] = [[1, "Starter"], [5, "Kenner"], [10, "Profi"], [15, "Experte"], [20, "Meister"]];

export type LevelInfo = { level: number; title: string; into: number; need: number; pct: number; next: number };

/** Level zu den Gesamt-XP: aktueller Stand und Weg zum nächsten Level */
export function levelOf(xpTotal: number): LevelInfo {
  const xp = Math.max(0, Math.floor(xpTotal));
  let level = Math.floor((1 + Math.sqrt(1 + (4 * xp) / 50)) / 2);
  while (xpForLevel(level + 1) <= xp) level++;
  while (level > 1 && xpForLevel(level) > xp) level--;
  const base = xpForLevel(level);
  const need = xpForLevel(level + 1) - base;
  let title = LEVEL_TITLES[0][1];
  for (const [from, t] of LEVEL_TITLES) if (level >= from) title = t;
  return { level, title, into: xp - base, need, pct: Math.round(((xp - base) / need) * 100), next: xpForLevel(level + 1) - xp };
}
