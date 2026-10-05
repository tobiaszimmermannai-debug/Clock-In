// Lokaler Offline-Speicher des Tablets (IndexedDB)
import { type DBSchema, type IDBPDatabase, openDB } from "idb";
import type { QueuedEvent } from "./types";

interface KioskDB extends DBSchema {
  queue: { key: string; value: QueuedEvent };   // noch nicht übertragene Buchungen
  failed: { key: string; value: QueuedEvent };  // vom Server dauerhaft abgelehnt
  cache: { key: string; value: unknown };       // Roster, Schichten, Buchungen, Einstellungen
}

let dbPromise: Promise<IDBPDatabase<KioskDB>> | null = null;

function db() {
  dbPromise ??= openDB<KioskDB>("clockin-kiosk", 1, {
    upgrade(d) {
      d.createObjectStore("queue", { keyPath: "client_event_id" });
      d.createObjectStore("failed", { keyPath: "client_event_id" });
      d.createObjectStore("cache");
    },
  });
  return dbPromise;
}

export async function getCache<T>(key: string): Promise<T | undefined> {
  return (await (await db()).get("cache", key)) as T | undefined;
}

export async function setCache(key: string, value: unknown): Promise<void> {
  await (await db()).put("cache", value, key);
}

export async function enqueue(ev: QueuedEvent): Promise<void> {
  await (await db()).put("queue", ev);
}

export async function listQueue(): Promise<QueuedEvent[]> {
  const all = await (await db()).getAll("queue");
  return all.sort((a, b) => a.recorded_at.localeCompare(b.recorded_at));
}

export async function removeFromQueue(id: string): Promise<void> {
  await (await db()).delete("queue", id);
}

export async function moveToFailed(ev: QueuedEvent, error: string): Promise<void> {
  const d = await db();
  const tx = d.transaction(["queue", "failed"], "readwrite");
  await tx.objectStore("failed").put({ ...ev, last_error: error });
  await tx.objectStore("queue").delete(ev.client_event_id);
  await tx.done;
}

export async function countFailed(): Promise<number> {
  return (await db()).count("failed");
}

export async function clearAll(): Promise<void> {
  const d = await db();
  await Promise.all([d.clear("queue"), d.clear("cache")]);
}
