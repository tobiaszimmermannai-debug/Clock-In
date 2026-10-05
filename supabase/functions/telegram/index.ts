// Telegram-Integration – eine Datei, damit sie direkt im Supabase-Dashboard deploybar ist.
// Meldungen: Stempelungen, Nachtrag-/Überstunden-Freigaben, 18-Uhr-Abwesenheitsfrage (Krank/IST/Urlaub/Frei).
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
  overtime_status: "pending" | "approved" | "rejected" | null;
  note: string | null;
  user: Person | null;
  creator: Person | null;
  location: { name: string } | null;
  shift: { starts_at: string; ends_at: string; note: string | null } | null;
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
type Admin = { user_id: string; user: Person };
type Settings = { late_tolerance_minutes: number; absence_credit_minutes: number };

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
const ABSENCE: Record<string, { type: string; label: string }> = {
  s: { type: "sick", label: "🤒 Krank" },
  i: { type: "vocational_school", label: "📚 IST" },
  u: { type: "vacation", label: "🏖 Urlaub" },
};

async function handleNotify(body: { type?: string; id?: unknown; date?: unknown }): Promise<Response> {
  if (body.type === "absence_check" && typeof body.date === "string") return await absenceCheck(body.date);
  if (body.type !== "time_log" || typeof body.id !== "string") {
    return new Response("bad request", { status: 400 });
  }

  const { data: log, error } = await supabase
    .from("time_logs")
    .select(`
      id, event_type, recorded_at, source, approval_status, overtime_status, note,
      user:users!time_logs_user_id_fkey(first_name, last_name),
      creator:users!time_logs_created_by_fkey(first_name, last_name),
      location:locations(name),
      shift:shifts!time_logs_shift_id_fkey(starts_at, ends_at, note)
    `)
    .eq("id", body.id)
    .single<TimeLog>();
  if (error || !log) {
    console.error("Buchung nicht gefunden:", body.id, error?.message);
    return new Response("not found", { status: 404 });
  }

  const isApproval = log.approval_status === "pending";
  const isOvertime = !isApproval && log.overtime_status === "pending";
  // Entscheidungen gehen immer raus, einfache Meldungen nur bei notify_bookings
  const recipients = (await adminChats()).filter((l) => isApproval || isOvertime || l.notify_bookings);
  if (recipients.length === 0) return new Response("no recipients");

  let text: string;
  let keyboard: InlineButton[][] | undefined;
  if (isApproval) {
    text = approvalText(log);
    keyboard = [[{ text: "✅ OK", callback_data: `ok:${log.id}` }, {
      text: "❌ Ablehnen",
      callback_data: `no:${log.id}`,
    }]];
  } else if (isOvertime) {
    text = overtimeText(log);
    keyboard = [[
      { text: "✅ Überstunden OK", callback_data: `ot:ok:${log.id}` },
      { text: "❌ Ablehnen", callback_data: `ot:no:${log.id}` },
    ]];
  } else {
    text = bookingText(log, await ruleSettings());
  }

  await Promise.all(recipients.map((r) => sendMessage(r.chat_id, text, keyboard)));
  return new Response("sent");
}

