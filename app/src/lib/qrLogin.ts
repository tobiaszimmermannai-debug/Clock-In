// Anmeldung per QR-Code (Studioleitung an externen Geräten): Link im QR-Code und Prüfung der Sitzungsart
import type { Session } from "@supabase/supabase-js";
import { publicAppUrl } from "./config";

export const qrLoginUrl = (token: string, origin = publicAppUrl()) => `${origin}/#/q/${token}`;

/** QR-Inhalt „https://…/#/q/<code>“ → Code */
export function parseQrLoginToken(text: string): string | null {
  const m = text.trim().match(/#\/q\/([0-9a-f]{32})\/?$/i);
  return m ? m[1].toLowerCase() : null;
}

/** Sitzungsdauer einer QR-Anmeldung, danach erneut scannen */
export const QR_SESSION_HOURS = 12;

type Amr = { method?: string; timestamp?: number };

/** Anmeldearten der Sitzung (aus dem Zugangstoken) */
export function sessionMethods(session: Session | null): Amr[] {
  const token = session?.access_token;
  if (!token) return [];
  try {
    const part = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    const payload = JSON.parse(atob(part.padEnd(Math.ceil(part.length / 4) * 4, "="))) as { amr?: Amr[] };
    return Array.isArray(payload.amr) ? payload.amr : [];
  } catch {
    return [];
  }
}

/** Wurde diese Sitzung per QR-Code (Einmal-Link) angemeldet – und ist sie noch frisch genug? */
export function isQrSession(session: Session | null, now = Date.now()): boolean {
  const qr = sessionMethods(session).find((a) => a.method === "otp" || a.method === "magiclink");
  if (!qr) return false;
  return !qr.timestamp || now / 1000 - qr.timestamp < QR_SESSION_HOURS * 3600;
}
