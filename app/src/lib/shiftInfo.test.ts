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

describe("shiftNotice – Kommen", () => {
  it("zu früh: Arbeitszeit zählt ab Schichtbeginn", () => {
    expect(shiftNotice("clock_in", shift, at("2026-10-05T06:40:00Z"))?.text).toBe(
      "Früh da! Deine Arbeitszeit zählt ab 09:00 (Schichtbeginn).",
    );
  });
  it("bis 5 Min. zu spät gilt als pünktlich", () => {
    expect(shiftNotice("clock_in", shift, at("2026-10-05T07:05:00Z"))).toBeNull();
  });
  it("mehr als 5 Min. zu spät: Minuten werden genannt", () => {
    expect(shiftNotice("clock_in", shift, at("2026-10-05T07:12:00Z"))?.text).toBe(
      "Schichtbeginn war 09:00 – 12 Min. später eingestempelt.",
    );
  });
  it("ohne Schicht: Aushilfsschicht wird eingetragen", () => {
    expect(shiftNotice("clock_in", undefined, at("2026-10-05T07:00:00Z"))?.text).toBe(
      "Keine Schicht geplant – wird als Aushilfsschicht (6,5 Std.) im Dienstplan eingetragen.",
    );
  });
});

describe("shiftNotice – Gehen", () => {
  it("Überstunden brauchen Freigabe", () => {
    expect(shiftNotice("clock_out", shift, at("2026-10-05T15:45:00Z"))?.text).toBe(
      "Schichtende war 17:00. Die 45 Min. Überstunden zählen erst nach Freigabe durch Tobias oder Dominik.",
    );
  });
  it("bis 5 Min. nach Schichtende: kein Hinweis", () => {
    expect(shiftNotice("clock_out", shift, at("2026-10-05T15:04:00Z"))).toBeNull();
  });
});

describe("shiftNotice – Pausen", () => {
  it("Pause Start nennt immer die gesetzliche Regel", () => {
    expect(shiftNotice("break_start", shift, at("2026-10-05T10:00:00Z"))?.text).toBe(
      "Gesetzliche Pause: ab 6 Std. Arbeit 30 Min., ab 9 Std. 45 Min. Jede Pause zählt mindestens 15 Min.",
    );
  });
  it("kurze Pause wird auf 15 Min. aufgerundet", () => {
    expect(
      shiftNotice("break_end", shift, at("2026-10-05T10:10:00Z"), { since: "2026-10-05T10:00:00Z" })?.text,
    ).toBe("Deine Pause war 10 Min. – sie wird mit 15 Min. berechnet.");
  });
  it("ausreichende Pause: kein Hinweis", () => {
    expect(shiftNotice("break_end", shift, at("2026-10-05T10:30:00Z"), { since: "2026-10-05T10:00:00Z" })).toBeNull();
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
