// Push-Nachrichten aufs Handy (Web-Push). iPhone: erst ab iOS 16.4 und nur, wenn die App auf dem Home-Bildschirm liegt.
import type { SupabaseClient } from "@supabase/supabase-js";

export type PushState = "unsupported" | "ios-install" | "denied" | "off" | "on";

export const isIos = (ua = navigator.userAgent) => /iphone|ipad|ipod/i.test(ua);
const standalone = () =>
  window.matchMedia?.("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
const supported = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

/** VAPID-Schlüssel (base64url) → Bytes für pushManager.subscribe */
export function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const pad = "=".repeat((4 - (base64url.length % 4)) % 4);
  const raw = atob((base64url + pad).replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export async function pushState(): Promise<PushState> {
  if (!supported()) return isIos() && !standalone() ? "ios-install" : "unsupported";
  if (Notification.permission === "denied") return "denied";
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  return sub && Notification.permission === "granted" ? "on" : "off";
}

/** Einschalten: Erlaubnis fragen, abonnieren, in der Datenbank speichern. Rückgabe: Fehlertext oder undefined */
export async function enablePush(db: SupabaseClient): Promise<string | undefined> {
  if (!supported()) return "Dieses Gerät unterstützt keine Push-Nachrichten.";
  const permission = await Notification.requestPermission();
  if (permission !== "granted") return "Benachrichtigungen wurden nicht erlaubt – in den Einstellungen des Handys freigeben.";
  // Schlüssel holen; beim allerersten Mal wird er erst erzeugt → kurz warten und erneut fragen
  let key: string | null = null;
  for (let i = 0; i < 4 && !key; i++) {
    const { data, error } = await db.rpc("push_public_key", { p_origin: location.origin });
    if (error) return "Push ist auf dem Server noch nicht eingerichtet.";
    key = (data as string | null) ?? null;
    if (!key) await new Promise((r) => setTimeout(r, 1500));
  }
  if (!key) return "Push wird gerade eingerichtet – bitte in einer Minute noch einmal versuchen.";
  const reg = await navigator.serviceWorker.ready;
  const old = await reg.pushManager.getSubscription();
  // altes Abo mit anderem Schlüssel ersetzen
  if (old) await old.unsubscribe().catch(() => undefined);
  const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(key) });
  const json = sub.toJSON() as { endpoint: string; keys?: { p256dh?: string; auth?: string } };
  if (!json.keys?.p256dh || !json.keys.auth) return "Push-Abo unvollständig – bitte erneut versuchen.";
  const { error } = await db.rpc("push_subscribe", { p_endpoint: json.endpoint, p_p256dh: json.keys.p256dh, p_auth: json.keys.auth });
  return error ? `Speichern fehlgeschlagen: ${error.message}` : undefined;
}

export async function disablePush(db: SupabaseClient): Promise<void> {
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  if (!sub) return;
  await db.rpc("push_unsubscribe", { p_endpoint: sub.endpoint });
  await sub.unsubscribe().catch(() => undefined);
}
