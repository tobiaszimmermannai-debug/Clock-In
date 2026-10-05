// Edge Function "account-admin" (Tablets und Mitarbeiter-Zugänge, nur Admin mit 2FA)
import { adminDb } from "./supabase";

export async function accountAdmin(body: Record<string, unknown>) {
  const { data, error } = await adminDb.functions.invoke("account-admin", { body });
  if (error) {
    let message = error.message;
    try {
      const json = await (error as { context?: Response }).context?.json();
      if (json?.error) message = json.error;
    } catch {
      // Antwort ohne JSON – Standardmeldung behalten
    }
    throw new Error(message);
  }
  return data;
}

// Gut abtippbar: ohne 0/O, 1/l/I
export function generatePassword(length = 12): string {
  const alphabet = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint32Array(length));
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}

// Vorschlag Benutzername: "vorname.nachname" ohne Umlaute/Sonderzeichen
export function suggestUsername(first: string, last: string): string {
  const clean = (s: string) =>
    s.toLowerCase()
      .replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/ß/g, "ss")
      .normalize("NFD").replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "");
  return `${clean(first)}.${clean(last)}`.slice(0, 31).replace(/^\.|\.$/g, "");
}