// "🔔 Max Muster ist im Studio Nord eingestempelt (08:57)"
function bookingText(log: TimeLog, settings: Settings): string {
  const name = escapeHtml(fullName(log.user));
  const studio = escapeHtml(log.location?.name ?? "?");

  switch (log.source) {
    case "auto_checkout":
      return `🤖 <b>${name}</b> wurde im ${studio} automatisch zur geplanten Endzeit ausgestempelt (${
        formatClock(log.recorded_at)
      })`;
    case "manual":
      return `✍️ Nachtrag von ${escapeHtml(fullName(log.creator))}: <b>${name}</b> · ` +
        `${EVENT_LABEL[log.event_type]} ${formatDateTime(log.recorded_at)} · ${studio}` +
        (log.note ? `\n💬 ${escapeHtml(log.note)}` : "");
  }

  let text = `🔔 <b>${name}</b> ist im ${studio} ${EVENT_VERB[log.event_type]} (${formatClock(log.recorded_at)})` +
    (log.source === "offline_sync" ? " · 📶 offline nachgesendet" : "");
  if (log.event_type === "clock_in" && log.shift) {
    if (log.shift.note?.startsWith("Aushilfsschicht")) {
      text += `\n🔁 Keine Schicht geplant – Aushilfsschicht bis ${formatClock(log.shift.ends_at)} eingetragen`;
    } else {
      const late = Math.floor((Date.parse(log.recorded_at) - Date.parse(log.shift.starts_at)) / 60_000);
      if (late > settings.late_tolerance_minutes) {
        text += `\n⏰ ${late} Min. nach Schichtbeginn (${formatClock(log.shift.starts_at)})`;
      }
    }
  }
  return text;
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

function overtimeText(log: TimeLog): string {
  const end = log.shift?.ends_at ?? log.recorded_at;
  const minutes = Math.max(0, Math.floor((Date.parse(log.recorded_at) - Date.parse(end)) / 60_000));
  return [
    "⏱ <b>Überstunden – Freigabe nötig</b>",
    `👤 ${escapeHtml(fullName(log.user))} · ${escapeHtml(log.location?.name ?? "?")}`,
    `Schichtende ${formatClock(end)} · ausgestempelt ${formatClock(log.recorded_at)} → <b>${minutes} Min.</b> mehr`,
    "Ohne Freigabe zählt die Zeit nur bis Schichtende.",
  ].join("\n");
}

// 18 Uhr: Wer hatte heute weder Schicht noch Stempelung? → Krank / IST / Urlaub / Frei
async function absenceCheck(day: string): Promise<Response> {
  const { data: people, error } = await supabase.rpc("absence_candidates", { p_day: day });
  if (error) {
    console.error("absence_candidates fehlgeschlagen:", error.message);
    return new Response("error", { status: 500 });
  }
  const list = (people ?? []) as { user_id: string; first_name: string; last_name: string }[];
  if (list.length === 0) return new Response("nobody");

  const admins = await adminChats();
  const hours = formatHours((await ruleSettings()).absence_credit_minutes);
  const compact = day.replaceAll("-", "");
  for (const p of list) {
    const text =
      `❓ <b>${escapeHtml(fullName(p))}</b> hatte am ${formatDay(day)} keine Schicht und hat nicht gestempelt.\n` +
      `Was war los? (Krank, IST und Urlaub werden mit ${hours} gutgeschrieben)`;
    const cb = (code: string) => `ab:${code}:${p.user_id}:${compact}`;
    const keyboard = [
      [{ text: ABSENCE.s.label, callback_data: cb("s") }, { text: ABSENCE.i.label, callback_data: cb("i") }],
      [{ text: ABSENCE.u.label, callback_data: cb("u") }, { text: "✓ Frei", callback_data: cb("f") }],
    ];
    await Promise.all(admins.map((a) => sendMessage(a.chat_id, text, keyboard)));
  }
  return new Response(`asked ${list.length}`);
}

// -----------------------------------------------------------------------------
// Telegram-Updates: /start und Buttons
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
  const parts = (cq.data ?? "").split(":");
  const admin = await findAdminByTelegramId(cq.from.id);
  if (!admin) {
    await tg("answerCallbackQuery", { callback_query_id: cq.id, text: "Keine Berechtigung.", show_alert: true });
    return;
  }
  switch (parts[0]) {
    case "ok":
    case "no":
      return await decideBooking(cq, admin, parts[0] === "ok", parts[1]);
    case "ot":
      return await decideOvertime(cq, admin, parts[1] === "ok", parts[2]);
    case "ab":
      return await decideAbsence(cq, admin, parts[1], parts[2], parts[3]);
    default:
      await tg("answerCallbackQuery", { callback_query_id: cq.id });
  }
}

// Nachtrag freigeben/ablehnen – nur offene (verhindert Doppel-Entscheidung durch zweiten Admin)
async function decideBooking(cq: CallbackQuery, admin: Admin, approve: boolean, id: string) {
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
    return await alreadyDone(cq, text);
  }
  await done(
    cq,
    approve ? "Freigegeben ✅" : "Abgelehnt ❌",
    `${approve ? "✅ Freigegeben" : "❌ Abgelehnt"} von ${escapeHtml(fullName(admin.user))}`,
  );
}

