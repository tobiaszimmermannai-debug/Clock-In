import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

export const isConfigured = Boolean(url && key);

// Getrennte Sitzungen: Das Tablet bleibt als Kiosk angemeldet, während sich
// eine Leitung/Admin auf demselben Gerät anmeldet (z. B. zum Gesicht erfassen).
function client(storageKey: string): SupabaseClient {
  return createClient(url ?? "http://localhost", key ?? "missing", {
    auth: { storageKey, persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
  });
}

export const kioskDb = client("clockin-kiosk");
export const adminDb = client("clockin-admin");
