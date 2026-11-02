import { afterEach, describe, expect, it, vi } from "vitest";
import { berlinHour, everyWhileVisible } from "./visibility";

describe("berlinHour", () => {
  it("rechnet Sommer- und Winterzeit richtig (UTC → Berlin)", () => {
    expect(berlinHour(new Date("2026-07-01T04:30:00Z"))).toBe(6);
    expect(berlinHour(new Date("2026-12-01T04:30:00Z"))).toBe(5);
    expect(berlinHour(new Date("2026-12-01T23:10:00Z"))).toBe(0);
  });
});

describe("everyWhileVisible", () => {
  // Tests laufen ohne Browser: kleines Ersatz-document mit Sichtbarkeit
  const doc = Object.assign(new EventTarget(), { visibilityState: "visible" as DocumentVisibilityState });
  const setVisibility = (v: DocumentVisibilityState) => {
    doc.visibilityState = v;
    doc.dispatchEvent(new Event("visibilitychange"));
  };
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("pausiert bei verstecktem Tab und lädt beim Zurückkehren sofort", () => {
    vi.useFakeTimers();
    vi.stubGlobal("document", doc);
    const fn = vi.fn();
    const stop = everyWhileVisible(fn, 1000);
    vi.advanceTimersByTime(3000);
    expect(fn).toHaveBeenCalledTimes(3);
    setVisibility("hidden");
    vi.advanceTimersByTime(10_000);
    expect(fn).toHaveBeenCalledTimes(3);
    setVisibility("visible");
    expect(fn).toHaveBeenCalledTimes(4);
    vi.advanceTimersByTime(1000);
    expect(fn).toHaveBeenCalledTimes(5);
    stop();
    vi.advanceTimersByTime(5000);
    expect(fn).toHaveBeenCalledTimes(5);
  });
});
