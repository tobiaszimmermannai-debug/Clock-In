// Studio-Geräte zentral abmelden: Gerät merkt sich seinen Login-Zeitpunkt und fragt regelmäßig nach (kiosk_logout_check).
import type { SupabaseClient } from "@supabase/supabase-js";

const LOGIN_KEY = "clockin.kioskLoginAt";
export const LOGOUT_CHECK_MS = 60_000;

/** Nach erfolgreicher Geräte-Anmeldung aufrufen */
export function markKioskLogin(now = new Date()) {
  try {
    localStorage.setItem(LOGIN_KEY, now.toISOString());
  } catch {
    /* ohne Speicher: die Datenbank nimmt den Sitzungsbeginn */
  }
}

/** Gemerkter Login-Zeitpunkt (ISO) oder null, wenn unbekannt/ungültig */
export function kioskLoginAt(raw: string | null = readRaw()): string | null {
  if (!raw || Number.isNaN(Date.parse(raw))) return null;
  return new Date(raw).toISOString();
}

export function forgetKioskLogin() {
  try {
    localStorage.removeItem(LOGIN_KEY);
  } catch {
    /* egal */
  }
}

function readRaw(): string | null {
  try {
    return localStorage.getItem(LOGIN_KEY);
  } catch {
    return null;
  }
}

/** true = Admin hat dieses Gerät nach seinem Login abgemeldet. Fehler (z. B. Update noch nicht eingespielt) = false. */
export async function kioskLogoutRequested(db: SupabaseClient): Promise<boolean> {
  const { data, error } = await db.rpc("kiosk_logout_check", { p_since: kioskLoginAt() });
  return !error && data === true;
}
