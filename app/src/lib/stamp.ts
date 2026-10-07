// Stempeln per Handy: QR-Code vom Tablet + registriertes Handy (gleiches WLAN prüft der Server)
import type { WorkState } from "./status";
import { publicAppUrl } from "./config";
import { portalDb } from "./supabase";
import type { EventType } from "./types";

const KEY = "clockin-phone-key";

/** Geräteschlüssel dieses Handys, falls schon vorhanden */
export function existingPhoneKey(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

/** Geräteschlüssel dieses Handys (einmalig zufällig erzeugt, verlässt das Handy nur zur Prüfung) */
export function phoneKey(): string {
  let key = existingPhoneKey();
  if (!key) {
    key = Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, "0")).join("");
    localStorage.setItem(KEY, key);
  }
  return key;
}

export async function sha256Hex(text: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** QR-Inhalt „https://…/#/s/<code>“ (oder nur der Code) → Code */
export function parseToken(text: string): string | null {
  const m = text.trim().match(/^(?:.*#\/s\/)?([0-9a-f]{24})\/?$/i);
  return m ? m[1].toLowerCase() : null;
}

export const stampUrl = (token: string, origin = publicAppUrl()) => `${origin}/#/s/${token}`;

// unverified: anderes Handy/Browser als registriert → Buchung wartet auf Freigabe (pending)
export type StampCheck = { location: string; state: WorkState; since: string | null; registered: boolean; unverified?: boolean };
export type StampResult = { id: string; event_type: EventType; recorded_at: string; location: string; pending?: boolean };

/** Serverfehler: Haupttext + technischer Zusatz in eckigen Klammern (Netz-Adressen) */
export class StampError extends Error {
  detail?: string;
  constructor(message: string) {
    const m = message.match(/^(.*?)\s*\[(.*)\]$/s);
    super(m ? m[1] : message);
    this.detail = m?.[2];
  }
}

async function call<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await portalDb.rpc(fn, { ...args, p_phone_key: phoneKey() });
  if (error) throw new StampError(error.message || "Keine Verbindung.");
  return data as T;
}

export const stampCheck = (token: string) => call<StampCheck>("stamp_check", { p_token: token });
export const stamp = (token: string, event: EventType) => call<StampResult>("stamp", { p_token: token, p_event: event });
