// Schichtplanung am Studio-PC: Nach dem QR-Scan der Studioleitung (pc_plan_unlock auf ihrem Handy) holt der PC
// hier eine Sitzung dieser Studioleitung – nur für die Planung, die App meldet sie nach 5 Min. ohne Bedienung ab.
// JWT-Prüfung bleibt AN: Aufrufer ist der angemeldete Studio-PC. Die Freigabe prüft pc_plan_claim()
// (Code dieses PCs, von einer aktiven Studioleitung mit registriertem Stempel-Handy, höchstens 2 Min. alt,
// nur einmal einlösbar).
//   { token } → { token_hash }  (PC: auth.verifyOtp({ type: "magiclink", token_hash }))
import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

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

  const body = await req.json().catch(() => ({}));
  const token = String(body.token ?? "");
  if (!/^[0-9a-f]{32}$/.test(token)) return reply(400, { error: "Ungültiger Code." });

  // Freigabe mit der Sitzung des PCs einlösen
  const pc = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
    auth: { persistSession: false },
  });
  const { data: claim, error } = await pc.rpc("pc_plan_claim", { p_token: token });
  if (error || !claim?.auth_user_id) return reply(403, { error: error?.message ?? "Freigabe nicht gültig." });

  // Einmal-Login für genau diese Studioleitung erzeugen (es wird keine Mail verschickt)
  const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
  const { data: user, error: userError } = await admin.auth.admin.getUserById(claim.auth_user_id);
  if (userError || !user.user?.email) return reply(500, { error: "Zugang der Studioleitung nicht gefunden." });
  const { data: link, error: linkError } = await admin.auth.admin.generateLink({ type: "magiclink", email: user.user.email });
  if (linkError || !link.properties?.hashed_token) {
    console.error("generateLink fehlgeschlagen:", linkError?.message);
    return reply(500, { error: "Anmeldung für die Planung fehlgeschlagen." });
  }
  return reply(200, { token_hash: link.properties.hashed_token, home_location_id: claim.home_location_id });
});
