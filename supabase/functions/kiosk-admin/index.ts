// Tablet-Konten verwalten – nur für Admins mit 2FA. Aufruf aus der Verwaltung (supabase.functions.invoke).
// JWT-Prüfung bleibt AN: Der Aufrufer muss angemeldet sein; Admin + 2FA prüft am_i_admin() mit seiner Sitzung.
//   { action: "create", username, password, name, location_id }   → Tablet anlegen
//   { action: "set_password", device_id, password }               → Passwort neu setzen
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// Tablets melden sich nur mit Benutzernamen an; intern braucht Supabase eine E-Mail-Form.
// .invalid ist eine reservierte Endung (RFC 2606): Es wird nie eine Mail verschickt.
const KIOSK_EMAIL_DOMAIN = "kiosk.clockin.invalid";
const USERNAME = /^[a-z0-9][a-z0-9_-]{2,30}$/;
const MIN_PASSWORD = 10;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const reply = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  if (req.method !== "POST") return reply(405, { error: "Nur POST erlaubt." });

  // Rechte über die Sitzung des Aufrufers prüfen (inkl. 2FA)
  const caller = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
    auth: { persistSession: false },
  });
  const { data: isAdmin } = await caller.rpc("am_i_admin");
  if (isAdmin !== true) return reply(403, { error: "Nur für Admins mit aktiver 2FA." });

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
  const body = await req.json().catch(() => ({}));
  switch (body.action) {
    case "create":
      return await createTablet(admin, body);
    case "set_password":
      return await setPassword(admin, body);
    default:
      return reply(400, { error: "Unbekannte Aktion." });
  }
});

async function createTablet(admin: SupabaseClient, b: Record<string, unknown>) {
  const username = String(b.username ?? "").trim().toLowerCase();
  if (!USERNAME.test(username)) {
    return reply(400, { error: "Benutzername: 3–31 Zeichen, nur Kleinbuchstaben, Ziffern, - und _." });
  }
  const password = String(b.password ?? "");
  if (password.length < MIN_PASSWORD) return reply(400, { error: `Passwort: mindestens ${MIN_PASSWORD} Zeichen.` });
  const name = String(b.name ?? "").trim() || username;
  const locationId = typeof b.location_id === "string" && b.location_id ? b.location_id : null;

  const { data, error } = await admin.auth.admin.createUser({
    email: `${username}@${KIOSK_EMAIL_DOMAIN}`,
    password,
    email_confirm: true,
    app_metadata: { kiosk: true },
    user_metadata: { username },
  });
  if (error || !data.user) {
    const taken = /already|exists|registered/i.test(error?.message ?? "");
    return reply(400, {
      error: taken
        ? "Dieser Benutzername ist schon vergeben."
        : `Konto konnte nicht angelegt werden: ${error?.message}`,
    });
  }

  const { data: device, error: dbError } = await admin
    .from("kiosk_devices")
    .insert({ auth_user_id: data.user.id, name, location_id: locationId, username })
    .select("id, name, username, location_id, is_active")
    .single();
  if (dbError) {
    await admin.auth.admin.deleteUser(data.user.id); // nichts Halbes zurücklassen
    return reply(400, { error: `Tablet konnte nicht registriert werden: ${dbError.message}` });
  }
  return reply(200, { device });
}

async function setPassword(admin: SupabaseClient, b: Record<string, unknown>) {
  const password = String(b.password ?? "");
  if (password.length < MIN_PASSWORD) return reply(400, { error: `Passwort: mindestens ${MIN_PASSWORD} Zeichen.` });

  const { data: device } = await admin
    .from("kiosk_devices")
    .select("auth_user_id")
    .eq("id", String(b.device_id ?? ""))
    .maybeSingle();
  if (!device) return reply(404, { error: "Tablet nicht gefunden." });

  const { error } = await admin.auth.admin.updateUserById(device.auth_user_id, { password });
  if (error) return reply(400, { error: `Passwort konnte nicht gesetzt werden: ${error.message}` });
  return reply(200, { ok: true });
}
