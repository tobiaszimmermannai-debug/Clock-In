// Anmeldung per QR-Code (Studioleitung an externen Geräten, z. B. privater PC):
// Nach dem Scan mit dem registrierten Stempel-Handy (qr_login_unlock) holt der Browser hier eine Sitzung.
// Geprüft in qr_login_claim(): Code + Geheimnis dieses Browsers, von einer aktiven Studioleitung bestätigt,
// höchstens 2 Min. alt, nur einmal einlösbar. „Verify JWT“ bleibt AN (der Browser ruft mit dem Anon-Schlüssel auf).
//   { token, secret } → { token_hash }  (Browser: auth.verifyOtp({ type: "magiclink", token_hash }))
import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
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
  const secret = String(body.secret ?? "");
  if (!/^[0-9a-f]{32}$/.test(token) || !/^[0-9a-f]{32}$/.test(secret)) return reply(400, { error: "Ungültiger Code." });

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
  const { data: authId, error } = await admin.rpc("qr_login_claim", { p_token: token, p_secret: secret });
  if (error || !authId) return reply(403, { error: error?.message ?? "Freigabe nicht gültig." });

  // Einmal-Login für genau diese Studioleitung erzeugen (es wird keine Mail verschickt)
  const { data: user, error: userError } = await admin.auth.admin.getUserById(String(authId));
  if (userError || !user.user?.email) return reply(500, { error: "Zugang der Studioleitung nicht gefunden." });
  const { data: link, error: linkError } = await admin.auth.admin.generateLink({ type: "magiclink", email: user.user.email });
  if (linkError || !link.properties?.hashed_token) {
    console.error("generateLink fehlgeschlagen:", linkError?.message);
    return reply(500, { error: "Anmeldung fehlgeschlagen." });
  }
  return reply(200, { token_hash: link.properties.hashed_token });
});
