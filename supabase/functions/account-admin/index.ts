// Zugänge verwalten – nur für Admins mit 2FA. Aufruf aus der Verwaltung (supabase.functions.invoke).
// JWT-Prüfung bleibt AN: Der Aufrufer muss angemeldet sein; Admin + 2FA prüft am_i_admin() mit seiner Sitzung.
//   { action: "create_tablet", username, password, name, location_id }  → Tablet-Konto anlegen
//   { action: "set_tablet_password", device_id, password }              → Tablet-Passwort neu setzen
//   { action: "create_login", user_id, username, password }             → Handy-Zugang für Mitarbeiter
//   { action: "set_login_password", user_id, password }                 → Mitarbeiter-Passwort neu setzen
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// Anmeldung nur mit Benutzernamen; intern braucht Supabase eine E-Mail-Form.
// .invalid ist eine reservierte Endung (RFC 2606): Es wird nie eine Mail verschickt.
const TABLET_DOMAIN = "kiosk.clockin.invalid";
const STAFF_DOMAIN = "team.clockin.invalid";
const TABLET_NAME = /^[a-z0-9][a-z0-9_-]{2,30}$/;
const STAFF_NAME = /^[a-z0-9][a-z0-9._-]{2,30}$/;
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
    case "create_tablet":
      return await createTablet(admin, body);
    case "set_tablet_password":
      return await setTabletPassword(admin, body);
    case "create_login":
      return await createLogin(admin, body);
    case "set_login_password":
      return await setLoginPassword(admin, body);
    default:
      return reply(400, { error: "Unbekannte Aktion." });
  }
});

function checkPassword(b: Record<string, unknown>): string | null {
  return String(b.password ?? "").length < MIN_PASSWORD ? `Passwort: mindestens ${MIN_PASSWORD} Zeichen.` : null;
}

async function createAuthUser(admin: SupabaseClient, email: string, password: string, meta: Record<string, unknown>) {
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    app_metadata: meta,
  });
  if (error || !data.user) {
    const taken = /already|exists|registered/i.test(error?.message ?? "");
    return {
      error: taken
        ? "Dieser Benutzername ist schon vergeben."
        : `Konto konnte nicht angelegt werden: ${error?.message}`,
    };
  }
  return { id: data.user.id };
}

async function createTablet(admin: SupabaseClient, b: Record<string, unknown>) {
  const username = String(b.username ?? "").trim().toLowerCase();
  if (!TABLET_NAME.test(username)) {
    return reply(400, { error: "Benutzername: 3–31 Zeichen, nur Kleinbuchstaben, Ziffern, - und _." });
  }
  const invalid = checkPassword(b);
  if (invalid) return reply(400, { error: invalid });
  const name = String(b.name ?? "").trim() || username;
  const locationId = typeof b.location_id === "string" && b.location_id ? b.location_id : null;

  const auth = await createAuthUser(admin, `${username}@${TABLET_DOMAIN}`, String(b.password), { kiosk: true });
  if (!auth.id) return reply(400, { error: auth.error });

  const { data: device, error } = await admin
    .from("kiosk_devices")
    .insert({ auth_user_id: auth.id, name, location_id: locationId, username })
    .select("id, name, username, location_id, is_active")
    .single();
  if (error) {
    await admin.auth.admin.deleteUser(auth.id); // nichts Halbes zurücklassen
    return reply(400, { error: `Tablet konnte nicht registriert werden: ${error.message}` });
  }
  return reply(200, { device });
}

async function setTabletPassword(admin: SupabaseClient, b: Record<string, unknown>) {
  const invalid = checkPassword(b);
  if (invalid) return reply(400, { error: invalid });
  const { data: device } = await admin
    .from("kiosk_devices")
    .select("auth_user_id")
    .eq("id", String(b.device_id ?? ""))
    .maybeSingle();
  if (!device) return reply(404, { error: "Tablet nicht gefunden." });
  const { error } = await admin.auth.admin.updateUserById(device.auth_user_id, { password: String(b.password) });
  if (error) return reply(400, { error: `Passwort konnte nicht gesetzt werden: ${error.message}` });
  return reply(200, { ok: true });
}

async function createLogin(admin: SupabaseClient, b: Record<string, unknown>) {
  const username = String(b.username ?? "").trim().toLowerCase();
  if (!STAFF_NAME.test(username)) {
    return reply(400, { error: "Benutzername: 3–31 Zeichen, nur Kleinbuchstaben, Ziffern, Punkt, - und _." });
  }
  const invalid = checkPassword(b);
  if (invalid) return reply(400, { error: invalid });

  const { data: person } = await admin
    .from("users")
    .select("id, auth_user_id, is_active")
    .eq("id", String(b.user_id ?? ""))
    .maybeSingle();
  if (!person || !person.is_active) return reply(404, { error: "Mitarbeiter nicht gefunden." });
  if (person.auth_user_id) return reply(400, { error: "Diese Person hat bereits einen Zugang." });

  const auth = await createAuthUser(admin, `${username}@${STAFF_DOMAIN}`, String(b.password), { staff: true });
  if (!auth.id) return reply(400, { error: auth.error });

  const { error } = await admin.from("users").update({ auth_user_id: auth.id, username }).eq("id", person.id);
  if (error) {
    await admin.auth.admin.deleteUser(auth.id);
    const taken = /username/.test(error.message);
    return reply(400, {
      error: taken
        ? "Dieser Benutzername ist schon vergeben."
        : `Zugang konnte nicht verknüpft werden: ${error.message}`,
    });
  }
  return reply(200, { ok: true, username });
}

async function setLoginPassword(admin: SupabaseClient, b: Record<string, unknown>) {
  const invalid = checkPassword(b);
  if (invalid) return reply(400, { error: invalid });
  const { data: person } = await admin
    .from("users")
    .select("auth_user_id")
    .eq("id", String(b.user_id ?? ""))
    .maybeSingle();
  if (!person?.auth_user_id) return reply(404, { error: "Diese Person hat noch keinen Zugang." });
  const { error } = await admin.auth.admin.updateUserById(person.auth_user_id, { password: String(b.password) });
  if (error) return reply(400, { error: `Passwort konnte nicht gesetzt werden: ${error.message}` });
  return reply(200, { ok: true });
}
