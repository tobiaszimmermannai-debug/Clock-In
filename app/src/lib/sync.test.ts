import "fake-indexeddb/auto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it } from "vitest";
import { clearAll, countFailed, enqueue, getCache, listQueue } from "./db";
import { syncQueue } from "./sync";
import type { LogEntry, QueuedEvent } from "./types";

type Row = { client_event_id: string; source: string };
type Err = { code?: string; message: string } | null;

function mockClient(respond: (row: Row) => Err) {
  const calls: Row[] = [];
  const client = {
    from: () => ({
      upsert: async (row: Row) => {
        calls.push(row);
        return { error: respond(row) };
      },
    }),
  } as unknown as SupabaseClient;
  return { client, calls };
}

const now = new Date("2026-10-05T10:00:00Z");
const event = (minutesAgo: number): QueuedEvent => ({
  client_event_id: crypto.randomUUID(),
  user_id: "u1",
  location_id: "l1",
  event_type: "clock_in",
  recorded_at: new Date(now.getTime() - minutesAgo * 60_000).toISOString(),
  kiosk_device_id: "k1",
  match_distance: 0.3,
});

beforeEach(async () => {
  await clearAll();
});

describe("syncQueue", () => {
  it("frische Buchung geht als Live-Buchung raus und landet im Status-Cache", async () => {
    const ev = event(0);
    await enqueue(ev);
    const { client, calls } = mockClient(() => null);
    const r = await syncQueue(client, () => now);
    expect(calls.map((c) => c.source)).toEqual(["kiosk"]);
    expect(r).toMatchObject({ sent: 1, remaining: 0, offline: false });
    expect(await listQueue()).toHaveLength(0);
    expect((await getCache<LogEntry[]>("logs"))?.map((l) => l.client_event_id)).toContain(ev.client_event_id);
  });

  it("ältere Buchung wird als Offline-Nachsync gesendet", async () => {
    await enqueue(event(45));
    const { client, calls } = mockClient(() => null);
    await syncQueue(client, () => now);
    expect(calls[0].source).toBe("offline_sync");
  });

  it("lehnt der Server die Live-Buchung ab (Uhr falsch), wird als Nachsync erneut gesendet", async () => {
    await enqueue(event(0));
    const { client, calls } = mockClient((row) =>
      row.source === "kiosk" ? { code: "42501", message: "new row violates row-level security policy" } : null,
    );
    const r = await syncQueue(client, () => now);
    expect(calls.map((c) => c.source)).toEqual(["kiosk", "offline_sync"]);
    expect(r.sent).toBe(1);
  });

  it("dauerhafte Ablehnung → Fehlerablage statt Endlosschleife", async () => {
    const before = await countFailed();
    await enqueue(event(30));
    const { client } = mockClient(() => ({ code: "42501", message: "rls" }));
    const r = await syncQueue(client, () => now);
    expect(r.failed).toBe(1);
    expect(await countFailed()).toBe(before + 1);
    expect(await listQueue()).toHaveLength(0);
  });

  it("ohne Netz bleibt alles in der Warteschlange (Reihenfolge bleibt erhalten)", async () => {
    await enqueue(event(20));
    await enqueue(event(10));
    const { client, calls } = mockClient(() => ({ code: "", message: "TypeError: Failed to fetch" }));
    const r = await syncQueue(client, () => now);
    expect(r).toMatchObject({ sent: 0, offline: true, remaining: 2 });
    expect(calls).toHaveLength(1);
    expect(await listQueue()).toHaveLength(2);
  });
});
