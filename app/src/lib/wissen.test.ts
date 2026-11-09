import { describe, expect, it } from "vitest";
import { CARDS, composeLesson, DECKS, isCorrect, nextProgress, type ProgressMap, QUESTIONS, streakOf, UNITS, unlockedUnits, weekXp } from "./wissen";

describe("Wissen-Inhalte", () => {
  it("alle richtigen Antworten existieren, IDs eindeutig, Units und Decks passen", () => {
    expect(QUESTIONS).toHaveLength(220);
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
    expect([...unlockedUnits(p)]).toEqual([UNITS[0].id]);
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
