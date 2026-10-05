// Gemeinsame Helfer für die Telegram-Edge-Functions
import { createClient } from "npm:@supabase/supabase-js@2";

const BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";

// Service-Role-Client: umgeht RLS, daher nur serverseitig in Edge Functions
export const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);

export type InlineButton = { text: string; callback_data: string };

// Aufruf der Telegram Bot API; Fehler werden geloggt, nicht geworfen
export async function tg(method: string, payload: Record<string, unknown>) {
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({ ok: false, description: res.statusText }));
  if (!data.ok) console.error(`Telegram ${method} fehlgeschlagen:`, data.description);
  return data;
}

export function sendMessage(chatId: number, html: string, buttons?: InlineButton[]) {
  return tg("sendMessage", {
    chat_id: chatId,
    text: html,
    parse_mode: "HTML",
    ...(buttons ? { reply_markup: { inline_keyboard: [buttons] } } : {}),
  });
}

export const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const dateTimeFmt = new Intl.DateTimeFormat("de-DE", {
  timeZone: "Europe/Berlin",
  weekday: "short",
  day: "2-digit",
  month: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});
const clockFmt = new Intl.DateTimeFormat("de-DE", {
  timeZone: "Europe/Berlin",
  hour: "2-digit",
  minute: "2-digit",
});
export const formatDateTime = (iso: string) => dateTimeFmt.format(new Date(iso));
export const formatClock = (iso: string) => clockFmt.format(new Date(iso));

// Secret-Vergleich in konstanter Zeit
export function safeEqual(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  if (x.length !== y.length || x.length === 0) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

export type Person = { first_name: string; last_name: string };
export const fullName = (p: Person | null) => (p ? `${p.first_name} ${p.last_name}` : "Unbekannt");

// Aktiver Admin zu einem Telegram-Account (privater Chat: chat_id = User-ID)
export async function findAdminByTelegramId(telegramUserId: number) {
  const { data, error } = await supabase
    .from("telegram_links")
    .select("user_id, user:users!inner(first_name, last_name, role, is_active)")
    .eq("chat_id", telegramUserId)
    .eq("user.role", "admin")
    .eq("user.is_active", true)
    .maybeSingle();
  if (error) console.error("Admin-Lookup fehlgeschlagen:", error.message);
  return data as { user_id: string; user: Person } | null;
}
