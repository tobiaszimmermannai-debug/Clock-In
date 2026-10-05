export type EventType = "clock_in" | "break_start" | "break_end" | "clock_out";
export type Role = "admin" | "manager" | "employee" | "trainee";

export const EVENT_LABEL: Record<EventType, string> = {
  clock_in: "Kommen",
  break_start: "Pause Start",
  break_end: "Pause Ende",
  clock_out: "Gehen",
};

export type ShiftType = "work" | "vocational_school" | "vacation" | "sick";

export const SHIFT_TYPE_LABEL: Record<ShiftType, string> = {
  work: "Schicht",
  vocational_school: "IST",
  vacation: "Urlaub",
  sick: "Krank",
};

// Regel-Werte aus rule_settings (durch Admins änderbar)
export type RuleSettings = {
  late_tolerance_minutes: number;
  overtime_threshold_minutes: number;
  min_break_minutes: number;
  help_shift_minutes: number;
};

export const DEFAULT_RULES: RuleSettings = {
  late_tolerance_minutes: 5,
  overtime_threshold_minutes: 5,
  min_break_minutes: 15,
  help_shift_minutes: 390,
};

export type Location = { id: string; code: string; name: string };

export type KioskDevice = { id: string; name: string; location_id: string | null };

// Aktive Mitarbeiter inkl. Gesichts-Embeddings (RPC kiosk_roster)
export type RosterEntry = {
  user_id: string;
  first_name: string;
  last_name: string;
  descriptors: number[][];
};

export type Shift = {
  id: string;
  user_id: string;
  location_id: string | null;
  shift_type: ShiftType;
  starts_at: string;
  ends_at: string;
};

// Buchung für die Statusberechnung (vom Server oder noch in der Warteschlange)
export type LogEntry = {
  client_event_id: string;
  user_id: string;
  event_type: EventType;
  recorded_at: string;
  approval_status?: "approved" | "pending" | "rejected";
};

// Buchung in der Offline-Warteschlange (IndexedDB)
export type QueuedEvent = {
  client_event_id: string;
  user_id: string;
  location_id: string;
  event_type: EventType;
  recorded_at: string;
  kiosk_device_id: string;
  match_distance: number | null;
  last_error?: string;
};

/** "Studio Krailling" → "Krailling" */
export const studioShort = (name: string) => name.replace(/^Studio\s+/, "");

export const ROLE_LABEL: Record<Role, string> = {
  admin: "Admin",
  manager: "Studioleitung",
  employee: "Mitarbeiter",
  trainee: "Azubi",
};
