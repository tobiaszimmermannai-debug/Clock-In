import { describe, expect, it } from "vitest";
import { berlinToISO } from "./dates";
import { planWarnings } from "./planChecks";

const p = { id: "a", first_name: "Anna", last_name: "A", weekly_target_minutes: 20 * 60 };
const s = (day: string, from: string, to: string, type = "work") => ({ user_id: "a", shift_type: type, starts_at: berlinToISO(day, from), ends_at: berlinToISO(day, to) });

describe("planWarnings", () => {
  it("normale Woche: keine Hinweise", () => {
    expect(planWarnings([s("2026-11-16", "09:00", "15:00"), s("2026-11-17", "09:00", "15:00")], [p])).toEqual([]);
  });
  it("Ruhezeit unter 11 Std.", () => {
    const w = planWarnings([s("2026-11-16", "14:00", "22:00"), s("2026-11-17", "07:00", "12:00")], [p]);
    expect(w).toHaveLength(1);
    expect(w[0]).toContain("9:00 Std. Ruhezeit");
  });
  it("mehr als 10 Std. am Tag (auch geteilt) und über den Wochenstunden", () => {
    const w = planWarnings([s("2026-11-16", "07:00", "13:00"), s("2026-11-16", "15:00", "20:30"), s("2026-11-18", "08:00", "18:00")], [{ ...p, weekly_target_minutes: 18 * 60 }]);
    expect(w.some((x) => x.includes("mehr als 10 Std."))).toBe(true);
    expect(w.some((x) => x.includes("Wochenstunden"))).toBe(true);
  });
  it("Pausen werden abgezogen: 5 × 8 Std. = 37:30 netto bei 40 Wochenstunden → kein Hinweis", () => {
    const week = ["2026-11-16", "2026-11-17", "2026-11-18", "2026-11-19", "2026-11-20"].map((d) => s(d, "08:00", "16:00"));
    expect(planWarnings(week, [{ ...p, weekly_target_minutes: 40 * 60 }], "2026-11-16")).toEqual([]);
    const w = planWarnings(week, [{ ...p, weekly_target_minutes: 35 * 60 }], "2026-11-16");
    expect(w[0]).toContain("37:30 Std. geplant (Mo–So, ohne Pausen) bei 35:00");
  });
  it("nur die Woche Mo–So zählt", () => {
    const shifts = [s("2026-11-15", "08:00", "16:00"), s("2026-11-16", "08:00", "16:00"), s("2026-11-23", "08:00", "16:00")];
    expect(planWarnings(shifts, [{ ...p, weekly_target_minutes: 8 * 60 }], "2026-11-16")).toEqual([]);
  });
  it("Abwesenheiten zählen nicht", () => {
    expect(planWarnings([s("2026-11-16", "00:00", "23:59", "vacation")], [p])).toEqual([]);
  });
});
