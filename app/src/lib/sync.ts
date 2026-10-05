// Abgleich Tablet ↔ Supabase: Warteschlange senden, Stammdaten-Cache auffrischen
import type { SupabaseClient } from "@supabase/supabase-js";
import { getCache, listQueue, moveToFailed, removeFromQueue, setCache } from "./db";
import { HOUR, MINUTE } from "./time";
import type { LogEntry, QueuedEvent, RosterEntry, Shift } from "./types";

// Jünger als das gilt eine Buchung als live (Server erlaubt ±5 Min.)
const LIVE_WINDOW = 3 * MINUTE;

type PgError = { code?: string; message: string } | null;

// SQLSTATE-Codes (z. B. 42501 RLS, 23514 Check) = dauerhafte Ablehnung.
// Alles andere (Netz, abgelaufenes Token) = später erneut versuchen.
export const isPermanent = (e: NonNullable<PgError>) => /^[0-9A-Z]{5}$/.test(e.code ?? "");

async function send(client: SupabaseClient, ev: QueuedEvent, source: "kiosk" | "offline_sync"): Promise<PgError> {
  const { error } = await client.from("time_logs").upsert(
    {
      client_event_id: ev.client_event_id,
      user_id: ev.user_id,
      location_id: ev.location_id,
      event_type: ev.event_type,
      recorded_at: ev.recorded_at,
      source,
      kiosk_device_id: ev.kiosk_device_id,
      match_distance: ev.match_distance,
    },
    { onConflict: "client_event_id", ignoreDuplicates: true },
  );
  return error;
}

export type SyncResult = { sent: number; failed: number; remaining: number; offline: boolean };

export async function syncQueue(client: SupabaseClient, now: () => Date = () => new Date()): Promise<SyncResult> {
  const queue = await listQueue();
  const result: SyncResult = { sent: 0, failed: 0, remaining: queue.length, offline: false };

  for (const ev of queue) {
    const live = now().getTime() - new Date(ev.recorded_at).getTime() < LIVE_WINDOW;
    let error = await send(client, ev, live ? "kiosk" : "offline_sync");
    // z. B. Tablet-Uhr geht falsch → als Nachsync erneut senden
    if (error && live && isPermanent(error)) error = await send(client, ev, "offline_sync");

    if (!error) {
      await removeFromQueue(ev.client_event_id);
      await rememberLog(ev);
      result.sent++;
    } else if (isPermanent(error)) {
      await moveToFailed(ev, error.message);
      result.failed++;
    } else {
      result.offline = true;
      break;
    }
    result.remaining--;
  }
  return result;
}

// Gesendete Buchung sofort im lokalen Status-Cache vermerken
async function rememberLog(ev: QueuedEvent) {
  const logs = (await getCache<LogEntry[]>("logs")) ?? [];
  if (logs.some((l) => l.client_event_id === ev.client_event_id)) return;
  logs.push({
    client_event_id: ev.client_event_id,
    user_id: ev.user_id,
    event_type: ev.event_type,
    recorded_at: ev.recorded_at,
  });
  await setCache("logs", logs);
}

// Stammdaten für den Offline-Betrieb laden; bei Fehlern bleibt der alte Stand
export async function refreshCaches(client: SupabaseClient): Promise<boolean> {
  const now = Date.now();
  const [roster, shifts, logs, locations, rules] = await Promise.all([
    client.rpc("kiosk_roster"),
    client
      .from("shifts")
      .select("id, user_id, location_id, shift_type, starts_at, ends_at")
      .gte("starts_at", new Date(now - 24 * HOUR).toISOString())
      .lte("starts_at", new Date(now + 24 * HOUR).toISOString()),
    client
      .from("time_logs")
      .select("client_event_id, user_id, event_type, recorded_at, approval_status")
      .gte("recorded_at", new Date(now - 36 * HOUR).toISOString()),
    client.from("locations").select("id, code, name").eq("is_active", true).order("name"),
    client
      .from("rule_settings")
      .select("late_tolerance_minutes, overtime_threshold_minutes, min_break_minutes, help_shift_minutes")
      .maybeSingle(),
  ]);

  if (!roster.error) await setCache("roster", roster.data as RosterEntry[]);
  if (!shifts.error) await setCache("shifts", shifts.data as Shift[]);
  if (!logs.error) await setCache("logs", logs.data as LogEntry[]);
  if (!locations.error) await setCache("locations", locations.data);
  if (!rules.error && rules.data) await setCache("rules", rules.data);
  if (!roster.error) await setCache("lastRefresh", new Date().toISOString());
  return !(roster.error || shifts.error || logs.error || locations.error);
}
