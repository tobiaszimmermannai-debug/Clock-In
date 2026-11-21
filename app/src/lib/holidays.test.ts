import { describe, expect, it } from "vitest";
import { easter, holidayName, isWorkday, workdaysBetween } from "./holidays";

describe("Feiertage Bayern", () => {
  it("Ostern", () => {
    expect(easter(2024)).toBe("2024-03-31");
    expect(easter(2025)).toBe("2025-04-20");
    expect(easter(2026)).toBe("2026-04-05");
    expect(easter(2027)).toBe("2027-03-28");
  });
  it("bewegliche und feste Feiertage 2026", () => {
    expect(holidayName("2026-04-03")).toBe("Karfreitag");
    expect(holidayName("2026-04-06")).toBe("Ostermontag");
    expect(holidayName("2026-05-14")).toBe("Christi Himmelfahrt");
    expect(holidayName("2026-05-25")).toBe("Pfingstmontag");
    expect(holidayName("2026-06-04")).toBe("Fronleichnam");
    expect(holidayName("2026-08-15")).toBe("Mariä Himmelfahrt");
    expect(holidayName("2026-12-25")).toBe("1. Weihnachtstag");
    expect(holidayName("2026-11-18")).toBeNull(); // Buß- und Bettag: in Bayern kein Feiertag
  });
  it("Soll-Tage ohne Wochenende und Feiertage", () => {
    expect(isWorkday("2026-12-24")).toBe(true);
    expect(isWorkday("2026-12-25")).toBe(false);
    expect(workdaysBetween("2026-12-21", "2026-12-27")).toBe(4); // Mo–Do, Fr = 25.12.
    expect(workdaysBetween("2026-11-16", "2026-11-22")).toBe(5);
  });
});
