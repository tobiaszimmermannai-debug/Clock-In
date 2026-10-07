import { describe, expect, it } from "vitest";
import { absenceDays, addDays, vacationRanges, berlinDate, berlinTime, berlinToISO, daysBetween, fmtDay, fmtHM, isoWeek, weekRangeLabel, weekStart, weekdayShort } from "./dates";

describe("Berliner Zeit", () => {
  it("Sommerzeit: 09:00 Berlin = 07:00 UTC", () => {
    expect(berlinToISO("2026-07-01", "09:00")).toBe("2026-07-01T07:00:00.000Z");
  });
  it("Winterzeit: 09:00 Berlin = 08:00 UTC", () => {
    expect(berlinToISO("2026-12-01", "09:00")).toBe("2026-12-01T08:00:00.000Z");
  });
  it("Umstellungstage (29.03. und 25.10.2026)", () => {
    expect(berlinToISO("2026-03-29", "12:00")).toBe("2026-03-29T10:00:00.000Z");
    expect(berlinToISO("2026-10-25", "12:00")).toBe("2026-10-25T11:00:00.000Z");
    expect(berlinToISO("2026-10-25", "00:00")).toBe("2026-10-24T22:00:00.000Z");
  });
  it("Rückweg: Datum und Uhrzeit", () => {
    expect(berlinDate("2026-10-05T22:30:00Z")).toBe("2026-10-06");
    expect(berlinTime("2026-10-05T07:05:00Z")).toBe("09:05");
  });
});

describe("Kalender", () => {
  it("Wochenbeginn ist Montag", () => {
    expect(weekStart("2026-10-08")).toBe("2026-10-05");
    expect(weekStart("2026-10-11")).toBe("2026-10-05");
    expect(weekStart("2026-10-05")).toBe("2026-10-05");
  });
  it("Tage addieren über Monatsgrenzen", () => {
    expect(addDays("2026-10-30", 3)).toBe("2026-11-02");
    expect(daysBetween("2026-10-01", "2026-10-06")).toBe(5);
  });
  it("Kalenderwoche", () => {
    expect(isoWeek("2026-10-05")).toBe(41);
    expect(isoWeek("2026-01-01")).toBe(1);
    expect(isoWeek("2027-01-01")).toBe(53);
  });
  it("Formate", () => {
    expect(fmtDay("2026-10-05")).toBe("Mo., 05.10.");
    expect(fmtHM(390)).toBe("6:30");
    expect(fmtHM(-45)).toBe("−0:45");
  });
});

describe("Wochen-Beschriftung", () => {
  it("Wochentag und Zeitraum", () => {
    expect(weekdayShort("2026-10-05")).toBe("Mo");
    expect(weekdayShort("2026-10-11")).toBe("So");
    expect(weekRangeLabel("2026-10-05")).toBe("5.–11. Okt.");
    expect(weekRangeLabel("2026-09-28")).toBe("28. Sept. – 4. Okt.");
  });
});

describe("Abwesenheit über mehrere Tage", () => {
  it("zählt Mo–Fr, Samstag nur auf Wunsch, Sonntag nie", () => {
    // 12.10.2026 = Montag
    expect(absenceDays("2026-10-12", "2026-10-18")).toEqual(["2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16"]);
    expect(absenceDays("2026-10-12", "2026-10-18", true)).toHaveLength(6);
    expect(absenceDays("2026-10-12", "2026-10-25")).toHaveLength(10);
  });
  it("ein einzelner Tag zählt immer – auch Samstag/Sonntag", () => {
    expect(absenceDays("2026-10-18", "2026-10-18")).toEqual(["2026-10-18"]);
    expect(absenceDays("2026-10-17", "2026-10-10")).toEqual(["2026-10-17"]);
  });
});

describe("Urlaub zusammenfassen", () => {
  it("fasst Tage über das Wochenende zusammen", () => {
    // Fr 16.10., Mo 19.10., Di 20.10. → ein Block; Fr 30.10. einzeln
    expect(vacationRanges(["2026-10-19", "2026-10-16", "2026-10-20", "2026-10-30"])).toEqual([
      { from: "2026-10-16", to: "2026-10-20", count: 3 },
      { from: "2026-10-30", to: "2026-10-30", count: 1 },
    ]);
  });
});
