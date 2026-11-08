import { describe, expect, it } from "vitest";
import { ALL_ZERO_TEXT, emptyReport, REPORT_FIELDS, reportProblem } from "./shiftReport";

describe("Ausstempel-Statistik", () => {
  it("hat 10 Felder mit dem vorgegebenen Wortlaut", () => {
    expect(REPORT_FIELDS).toHaveLength(10);
    expect(REPORT_FIELDS.map((f) => f.label)).toContain("Angerufene Wellpassler");
    expect(REPORT_FIELDS.map((f) => f.label)).toContain("Angerufene Interessenten/Leads");
  });
  it("lehnt überall 0 ab, eine Kennzahl genügt", () => {
    expect(reportProblem(emptyReport())).toBe(ALL_ZERO_TEXT);
    expect(reportProblem({ ...emptyReport(), flyers: 3 })).toBeNull();
  });
  it("nur ganze Zahlen ab 0", () => {
    expect(reportProblem({ ...emptyReport(), kvs: -1 })).not.toBeNull();
    expect(reportProblem({ ...emptyReport(), kvs: 1.5 })).not.toBeNull();
  });
});
