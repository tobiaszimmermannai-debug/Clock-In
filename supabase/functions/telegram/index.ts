// Telegram-Integration – eine Datei, damit sie direkt im Supabase-Dashboard deploybar ist.
//   POST mit Header x-notify-secret                 → neue Buchung melden (Aufruf per pg_net aus der DB)
//   POST mit Header x-telegram-bot-api-secret-token → Update von Telegram (/start, Buttons ✅/❌)
// JWT-Prüfung der Function muss AUS sein; abgesichert wird über die beiden Secrets.
import { createClient } from "npm:@supabase/supabase-js@2";

const BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
const NOTIFY_SECRET = Deno.env.get("NOTIFY_SECRET") ?? "";
const WEBHOOK_SECRET = Deno.env.get("TELEGRAM_WEBHOOK_SECRET") ?? "";

// Service-Role-Client: umgeht RLS, daher nur serverseitig
const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });

  const notifyHeader = req.headers.get("x-notify-secret");
  if (notifyHeader !== null) {
    if (!safeEqual(notifyHeader, NOTIFY_SECRET)) return new Response("unauthorized", { status: 401 });
    return handleNotify(await req.json().catch(() => ({})));
  }

  // Telegram sendet das bei setWebhook hinterlegte secret_token mit
  const telegramHeader = req.headers.get("x-telegram-bot-api-secret-token");
  if (telegramHeader !== null) {
    if (!safeEqual(telegramHeader, WEBHOOK_SECRET)) return new Response("unauthorized", { status: 401 });
    const update = await req.json().catch(() => ({}));
    try {
      if (update.callback_query) await handleCallback(update.callback_query);
      else if (update.message) await handleMessage(update.message);
    } catch (e) {
      console.error("Update-Verarbeitung fehlgeschlagen:", e);
    }
    return new Response("ok"); // immer 200, sonst stellt Telegram das Update erneut zu
  }

  return new Response("unauthorized", { status: 401 });
});

// -----------------------------------------------------------------------------
// Typen
// -----------------------------------------------------------------------------
type Person = { first_name: string; last_name: string };
type InlineButton = { text: string; callback_data: string };
type TimeLog = {
  id: string;
  event_type: string;
  recorded_at: string;
  source: "kiosk" | "offline_sync" | "auto_checkout" | "manual";
  approval_status: "approved" | "pending" | "rejected";
  note: string | null;
  user: Person | null;
  creator: Person | null;
  location: { name: string } | null;
};
type Message = {
  message_id: number;
  text?: string;
  chat: { id: number; type: string };
};
type CallbackQuery = {
  id: string;
  data?: string;
  from: { id: number };
  message?: Message;
};

// -----------------------------------------------------------------------------
// Neue Buchung melden
// -----------------------------------------------------------------------------
const EVENT_VERB: Record<string, string> = {
  clock_in: "eingestempelt",
  break_start: "in die Pause gegangen",
  break_end: "aus der Pause zurück",
  clock_out: "ausgestempelt",
};
const EVENT_LABEL: Record<string, string> = {
  clock_in: "Kommen",
  break_start: "Pause Start",
  break_end: "Pause Ende",
  clock_out: "Gehen",
};

async function handleNotify(body: { type?: string; id?: unknown }): Promise<Response> {
  if (body.type !== "time_log" || typeof body.id !== "string") {
    return new Response("bad request", { status: 400 });
  }

  const { data: log, error } = await supabase
    .from("time_logs")
    .select(`
      id, event_type, recorded_at, source, approval_status, note,
      user:users!time_logs_user_id_fkey(first_name, last_name),
      creator:users!time_logs_created_by_fkey(first_name, last_name),
      location:locations(name)
    `)
    .eq("id", body.id)
    .single<TimeLog>();
  if (error || !log) {
    console.error("Buchung nicht gefunden:", body.id, error?.message);
    return new Response("not found", { status: 404 });
  }

  const { data: links } = await supabase
    .from("telegram_links")
    .select("chat_id, notify_bookings, user:users!inner(role, is_active)")
    .eq("user.role", "admin")
    .eq("user.is_active", true);

  const isApproval = log.approval_status === "pending";
  const recipients = (links ?? []).filter((l) => isApproval || l.notify_bookings);
  if (recipients.length === 0) return new Response("no recipients");

  const text = isApproval ? approvalText(log) : bookingText(log);
  const buttons = isApproval
    ? [
      { text: "✅ OK", callback_data: `ok:${log.id}` },
      { text: "❌ Ablehnen", callback_data: `no:${log.id}` },
    ]
    : undefined;

  await Promise.all(recipients.map((r) => sendMessage(r.chat_id, text, buttons)));
  return new Response("sent");
}

// "🔔 Max Muster ist im Studio Nord eingestempelt (08:57)"
function bookingText(log: TimeLog): string {
  const name = escapeHtml(fullName(log.user));
  const studio = escapeHtml(log.location?.name ?? "?");

  switch (log.source) {
    case "auto_checkout":
      return `🤖 <b>${name}</b> wurde im ${studio} automatisch ausgestempelt (${formatClock(log.recorded_at)})`;
    case "manual":
      return `✍️ Nachtrag von ${escapeHtml(fullName(log.creator))}: <b>${name}</b> · ` +
        `${EVENT_LABEL[log.event_type]} ${formatDateTime(log.recorded_at)} · ${studio}` +
        (log.note ? `\n💬 ${escapeHtml(log.note)}` : "");
    default:
      return `🔔 <b>${name}</b> ist im ${studio} ${EVENT_VERB[log.event_type]} (${formatClock(log.recorded_at)})` +
        (log.source === "offline_sync" ? " · 📶 offline nachgesendet" : "");
  }
}

