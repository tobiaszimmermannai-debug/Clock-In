import { describe, expect, it } from "vitest";
import { registerStudios, studioCode, studioColor } from "./studios";

describe("Studios", () => {
  it("Kürzel aus dem Namen (2–10 Großbuchstaben)", () => {
    expect(studioCode("Fürstenfeldbruck")).toBe("FUERSTENFE");
    expect(studioCode("Bad Tölz")).toBe("BADTOELZ");
    expect(studioCode("Ö")).toBe("OE");
  });

  it("feste Farben je Studio, grau ohne Studio", () => {
    registerStudios([
      { id: "a", code: "STARNBERG", name: "Studio Starnberg" },
      { id: "b", code: "NEUSTADT", name: "Studio Neustadt" },
    ]);
    expect(studioColor("a")).toBe("#1d4ed8");
    expect(studioColor("b")).toMatch(/^#[0-9a-f]{6}$/);
    expect(studioColor(null)).toBe("#64748b");
  });
});
