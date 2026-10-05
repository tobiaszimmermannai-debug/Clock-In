// Datenhaltung des Kiosks: Cache laden, regelmäßig synchronisieren, Buchungen anlegen
import { useCallback, useEffect, useState } from "react";
import { countFailed, enqueue, getCache, listQueue } from "../lib/db";
import { currentState } from "../lib/status";
import { kioskDb } from "../lib/supabase";
import { refreshCaches, syncQueue } from "../lib/sync";
import { MINUTE } from "../lib/time";
import type { EventType, KioskDevice, Location, LogEntry, QueuedEvent, RosterEntry, Shift } from "../lib/types";

export type KioskSession = { device: KioskDevice; location: Location };

const SYNC_EVERY = 30_000;
const REFRESH_EVERY = 5 * MINUTE;

export function useKiosk(session: KioskSession) {
  const [roster, setRoster] = useState<RosterEntry[]>([]);
  const [shifts, setShifts] = useState<Shift[]>([]);
  const [pending, setPending] = useState(0);
  const [failed, setFailed] = useState(0);
  const [online, setOnline] = useState(navigator.onLine);
  const [lastRefresh, setLastRefresh] = useState<string | undefined>();

  const loadCache = useCallback(async () => {
    setRoster((await getCache<RosterEntry[]>("roster")) ?? []);
    setShifts((await getCache<Shift[]>("shifts")) ?? []);
    setLastRefresh(await getCache<string>("lastRefresh"));
    setPending((await listQueue()).length);
    setFailed(await countFailed());
  }, []);

  const sync = useCallback(async () => {
    const result = await syncQueue(kioskDb);
    setOnline(!result.offline && navigator.onLine);
    await loadCache();
  }, [loadCache]);

  const refresh = useCallback(async () => {
    const ok = await refreshCaches(kioskDb);
    setOnline(ok && navigator.onLine);
    await loadCache();
  }, [loadCache]);

  useEffect(() => {
    void loadCache().then(refresh).then(sync);
    const syncTimer = setInterval(sync, SYNC_EVERY);
    const refreshTimer = setInterval(refresh, REFRESH_EVERY);
    const goOnline = () => void refresh().then(sync);
    const goOffline = () => setOnline(false);
    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);
    return () => {
      clearInterval(syncTimer);
      clearInterval(refreshTimer);
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
    };
  }, [loadCache, refresh, sync]);

  // Status aus Server-Buchungen + noch nicht gesendeter Warteschlange
  const stateOf = useCallback(async (userId: string, now: Date) => {
    const logs = (await getCache<LogEntry[]>("logs")) ?? [];
    const queued = await listQueue();
    const seen = new Set(logs.map((l) => l.client_event_id));
    const events = [...logs, ...queued.filter((q) => !seen.has(q.client_event_id))].filter(
      (e) => e.user_id === userId,
    );
    return currentState(events, now);
  }, []);

  const book = useCallback(
    async (userId: string, action: EventType, distance: number, at: Date): Promise<QueuedEvent> => {
      const ev: QueuedEvent = {
        client_event_id: crypto.randomUUID(),
        user_id: userId,
        location_id: session.location.id,
        event_type: action,
        recorded_at: at.toISOString(),
        kiosk_device_id: session.device.id,
        match_distance: Math.round(distance * 1000) / 1000,
      };
      await enqueue(ev);
      setPending((n) => n + 1);
      void sync();
      return ev;
    },
    [session, sync],
  );

  return { roster, shifts, pending, failed, online, lastRefresh, stateOf, book, refresh };
}
