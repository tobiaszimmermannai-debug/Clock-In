import { beforeEach, describe, expect, it } from "vitest";
import { clearPendingReport, pendingReport, reportDraft, savePendingReport, saveReportDraft } from "./pendingReport";

const store = new Map<string, string>();
Object.assign(globalThis, {
  localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v), removeItem: (k: string) => store.delete(k) },
});

describe("pendingReport", () => {
  beforeEach(() => store.clear());

  it("merkt sich die offene Abfrage für die Person", () => {
    savePendingReport("u1", "2026-11-24T16:00:00Z", { kind: "done" });
    expect(pendingReport("u1", Date.parse("2026-11-24T18:00:00Z"))?.done).toEqual({ kind: "done" });
    expect(pendingReport("u2", Date.parse("2026-11-24T18:00:00Z"))).toBeNull();
  });
  it("nach 12 Std. verfällt sie", () => {
    savePendingReport("u1", "2026-11-24T16:00:00Z", {});
    expect(pendingReport("u1", Date.parse("2026-11-25T05:00:00Z"))).toBeNull();
  });
  it("Entwurf bleibt bis zum Speichern", () => {
    saveReportDraft({ trainings: 3 });
    expect(reportDraft()).toEqual({ trainings: 3 });
    clearPendingReport();
    expect(reportDraft()).toBeNull();
  });
});
