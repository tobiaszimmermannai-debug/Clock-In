export type EventType = "clock_in" | "break_start" | "break_end" | "clock_out";
export type Role = "admin" | "manager" | "employee" | "trainee";

export const EVENT_LABEL: Record<EventType, string> = {
  clock_in: "Kommen",
  break_start: "Pause Start",
  break_end: "Pause Ende",
  clock_out: "Gehen",
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
  shift_type: "work" | "vocational_school" | "vacation" | "sick";
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
