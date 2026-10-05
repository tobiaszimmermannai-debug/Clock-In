// Tablets melden sich nur mit Benutzernamen an; intern braucht Supabase eine E-Mail-Form.
// Muss zur Edge Function kiosk-admin passen.
export const KIOSK_EMAIL_DOMAIN = "kiosk.clockin.invalid";

export const kioskLoginEmail = (login: string) => {
  const value = login.trim();
  return value.includes("@") ? value : `${value.toLowerCase()}@${KIOSK_EMAIL_DOMAIN}`;
};

// Arbeitgeber (Verantwortlicher) für den Einwilligungstext
export const COMPANY_NAME = ((import.meta.env.VITE_COMPANY_NAME as string | undefined) ?? "").trim();
