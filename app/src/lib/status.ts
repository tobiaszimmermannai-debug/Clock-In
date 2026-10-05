// Stempelstatus eines Mitarbeiters aus seinen letzten Buchungen ableiten
import { fmtClock, HOUR } from "./time";
import type { EventType, LogEntry } from "./types";

export type WorkState = "out" | "in" | "break";

// Ältere offene Zustände gelten als vergessen (Auto-Checkout übernimmt)
const STALE_AFTER = 16 * HOUR;

const NEXT_STATE: Record<EventType, WorkState> = {
  clock_in: "in",
  break_start: "break",
  break_end: "in",
  clock_out: "out",
};

export function currentState(events: LogEntry[], now: Date): { state: WorkState; since?: string } {
  const last = events
    .filter((e) => e.approval_status !== "rejected")
    .sort((a, b) => a.recorded_at.localeCompare(b.recorded_at))
    .at(-1);
  if (!last || now.getTime() - new Date(last.recorded_at).getTime() > STALE_AFTER) return { state: "out" };
  return { state: NEXT_STATE[last.event_type], since: last.recorded_at };
}

// null = erlaubt, sonst verständliche Begründung für den Kiosk
export function validateAction(state: WorkState, since: string | undefined, action: EventType): string | null {
  const seit = since ? ` (seit ${fmtClock(since)})` : "";
  switch (action) {
    case "clock_in":
      if (state === "in") return `Du bist bereits eingestempelt${seit}.`;
      if (state === "break") return `Du bist gerade in der Pause${seit}. Bitte „Pause Ende“ wählen.`;
      return null;
    case "break_start":
      if (state === "out") return "Du bist nicht eingestempelt. Bitte zuerst „Kommen“ wählen.";
      if (state === "break") return `Du bist bereits in der Pause${seit}.`;
      return null;
    case "break_end":
      if (state !== "break") return "Du bist gerade nicht in der Pause.";
      return null;
    case "clock_out":
      if (state === "out") return "Du bist nicht eingestempelt.";
      return null;
  }
}
