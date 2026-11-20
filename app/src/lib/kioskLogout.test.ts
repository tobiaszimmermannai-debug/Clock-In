import { beforeEach, describe, expect, it } from "vitest";
import { forgetKioskLogin, kioskLoginAt, markKioskLogin } from "./kioskLogout";

// Testumgebung ohne Browser: einfacher Speicher
const store = new Map<string, string>();
Object.assign(globalThis, {
  localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v), removeItem: (k: string) => store.delete(k) },
});

describe("kioskLogout", () => {
  beforeEach(() => forgetKioskLogin());

  it("merkt sich den Login-Zeitpunkt", () => {
    markKioskLogin(new Date("2026-11-20T10:00:00Z"));
    expect(kioskLoginAt()).toBe("2026-11-20T10:00:00.000Z");
  });

  it("unbekannt oder ungültig → null", () => {
    expect(kioskLoginAt()).toBeNull();
    expect(kioskLoginAt("kein Datum")).toBeNull();
  });
});
