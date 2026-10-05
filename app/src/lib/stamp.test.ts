import { describe, expect, it } from "vitest";
import { StampError, parseToken, stampUrl } from "./stamp";

describe("QR-Code vom Tablet", () => {
  const code = "0123456789abcdef01234567";

  it("liest Link aus der Kamera-App und reinen Code", () => {
    expect(parseToken(stampUrl(code, "https://clock-in.example"))).toBe(code);
    expect(parseToken(`https://x.app/#/s/${code.toUpperCase()}`)).toBe(code);
    expect(parseToken(code)).toBe(code);
  });

  it("lehnt fremde QR-Codes ab", () => {
    expect(parseToken("https://example.com/menu")).toBeNull();
    expect(parseToken("WIFI:S:Studio;T:WPA;P:geheim;;")).toBeNull();
    expect(parseToken(`${code}ff`)).toBeNull();
  });
});

describe("Fehlermeldungen beim Stempeln", () => {
  it("trennt Netz-Adressen als Zusatz ab", () => {
    const e = new StampError("Dein Handy ist nicht im WLAN des Studios. [Handy 1.2.3.4, Tablet 5.6.7.8]");
    expect(e.message).toBe("Dein Handy ist nicht im WLAN des Studios.");
    expect(e.detail).toBe("Handy 1.2.3.4, Tablet 5.6.7.8");
    expect(new StampError("QR-Code abgelaufen").detail).toBeUndefined();
  });
});
