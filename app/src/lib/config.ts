// Tablets melden sich nur mit Benutzernamen an; intern braucht Supabase eine E-Mail-Form.
// Muss zur Edge Function kiosk-admin passen.
export const KIOSK_EMAIL_DOMAIN = "kiosk.clockin.invalid";

export const kioskLoginEmail = (login: string) => {
  const value = login.trim();
  return value.includes("@") ? value : `${value.toLowerCase()}@${KIOSK_EMAIL_DOMAIN}`;
};

// Mitarbeiter-Zugänge (Handy-Portal): Benutzername → <name>@team.clockin.invalid
export const STAFF_EMAIL_DOMAIN = "team.clockin.invalid";

export const staffLoginEmail = (login: string) => {
  const value = login.trim();
  return value.includes("@") ? value : `${value.toLowerCase()}@${STAFF_EMAIL_DOMAIN}`;
};

// Arbeitgeber und Verantwortlicher im Sinne der DSGVO (Einwilligungstext)
export const COMPANY = {
  name: "BS New Fitness GmbH",
  address: "Gautinger Straße 19, 82152 Krailling",
};

// Hauptadresse der App. Der QR-Code am Tablet führt immer hierhin – so landen alle Handys auf derselben
// Adresse (der Handy-Schlüssel liegt im Browser-Speicher dieser Adresse). Eigene Domain: VITE_PUBLIC_URL setzen.
export const PRODUCTION_URL = "https://clock-in-app-rho.vercel.app";

export function publicAppUrl(origin = location.origin): string {
  const configured = (import.meta.env.VITE_PUBLIC_URL as string | undefined)?.replace(/\/+$/, "");
  if (configured) return configured;
  // Vorschau-/Deployment-Adressen von Vercel → Hauptadresse; lokal (Entwicklung/Tests) die eigene Adresse
  return /\.vercel\.app$/i.test(new URL(origin).hostname) ? PRODUCTION_URL : origin;
}
