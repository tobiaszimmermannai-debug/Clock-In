import { describe, expect, it } from "vitest";
import { groupReports, periodRange, toCsv, totalRow, type ReportRow } from "./statistics";

const row = (user: string, loc: string, trainings: number, kvs: number): ReportRow => ({
  user_id: user, location_id: loc, created_at: "2026-11-17T18:00:00Z",
  trainings, kvs, pts_given: 0, direct_contacts: 0, vip_contacts: 0, flyers: 0, called_former: 0, called_wellpass: 0, called_leads: 0, pts_booked: 0,
});

describe("Statistik", () => {
  it("Zeiträume", () => {
    expect(periodRange("week", "2026-11-18")).toMatchObject({ from: "2026-11-16", to: "2026-11-23" });
    expect(periodRange("week", "2026-11-18", -1).from).toBe("2026-11-09");
    expect(periodRange("month", "2026-11-18")).toMatchObject({ from: "2026-11-01", to: "2026-12-01", label: "November 2026" });
    expect(periodRange("month", "2026-01-10", -1)).toMatchObject({ from: "2025-12-01", label: "Dezember 2025" });
    expect(periodRange("year", "2026-11-18")).toMatchObject({ from: "2026-01-01", to: "2027-01-01" });
  });
  it("Summen je Person und gesamt, CSV", () => {
    const rows = groupReports([row("a", "l1", 5, 1), row("a", "l1", 3, 0), row("b", "l2", 2, 2)], (r) => r.user_id, (k) => ({ label: k }));
    const a = rows.find((r) => r.key === "a")!;
    expect(a).toMatchObject({ shifts: 2, sum: 9 });
    expect(a.values.trainings).toBe(8);
    expect(totalRow(rows)).toMatchObject({ shifts: 3, sum: 13 });
    expect(toCsv(rows, "Person").split("\r\n")[1]).toBe("a;2;8;1;0;0;0;0;0;0;0;0;9");
  });
});