function approvalText(log: TimeLog): string {
  const by = log.source === "manual" ? escapeHtml(fullName(log.creator)) : "Tablet (Offline-Nachsync vom Vortag)";
  return [
    "📝 <b>Nachtrag wartet auf Freigabe</b>",
    `👤 ${escapeHtml(fullName(log.user))} · ${escapeHtml(log.location?.name ?? "?")}`,
    `⏱ ${EVENT_LABEL[log.event_type]} · ${formatDateTime(log.recorded_at)}`,
    `✍️ eingetragen von: ${by}`,
    ...(log.note ? [`💬 ${escapeHtml(log.note)}`] : []),
  ].join("\n");
}

// -----------------------------------------------------------------------------
// Telegram-Updates: /start und Freigabe-Buttons
// -----------------------------------------------------------------------------
async function handleMessage(msg: Message) {
  if (msg.chat.type !== "private" || !msg.text?.startsWith("/")) return;

  const admin = await findAdminByTelegramId(msg.chat.id);
  if (admin) {
    await sendMessage(
      msg.chat.id,
      `✅ Verbunden als <b>${escapeHtml(fullName(admin.user))}</b>.\n` +
        "Du erhältst Stempel-Meldungen und Freigabe-Anfragen.",
    );
  } else {
    await sendMessage(
      msg.chat.id,
      `👋 Deine Chat-ID: <code>${msg.chat.id}</code>\n` +
        "Ein Admin muss sie im Clock-In-Admin-Bereich freischalten.",
    );
  }
}

async function handleCallback(cq: CallbackQuery) {
  const [action, id] = (cq.data ?? "").split(":");
  if (!["ok", "no"].includes(action) || !id) {
    await tg("answerCallbackQuery", { callback_query_id: cq.id });
    return;
  }

  const admin = await findAdminByTelegramId(cq.from.id);
  if (!admin) {
    await tg("answerCallbackQuery", { callback_query_id: cq.id, text: "Keine Berechtigung.", show_alert: true });
    return;
  }

  const approve = action === "ok";
  // nur offene Nachträge entscheiden (verhindert Doppel-Entscheidung durch zweiten Admin)
  const { data: updated, error } = await supabase
    .from("time_logs")
    .update({
      approval_status: approve ? "approved" : "rejected",
      reviewed_by: admin.user_id,
      review_note: "per Telegram",
    })
    .eq("id", id)
    .eq("approval_status", "pending")
    .select("id");

  if (error || !updated?.length) {
    const { data: log } = await supabase
      .from("time_logs")
      .select("approval_status, reviewer:users!time_logs_reviewed_by_fkey(first_name, last_name)")
      .eq("id", id)
      .maybeSingle<{ approval_status: string; reviewer: Person | null }>();
    const text = !log
      ? "Buchung nicht gefunden."
      : `Bereits entschieden: ${log.approval_status === "approved" ? "freigegeben" : "abgelehnt"}` +
        (log.reviewer ? ` von ${fullName(log.reviewer)}` : "");
    await tg("answerCallbackQuery", { callback_query_id: cq.id, text, show_alert: true });
    if (cq.message) await closeMessage(cq.message, `ℹ️ ${escapeHtml(text)}`);
    return;
  }

  await tg("answerCallbackQuery", { callback_query_id: cq.id, text: approve ? "Freigegeben ✅" : "Abgelehnt ❌" });
  if (cq.message) {
    await closeMessage(
      cq.message,
      `${approve ? "✅ Freigegeben" : "❌ Abgelehnt"} von ${escapeHtml(fullName(admin.user))}`,
    );
  }
}

// Aktiver Admin zu einem Telegram-Account (privater Chat: chat_id = User-ID)
async function findAdminByTelegramId(telegramUserId: number) {
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

// Buttons entfernen und Ergebnis an die Nachricht anhängen
function closeMessage(msg: Message, resultHtml: string) {
  return tg("editMessageText", {
    chat_id: msg.chat.id,
    message_id: msg.message_id,
    parse_mode: "HTML",
    text: `${escapeHtml(msg.text ?? "")}\n\n${resultHtml}`,
  });
}

// -----------------------------------------------------------------------------
// Helfer
// -----------------------------------------------------------------------------
// Aufruf der Telegram Bot API; Fehler werden geloggt, nicht geworfen
async function tg(method: string, payload: Record<string, unknown>) {
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({ ok: false, description: res.statusText }));
  if (!data.ok) console.error(`Telegram ${method} fehlgeschlagen:`, data.description);
  return data;
}

function sendMessage(chatId: number, html: string, buttons?: InlineButton[]) {
  return tg("sendMessage", {
    chat_id: chatId,
    text: html,
    parse_mode: "HTML",
    ...(buttons ? { reply_markup: { inline_keyboard: [buttons] } } : {}),
  });
}

function escapeHtml(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const fullName = (p: Person | null) => (p ? `${p.first_name} ${p.last_name}` : "Unbekannt");

const dateTimeFmt = new Intl.DateTimeFormat("de-DE", {
  timeZone: "Europe/Berlin",
  weekday: "short",
  day: "2-digit",
  month: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});
const clockFmt = new Intl.DateTimeFormat("de-DE", { timeZone: "Europe/Berlin", hour: "2-digit", minute: "2-digit" });
const formatDateTime = (iso: string) => dateTimeFmt.format(new Date(iso));
const formatClock = (iso: string) => clockFmt.format(new Date(iso));

// Secret-Vergleich in konstanter Zeit; leeres Secret = nicht konfiguriert = immer falsch
function safeEqual(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  if (x.length !== y.length || x.length === 0) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}
