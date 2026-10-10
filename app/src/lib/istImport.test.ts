import { describe, expect, it } from "vitest";
import { berlinToISO } from "./dates";
import { type DayEntry, IST_NOTE_PREFIX, IST_SOURCE, coverage, parseIst, planSync, schoolDays } from "./istImport";

const people = [
  { id: "adrian", first_name: "Adrian", last_name: "Hajdari" },
  { id: "djam", first_name: "Djam", last_name: "Konaté" },
  { id: "soso", first_name: "Sophie", last_name: "Wettstädt" },
  { id: "sophie", first_name: "Sophie", last_name: "Schwenzer" },
  { id: "tizian", first_name: "Tizian", last_name: "Verhouven" },
  { id: "benji", first_name: "Benjamin", last_name: "Cedeno" },
  { id: "marlene", first_name: "Marlene", last_name: "Stedele" },
];

describe("IST-Termine lesen", () => {
  it("Seitentext: Zeitraum, Uhrzeit, Name, Titel, Abgesagt davor, nur Monat ignoriert", () => {
    const text = `Termine
Suchen...
03.08.26 09:00 Uhr - 05.08.26 16:00 Uhr Adrian Hajdari Rückentraining A-Lizenz Teil 1 - Grundlagen
Abgesagt
10.08.26 09:00 Uhr - 10.08.26 17:00 Uhr Djam Ousmane Konaté Prüfungsvorbereitung 2
07.11.26 - 08.11.26 Sophie Wettstädt Fitnesstraining
März 27 Benjamin Cedeno Abschlussprüfung
12.11.26 09:00 Uhr - 12.11.26 16:00 Uhr Tizi Verhouven Recht
14.11.26 Max Unbekannt Pädagogik`;
    const { records, monthOnly } = parseIst(text, people);
    expect(monthOnly).toBe(1);
    expect(records.map((r) => [r.userId, r.from, r.to, r.startTime, r.endTime, r.title, r.cancelled])).toEqual([
      ["adrian", "2026-08-03", "2026-08-05", "09:00", "16:00", "Rückentraining A-Lizenz Teil 1 - Grundlagen", false],
      ["djam", "2026-08-10", "2026-08-10", "09:00", "17:00", "Prüfungsvorbereitung 2", true],
      ["soso", "2026-11-07", "2026-11-08", undefined, undefined, "Fitnesstraining", false],
      ["tizian", "2026-11-12", "2026-11-12", "09:00", "16:00", "Recht", false],
      [null, "2026-11-14", "2026-11-14", undefined, undefined, "Max Unbekannt Pädagogik", false],
    ]);
  });

  it("Tabelle mit Tabs: Abgesagt in derselben Zeile gehört zu diesem Termin", () => {
    const text = "Abgesagt\t03.08.26 09:00 Uhr - 05.08.26 16:00 Uhr\tAdrian Hajdari\tKurs A\n"
      + "10.08.26 09:00 Uhr - 10.08.26 17:00 Uhr\tMarlene Stedele\tKurs B\tAbgesagt\n"
      + "11.08.26\tMarlene Stedele\tKurs C\n";
    const { records } = parseIst(text, people);
    expect(records.map((r) => [r.userId, r.title, r.cancelled])).toEqual([
      ["adrian", "Kurs A", true],
      ["marlene", "Kurs B", true],
      ["marlene", "Kurs C", false],
    ]);
  });

  it("Zellen untereinander: Name und Titel in eigenen Zeilen", () => {
    const text = "03.08.26 09:00 Uhr - 05.08.26 16:00 Uhr\nAdrian Hajdari\nKurs A\nAbgesagt\n10.08.26 09:00 Uhr - 10.08.26 17:00 Uhr\nMarlene Stedele\nKurs B\n";
    const { records } = parseIst(text, people);
    expect(records.map((r) => [r.userId, r.title, r.cancelled])).toEqual([
      ["adrian", "Kurs A", false],
      ["marlene", "Kurs B", true],
    ]);
  });

  it("zwei Sophies werden über den Nachnamen unterschieden", () => {
    const { records } = parseIst("01.09.26 Sophie Schwenzer Recht\n02.09.26 Sophie Wettstädt Recht", people);
    expect(records.map((r) => r.userId)).toEqual(["sophie", "soso"]);
  });
});

describe("Abgleich mit dem Dienstplan", () => {
  const entry = (id: string, user: string, date: string, from: string, to: string, extra: Partial<DayEntry> = {}): DayEntry => ({
    id, user_id: user, shift_type: "vocational_school", starts_at: berlinToISO(date, from), ends_at: berlinToISO(date, to), note: null, ...extra,
  });

  it("neu, unverändert, geändert, entfällt, Konflikt mit Schicht, schon abwesend", () => {
    const { records } = parseIst(
      "03.08.26 09:00 Uhr - 05.08.26 16:00 Uhr Adrian Hajdari Kurs A\n07.11.26 - 08.11.26 Sophie Wettstädt Fitnesstraining",
      people,
    );
    const days = schoolDays(records);
    expect(days).toHaveLength(5);
    const existing: DayEntry[] = [
      entry("same", "adrian", "2026-08-03", "09:00", "16:00", { import_source: IST_SOURCE, note: `${IST_NOTE_PREFIX}Kurs A` }),
      entry("moved", "adrian", "2026-08-04", "08:00", "16:00", { import_source: IST_SOURCE, note: `${IST_NOTE_PREFIX}Kurs A` }),
      entry("gone", "adrian", "2026-08-06", "09:00", "16:00", { import_source: IST_SOURCE, note: `${IST_NOTE_PREFIX}Kurs A` }),
      entry("other", "benji", "2026-08-06", "09:00", "16:00", { import_source: IST_SOURCE }),
      entry("shift", "adrian", "2026-08-05", "10:00", "14:00", { shift_type: "work" }),
      entry("vac", "soso", "2026-11-07", "08:00", "14:30", { shift_type: "vacation" }),
    ];
    const plan = planSync(days, existing, coverage(records)!);
    expect(plan.unchanged).toBe(1);
    expect(plan.update.map((u) => u.entry.id)).toEqual(["moved"]);
    expect(plan.remove.map((e) => e.id)).toEqual(["gone"]);
    expect(plan.conflicts.map((c) => [c.day.date, c.entry.id])).toEqual([["2026-08-05", "shift"]]);
    expect(plan.absent.map((a) => a.day.date)).toEqual(["2026-11-07"]);
    expect(plan.add.map((d) => [d.userId, d.date])).toEqual([["soso", "2026-11-08"]]);
  });

  it("abgesagte Termine werden nicht eingetragen, ihr alter Eintrag fällt weg", () => {
    const { records } = parseIst("Abgesagt\n03.08.26 Adrian Hajdari Kurs A", people);
    const plan = planSync(schoolDays(records), [entry("old", "adrian", "2026-08-03", "08:00", "16:00", { import_source: IST_SOURCE })], coverage(records)!);
    expect(plan.add).toHaveLength(0);
    expect(plan.remove.map((e) => e.id)).toEqual(["old"]);
  });
});
