// Hinweis am Kiosk zur Schicht (Kappung). Verbindlich rechnet die Regel-Engine in der Datenbank.
import { fmtClock, HOUR, MINUTE } from "./time";
import type { EventType, Shift } from "./types";

export type Notice = { tone: "info" | "warn"; text: string };

const TOLERANCE = MINUTE;

// Arbeitsschicht, die zum Zeitpunkt passt (±3 h um die Schicht)
export function relevantShift(shifts: Shift[], userId: string, now: Date): Shift | undefined {
  const t = now.getTime();
  return shifts
    .filter((s) => s.user_id === userId && s.shift_type === "work")
    .filter((s) => t >= new Date(s.starts_at).getTime() - 3 * HOUR && t <= new Date(s.ends_at).getTime() + 3 * HOUR)
    .sort((a, b) =>
      Math.abs(new Date(a.starts_at).getTime() - t) - Math.abs(new Date(b.starts_at).getTime() - t)
    )[0];
}

export function shiftNotice(action: EventType, shift: Shift | undefined, now: Date): Notice | null {
  const t = now.getTime();
  if (action === "clock_in") {
    if (!shift) return { tone: "warn", text: "Für jetzt ist keine Schicht geplant. Die Buchung wird trotzdem gespeichert." };
    const start = new Date(shift.starts_at).getTime();
    if (t < start - TOLERANCE) {
      return { tone: "info", text: `Früh da! Deine Arbeitszeit zählt ab ${fmtClock(shift.starts_at)} (Schichtbeginn).` };
    }
    if (t > start + TOLERANCE) {
      const late = Math.round((t - start) / MINUTE);
      return { tone: "warn", text: `Schichtbeginn war ${fmtClock(shift.starts_at)} – ${late} Min. später eingestempelt.` };
    }
    return null;
  }
  if (action === "clock_out" && shift) {
    const end = new Date(shift.ends_at).getTime();
    if (t > end + TOLERANCE) {
      return { tone: "info", text: `Schichtende war ${fmtClock(shift.ends_at)}. Gezählt wird bis Schichtende.` };
    }
    if (t < end - TOLERANCE) return { tone: "info", text: `Geplantes Schichtende: ${fmtClock(shift.ends_at)}.` };
  }
  return null;
}
