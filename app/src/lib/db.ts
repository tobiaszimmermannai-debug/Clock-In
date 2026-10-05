// Lokaler Speicher des Tablets (IndexedDB): Gerät, Studios, gewähltes Studio
import { type DBSchema, type IDBPDatabase, openDB } from "idb";

interface KioskDB extends DBSchema {
  cache: { key: string; value: unknown };
}

let dbPromise: Promise<IDBPDatabase<KioskDB>> | null = null;

function db() {
  // Version 2: frühere Offline-Warteschlange (Gesichtserkennung) entfällt
  dbPromise ??= openDB<KioskDB>("clockin-kiosk", 2, {
    upgrade(d, oldVersion) {
      const raw = d as unknown as IDBPDatabase;
      if (oldVersion < 1) raw.createObjectStore("cache");
      for (const name of ["queue", "failed"]) if (raw.objectStoreNames.contains(name)) raw.deleteObjectStore(name);
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

export async function clearAll(): Promise<void> {
  await (await db()).clear("cache");
}
