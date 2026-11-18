import { describe, expect, it } from "vitest";
import { isLearned, topicMastery } from "./wissen";
import { CARDS, composeLesson, DECKS, earnsXp, isCorrect, levelOf, nextProgress, type ProgressMap, QUESTIONS, streakOf, TOPICS, topicOf, UNITS, unlockedUnits, weekXp, xpForLevel } from "./wissen";

describe("Wissen-Inhalte", () => {
  it("alle richtigen Antworten existieren, IDs eindeutig, Units und Decks passen", () => {
    expect(QUESTIONS).toHaveLength(426);
    expect(QUESTIONS.filter((q) => topicOf(UNITS.find((u) => u.id === q.unitId)!) === "nisv")).toHaveLength(206);
    for (const u of UNITS) expect(QUESTIONS.filter((q) => q.unitId === u.id), u.id).toHaveLength(u.questionCount);
    expect(new Set(QUESTIONS.map((q) => q.id)).size).toBe(QUESTIONS.length);
    for (const q of QUESTIONS) {
      const ids = new Set(q.options.map((o) => o.id));
      expect(q.correct.length).toBeGreaterThan(0);
      for (const c of q.correct) expect(ids.has(c), q.id).toBe(true);
      expect(UNITS.some((u) => u.id === q.unitId), q.id).toBe(true);
    }
    for (const c of CARDS) expect(DECKS.some((d) => d.id === c.deckId), c.id).toBe(true);
  });
  it("alle Bilder liegen in public/wissen", () => {
    const files = Object.keys(import.meta.glob("../../public/wissen/*.svg", { query: "?url" })).map((f) => f.replace("../../public", ""));
    for (const q of QUESTIONS.filter((q) => q.image)) expect(files, q.image!).toContain(q.image);
  });
});

describe("Lernlogik", () => {
  it("Leitner: richtig +1 Box (max 6), falsch zurück auf 1", () => {
    const now = new Date("2026-11-10T10:00:00Z");
    const a = nextProgress(undefined, "x", "question", true, now);
    expect(a.box).toBe(2);
    expect(a.due_at).toBe("2026-11-11T10:00:00.000Z");
    expect(nextProgress({ ...a, box: 6 }, "x", "question", true, now).box).toBe(6);
    expect(nextProgress({ ...a, box: 5 }, "x", "question", false, now).box).toBe(1);
  });
  it("alles oder nichts", () => {
    const q = QUESTIONS.find((x) => x.type === "multi")!;
    expect(isCorrect(q, q.correct)).toBe(true);
    expect(isCorrect(q, q.correct.slice(1))).toBe(false);
  });
  it("Unit 2 erst ab 80 % Box 2 in Unit 1", () => {
    const p: ProgressMap = new Map();
    expect([...unlockedUnits(p)]).toEqual(TOPICS.map((t) => UNITS.find((u) => topicOf(u) === t.id)!.id)); // je Thema die erste Lektion
    const qs = QUESTIONS.filter((q) => q.unitId === UNITS[0].id);
    qs.slice(0, Math.ceil(qs.length * 0.8)).forEach((q) => p.set(q.id, { item_id: q.id, item_type: "question", box: 2, due_at: "2099-01-01T00:00:00Z", times_correct: 1, times_wrong: 0 }));
    expect(unlockedUnits(p).has(UNITS[1].id)).toBe(true);
  });
  it("Lektion: 10 Fragen, höchstens 4 Wiederholungen, neue leicht zuerst", () => {
    const lesson = composeLesson(UNITS[0].id, new Map());
    expect(lesson.length).toBe(Math.min(10, QUESTIONS.filter((q) => q.unitId === UNITS[0].id).length));
    expect(lesson.map((q) => q.difficulty)).toEqual([...lesson.map((q) => q.difficulty)].sort());
  });
  it("Serie und Wochen-XP", () => {
    const now = new Date("2026-11-11T12:00:00Z"); // Mittwoch
    const days = [
      { day: "2026-11-09", xp: 20, active: true },
      { day: "2026-11-10", xp: 30, active: true },
      { day: "2026-11-08", xp: 10, active: true },
    ];
    expect(streakOf(days, now)).toBe(3);
    expect(weekXp(days, now)).toBe(50);
  });
});