async function decideOvertime(cq: CallbackQuery, admin: Admin, approve: boolean, id: string) {
  const { data: updated, error } = await supabase
    .from("time_logs")
    .update({ overtime_status: approve ? "approved" : "rejected", overtime_reviewed_by: admin.user_id })
    .eq("id", id)
    .eq("overtime_status", "pending")
    .select("id");

  if (error || !updated?.length) {
    const { data: log } = await supabase
      .from("time_logs")
      .select("overtime_status, reviewer:users!time_logs_overtime_reviewed_by_fkey(first_name, last_name)")
      .eq("id", id)
      .maybeSingle<{ overtime_status: string | null; reviewer: Person | null }>();
    const text = !log
      ? "Buchung nicht gefunden."
      : `Bereits entschieden: ${log.overtime_status === "approved" ? "freigegeben" : "abgelehnt"}` +
        (log.reviewer ? ` von ${fullName(log.reviewer)}` : "");
    return await alreadyDone(cq, text);
  }
  const by = escapeHtml(fullName(admin.user));
  await done(
    cq,
    approve ? "Überstunden freigegeben ✅" : "Überstunden abgelehnt ❌",
    approve ? `✅ Überstunden freigegeben von ${by}` : `❌ Abgelehnt von ${by} – gezählt bis Schichtende`,
  );
}

async function decideAbsence(cq: CallbackQuery, admin: Admin, code: string, userId: string, compact: string) {
  const day = `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}`;
  const by = escapeHtml(fullName(admin.user));
  if (code === "f") return await done(cq, "Als frei vermerkt", `✓ Frei – vermerkt von ${by}`);

  const absence = ABSENCE[code];
  if (!absence || !userId) return await tg("answerCallbackQuery", { callback_query_id: cq.id });
  const { data: recorded, error } = await supabase.rpc("record_absence", {
    p_user: userId,
    p_day: day,
    p_type: absence.type,
    p_decided_by: admin.user_id,
  });
  if (error) {
    await tg("answerCallbackQuery", { callback_query_id: cq.id, text: `Fehler: ${error.message}`, show_alert: true });
    return;
  }
  if (recorded === false) return await alreadyDone(cq, "Für diesen Tag ist bereits etwas eingetragen.");
  const hours = formatHours((await ruleSettings()).absence_credit_minutes);
  await done(cq, `${absence.label} eingetragen`, `${absence.label} (${hours}) – eingetragen von ${by}`);
}

async function done(cq: CallbackQuery, toast: string, resultHtml: string) {
  await tg("answerCallbackQuery", { callback_query_id: cq.id, text: toast });
  if (cq.message) await closeMessage(cq.message, resultHtml);
}

async function alreadyDone(cq: CallbackQuery, text: string) {
  await tg("answerCallbackQuery", { callback_query_id: cq.id, text, show_alert: true });
  if (cq.message) await closeMessage(cq.message, `ℹ️ ${escapeHtml(text)}`);
}

// Telegram-Chats aller aktiven Admins
async function adminChats() {
  const { data } = await supabase
    .from("telegram_links")
    .select("chat_id, notify_bookings, user:users!inner(role, is_active)")
    .eq("user.role", "admin")
    .eq("user.is_active", true);
  return (data ?? []) as { chat_id: number; notify_bookings: boolean }[];
}

async function ruleSettings(): Promise<Settings> {
  const { data } = await supabase.from("rule_settings").select("late_tolerance_minutes, absence_credit_minutes")
    .single();
  return (data as Settings | null) ?? { late_tolerance_minutes: 5, absence_credit_minutes: 390 };
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

function sendMessage(chatId: number, html: string, keyboard?: InlineButton[][]) {
  return tg("sendMessage", {
    chat_id: chatId,
    text: html,
    parse_mode: "HTML",
    ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {}),
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
const dayFmt = new Intl.DateTimeFormat("de-DE", {
  timeZone: "UTC",
  weekday: "short",
  day: "2-digit",
  month: "2-digit",
});
const formatDay = (day: string) => dayFmt.format(new Date(`${day}T12:00:00Z`));
const formatHours = (minutes: number) => `${(minutes / 60).toLocaleString("de-DE", { maximumFractionDigits: 2 })} Std.`;

// Secret-Vergleich in konstanter Zeit; leeres Secret = nicht konfiguriert = immer falsch
function safeEqual(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  if (x.length !== y.length || x.length === 0) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}
