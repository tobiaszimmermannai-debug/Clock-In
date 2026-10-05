// Lebenderkennung (Foto-Schutz) per zufälliger Kopfdrehung.
// Ein Foto ist flach: Dreht man es, bleibt die Nase mittig zwischen den Augen.
// Bei einem echten Kopf wandert die Nasenspitze deutlich zur Seite.
export type Point = { x: number; y: number };
export type Box = { x: number; y: number; width: number; height: number };
export type Direction = "left" | "right";

// Anteil des Augenabstands, um den die Nase seitlich wandern muss (≈ 20–25° Drehung)
export const TURN_THRESHOLD = 0.2;
// "Geradeaus" für Identifikation und Abschluss
export const CENTER_THRESHOLD = 0.08;

const mean = (pts: Point[]): Point => ({
  x: pts.reduce((s, p) => s + p.x, 0) / pts.length,
  y: pts.reduce((s, p) => s + p.y, 0) / pts.length,
});

// 68-Punkte-Modell: 36–41 und 42–47 = Augen, 30 = Nasenspitze (Koordinaten des ungespiegelten Kamerabilds)
export function yaw(landmarks: Point[]): number {
  const eyeA = mean(landmarks.slice(36, 42));
  const eyeB = mean(landmarks.slice(42, 48));
  const eyeDistance = Math.hypot(eyeB.x - eyeA.x, eyeB.y - eyeA.y);
  if (eyeDistance === 0) return 0;
  return (landmarks[30].x - (eyeA.x + eyeB.x) / 2) / eyeDistance;
}

// Dreht die Person den Kopf nach IHRER linken Seite, wandert die Nase im (ungespiegelten)
// Kamerabild nach rechts → positiver Wert. Die Vorschau ist gespiegelt, der Pfeil ← passt also.
export function turnedTo(yawValue: number, dir: Direction): boolean {
  return dir === "left" ? yawValue > TURN_THRESHOLD : yawValue < -TURN_THRESHOLD;
}

export const isCentered = (yawValue: number) => Math.abs(yawValue) < CENTER_THRESHOLD;

export function randomChallenges(count: number, random: () => number = Math.random): Direction[] {
  return Array.from({ length: count }, () => (random() < 0.5 ? "left" : "right"));
}

// Gleiches Gesicht wie im vorigen Bild? (verhindert Austausch während der Prüfung)
export function sameFace(prev: Box, next: Box): boolean {
  const shift = Math.hypot(next.x + next.width / 2 - (prev.x + prev.width / 2), next.y + next.height / 2 - (prev.y + prev.height / 2));
  const sizeRatio = next.width / prev.width;
  return shift < prev.width * 0.6 && sizeRatio > 0.7 && sizeRatio < 1.4;
}
