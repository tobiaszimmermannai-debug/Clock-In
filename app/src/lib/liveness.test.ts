import { describe, expect, it } from "vitest";
import { isCentered, type Point, randomChallenges, sameFace, turnedTo, yaw } from "./liveness";

// Vereinfachtes Gesicht: Augen bei x=40 und x=60 (Abstand 20), Nase bei noseX
function face(noseX: number, scaleX = 1): Point[] {
  const pts: Point[] = Array.from({ length: 68 }, () => ({ x: 50 * scaleX, y: 50 }));
  for (let i = 36; i < 42; i++) pts[i] = { x: 40 * scaleX, y: 40 };
  for (let i = 42; i < 48; i++) pts[i] = { x: 60 * scaleX, y: 40 };
  pts[30] = { x: noseX * scaleX, y: 55 };
  return pts;
}

describe("yaw", () => {
  it("frontal ≈ 0", () => {
    expect(yaw(face(50))).toBeCloseTo(0);
    expect(isCentered(yaw(face(51)))).toBe(true);
  });
  it("Kopf zur linken Seite der Person: Nase im Kamerabild rechts → positiv", () => {
    expect(yaw(face(56))).toBeCloseTo(0.3);
    expect(turnedTo(yaw(face(56)), "left")).toBe(true);
    expect(turnedTo(yaw(face(56)), "right")).toBe(false);
  });
  it("Kopf nach rechts → negativ", () => {
    expect(turnedTo(yaw(face(44)), "right")).toBe(true);
  });
  it("gedrehtes Foto (flach gestaucht) bleibt mittig und besteht die Prüfung nicht", () => {
    const squeezed = yaw(face(50, 0.6));
    expect(isCentered(squeezed)).toBe(true);
    expect(turnedTo(squeezed, "left") || turnedTo(squeezed, "right")).toBe(false);
  });
  it("kleine Drehung reicht nicht", () => {
    expect(turnedTo(yaw(face(53)), "left")).toBe(false);
  });
});

describe("randomChallenges", () => {
  it("liefert zufällige Richtungen", () => {
    const seq = [0.1, 0.9];
    expect(randomChallenges(2, () => seq.shift()!)).toEqual(["left", "right"]);
  });
});

describe("sameFace", () => {
  const box = { x: 100, y: 100, width: 200, height: 200 };
  it("leichte Bewegung = gleiche Person", () => {
    expect(sameFace(box, { x: 140, y: 110, width: 190, height: 190 })).toBe(true);
  });
  it("Sprung oder starke Größenänderung = Austausch", () => {
    expect(sameFace(box, { x: 400, y: 100, width: 200, height: 200 })).toBe(false);
    expect(sameFace(box, { x: 100, y: 100, width: 100, height: 100 })).toBe(false);
  });
});
