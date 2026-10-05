import { describe, expect, it } from "vitest";
import { identify } from "./match";
import type { RosterEntry } from "./types";

const vec = (fill: number, at = 0, value = fill) => {
  const v = new Array(128).fill(fill);
  v[at] = value;
  return v;
};
const person = (id: string, ...descriptors: number[][]): RosterEntry => ({
  user_id: id,
  first_name: id,
  last_name: "",
  descriptors,
});

describe("identify", () => {
  it("erkennt die nächstgelegene Person unter dem Schwellwert", () => {
    const roster = [person("anna", vec(0)), person("ben", vec(0, 0, 1))];
    expect(identify(vec(0, 0, 0.1), roster)?.entry.user_id).toBe("anna");
  });
  it("lehnt ab, wenn niemand nah genug ist", () => {
    expect(identify(vec(0, 0, 0.9), [person("anna", vec(0))])).toBeNull();
  });
  it("lehnt ab, wenn zwei Personen fast gleich nah sind", () => {
    const roster = [person("anna", vec(0, 0, 0.2)), person("ben", vec(0, 0, -0.2))];
    expect(identify(vec(0), roster)).toBeNull();
  });
  it("nutzt die beste von mehreren Aufnahmen", () => {
    const roster = [person("anna", vec(0, 0, 0.8), vec(0, 0, 0.05))];
    expect(identify(vec(0), roster)?.distance).toBeCloseTo(0.05);
  });
});
