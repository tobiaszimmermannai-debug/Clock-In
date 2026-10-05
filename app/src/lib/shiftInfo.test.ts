import { describe, expect, it } from "vitest";
import { relevantShift, shiftNotice } from "./shiftInfo";
import type { Shift } from "./types";

// Schicht 09:00–17:00 Berliner Zeit (= 07:00–15:00 UTC im Oktober)
const shift: Shift = {
  id: "s1",
  user_id: "u1",
  location_id: "l1",
  shift_type: "work",
  starts_at: "2026-10-05T07:00:00Z",
  ends_at: "2026-10-05T15:00:00Z",
};
const at = (iso: string) => new Date(iso);

describe("shiftNotice", () => {
  it("zu früh: Arbeitszeit zählt ab Schichtbeginn", () => {
    expect(shiftNotice("clock_in", shift, at("2026-10-05T06:40:00Z"))).toEqual({
      tone: "info",
      text: "Früh da! Deine Arbeitszeit zählt ab 09:00 (Schichtbeginn).",
    });
  });
  it("pünktlich: kein Hinweis", () => {
    expect(shiftNotice("clock_in", shift, at("2026-10-05T07:00:30Z"))).toBeNull();
  });
  it("verspätet: Minuten werden genannt", () => {
    expect(shiftNotice("clock_in", shift, at("2026-10-05T07:12:00Z"))?.text).toBe(
      "Schichtbeginn war 09:00 – 12 Min. später eingestempelt.",
    );
  });
  it("ohne Schicht: Warnung, Buchung trotzdem", () => {
    expect(shiftNotice("clock_in", undefined, at("2026-10-05T07:00:00Z"))?.tone).toBe("warn");
  });
  it("Gehen nach Schichtende: Kappung erklärt", () => {
    expect(shiftNotice("clock_out", shift, at("2026-10-05T15:30:00Z"))?.text).toBe(
      "Schichtende war 17:00. Gezählt wird bis Schichtende.",
    );
  });
  it("Pausen: kein Hinweis", () => {
    expect(shiftNotice("break_start", shift, at("2026-10-05T10:00:00Z"))).toBeNull();
  });
});

describe("relevantShift", () => {
  it("findet nur Arbeitsschichten der Person im Zeitfenster", () => {
    const other = { ...shift, id: "s2", user_id: "u2" };
    const school = { ...shift, id: "s3", shift_type: "vocational_school" as const };
    expect(relevantShift([other, school, shift], "u1", at("2026-10-05T06:30:00Z"))?.id).toBe("s1");
    expect(relevantShift([shift], "u1", at("2026-10-05T19:00:00Z"))).toBeUndefined();
  });
});
