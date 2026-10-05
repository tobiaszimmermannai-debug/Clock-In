import { describe, expect, it } from "vitest";
import { currentState, validateAction } from "./status";
import type { EventType, LogEntry } from "./types";

const log = (event_type: EventType, iso: string, approval_status?: LogEntry["approval_status"]): LogEntry => ({
  client_event_id: crypto.randomUUID(),
  user_id: "u1",
  event_type,
  recorded_at: iso,
  approval_status,
});
const now = new Date("2026-10-05T14:00:00Z");

describe("currentState", () => {
  it("ohne Buchungen: ausgestempelt", () => {
    expect(currentState([], now).state).toBe("out");
  });
  it("letzte Buchung bestimmt den Status, unabhängig von der Reihenfolge", () => {
    const events = [log("break_start", "2026-10-05T12:00:00Z"), log("clock_in", "2026-10-05T08:00:00Z")];
    expect(currentState(events, now)).toEqual({ state: "break", since: "2026-10-05T12:00:00Z" });
  });
  it("abgelehnte Buchungen zählen nicht", () => {
    const events = [log("clock_in", "2026-10-05T08:00:00Z"), log("clock_out", "2026-10-05T10:00:00Z", "rejected")];
    expect(currentState(events, now).state).toBe("in");
  });
  it("vergessenes Ausstempeln (> 16 h) gilt als ausgestempelt", () => {
    expect(currentState([log("clock_in", "2026-10-04T20:00:00Z")], now).state).toBe("out");
  });
});

describe("validateAction", () => {
  it("erlaubt die logischen Folgeaktionen", () => {
    expect(validateAction("out", undefined, "clock_in")).toBeNull();
    expect(validateAction("in", undefined, "break_start")).toBeNull();
    expect(validateAction("break", undefined, "break_end")).toBeNull();
    expect(validateAction("in", undefined, "clock_out")).toBeNull();
    expect(validateAction("break", undefined, "clock_out")).toBeNull();
  });
  it("blockiert doppeltes Einstempeln mit Uhrzeit", () => {
    expect(validateAction("in", "2026-10-05T06:57:00Z", "clock_in")).toBe("Du bist bereits eingestempelt (seit 08:57).");
  });
  it("blockiert Pause ohne Einstempeln", () => {
    expect(validateAction("out", undefined, "break_start")).toMatch(/nicht eingestempelt/);
    expect(validateAction("in", undefined, "break_end")).toMatch(/nicht in der Pause/);
  });
});
