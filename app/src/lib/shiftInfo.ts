// Hinweise am Kiosk (Kappung, Toleranz, Überstunden, Pausenregel).
// Verbindlich rechnet die Regel-Engine in der Datenbank (work_day_summary).
import { fmtClock, HOUR, MINUTE } from "./time";
import { DEFAULT_RULES, type EventType, type RuleSettings, type Shift } from "./types";

export type Notice = { tone: "info" | "warn"; text: string };

const hours = (minutes: number) => `${(minutes / 60).toLocaleString("de-DE", { maximumFractionDigits: 2 })} Std.`;

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

export function shiftNotice(
  action: EventType,
  shift: Shift | undefined,
  now: Date,
  opts: { since?: string; rules?: RuleSettings } = {},
): Notice | null {
  const rules = opts.rules ?? DEFAULT_RULES;
  const t = now.getTime();

  switch (action) {
    case "clock_in": {
      if (!shift) {
        return {
          tone: "info",
          text: `Keine Schicht geplant – wird als Aushilfsschicht (${hours(rules.help_shift_minutes)}) im Dienstplan eingetragen.`,
        };
      }
      const start = new Date(shift.starts_at).getTime();
      if (t < start - MINUTE) {
        return { tone: "info", text: `Früh da! Deine Arbeitszeit zählt ab ${fmtClock(shift.starts_at)} (Schichtbeginn).` };
      }
      const late = Math.floor((t - start) / MINUTE);
      if (late > rules.late_tolerance_minutes) {
        return { tone: "warn", text: `Schichtbeginn war ${fmtClock(shift.starts_at)} – ${late} Min. später eingestempelt.` };
      }
      return null;
    }
    case "clock_out": {
      if (!shift) return null;
      const end = new Date(shift.ends_at).getTime();
      const over = Math.floor((t - end) / MINUTE);
      if (over > rules.overtime_threshold_minutes) {
        return {
          tone: "info",
          text: `Schichtende war ${fmtClock(shift.ends_at)}. Die ${over} Min. Überstunden zählen erst nach Freigabe durch Tobias oder Dominik.`,
        };
      }
      if (t < end - MINUTE) return { tone: "info", text: `Geplantes Schichtende: ${fmtClock(shift.ends_at)}.` };
      return null;
    }
    case "break_start":
      return {
        tone: "info",
        text: `Gesetzliche Pause: ab 6 Std. Arbeit 30 Min., ab 9 Std. 45 Min. Jede Pause zählt mindestens ${rules.min_break_minutes} Min.`,
      };
    case "break_end": {
      if (!opts.since) return null;
      const taken = Math.ceil((t - new Date(opts.since).getTime()) / MINUTE);
      if (taken < rules.min_break_minutes) {
        return { tone: "warn", text: `Deine Pause war ${taken} Min. – sie wird mit ${rules.min_break_minutes} Min. berechnet.` };
      }
      return null;
    }
  }
}
