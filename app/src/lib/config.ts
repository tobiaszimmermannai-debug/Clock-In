// Tablets melden sich nur mit Benutzernamen an; intern braucht Supabase eine E-Mail-Form.
// Muss zur Edge Function kiosk-admin passen.
export const KIOSK_EMAIL_DOMAIN = "kiosk.clockin.invalid";

export const kioskLoginEmail = (login: string) => {
  const value = login.trim();
  return value.includes("@") ? value : `${value.toLowerCase()}@${KIOSK_EMAIL_DOMAIN}`;
};

// Arbeitgeber und Verantwortlicher im Sinne der DSGVO (Einwilligungstext)
export const COMPANY = {
  name: "BS New Fitness GmbH",
  address: "Gautinger Straße 19, 82152 Krailling",
};