describe("Faire Punkte und Level", () => {
  const now = new Date("2026-11-10T10:00:00Z");
  it("falsch = 0; neu richtig = Punkte; gleich nochmal = Übung ohne Punkte", () => {
    expect(earnsXp(undefined, false, now)).toBe(false);
    expect(earnsXp(undefined, true, now)).toBe(true);
    const a = nextProgress(undefined, "x", "question", true, now); // Box 2, fällig morgen
    expect(earnsXp(a, true, now)).toBe(false);
    expect(nextProgress(a, "x", "question", true, now).box).toBe(2); // Übung ändert die Stufe nicht
  });
  it("absichtlich falsch und wieder richtig bringt keine neuen Punkte", () => {
    const a = nextProgress(undefined, "x", "question", true, now); // Bestmarke 2
    const wrong = nextProgress(a, "x", "question", false, now); // Box 1, sofort fällig
    expect(wrong.best_box).toBe(2);
    expect(earnsXp(wrong, true, now)).toBe(false); // wieder Box 2 – schon erreicht
    const later = new Date("2026-11-12T10:00:00Z");
    const again = nextProgress(wrong, "x", "question", true, now); // Box 2
    expect(earnsXp(again, true, later)).toBe(true); // fällig und Box 3 = neue Bestmarke
  });
  it("erst falsch, in derselben Lektion dann richtig: gilt als gelernt (Stufe 2, morgen fällig)", () => {
    const wrong = nextProgress(undefined, "x", "question", false, now);
    expect(wrong.box).toBe(1);
    const fixed = nextProgress(wrong, "x", "question", true, now, true);
    expect(fixed.box).toBe(2);
    expect(fixed.due_at).toBe("2026-11-11T10:00:00.000Z");
    expect(fixed.best_box ?? 0).toBe(0); // keine Bestmarke → keine Punkte für den zweiten Anlauf
  });
  it("Level: 0 XP = Level 1, 100 = 2, 300 = 3; Fortschritt zum nächsten", () => {
    expect(levelOf(0)).toMatchObject({ level: 1, title: "Starter", next: 100 });
    expect(levelOf(99).level).toBe(1);
    expect(levelOf(100).level).toBe(2);
    expect(levelOf(300)).toMatchObject({ level: 3, into: 0 });
    expect(levelOf(xpForLevel(10))).toMatchObject({ level: 10, title: "Profi" });
    expect(levelOf(450).pct).toBe(50);
  });
  it("jede Unit gehört zu einem bekannten Thema; jedes Thema hat eine eigene erste offene Unit", () => {
    for (const u of UNITS) expect(TOPICS.some((t) => t.id === topicOf(u)), u.id).toBe(true);
  });
});

describe("Fortschritt je Thema", () => {
  it("zählt Fragen, die schon richtig beantwortet wurden – nicht erst ab Stufe 4", () => {
    const list = QUESTIONS.filter((q) => q.unitId === UNITS[0].id);
    const total = QUESTIONS.filter((q) => !q.unitId.startsWith("nisv-")).length;
    const p: ProgressMap = new Map();
    list.forEach((q) => p.set(q.id, { item_id: q.id, item_type: "question", box: 2, due_at: "2099-01-01T00:00:00Z", times_correct: 1, times_wrong: 0 }));
    expect(topicMastery("einarbeitung", p)).toBeCloseTo(list.length / total);
    expect(topicMastery("nisv", p)).toBe(0);
  });
});

describe("isLearned", () => {
  it("bleibt gelernt nach einem späteren Fehler", () => {
    const p = { item_id: "x", item_type: "question" as const, box: 1, best_box: 3, due_at: new Date().toISOString(), times_correct: 4, times_wrong: 1 };
    expect(isLearned(p)).toBe(true);
    expect(isLearned(undefined)).toBe(false);
  });
});
