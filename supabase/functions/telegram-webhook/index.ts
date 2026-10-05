// Webhook für Telegram-Updates: /start (Chat-ID anzeigen) und Freigabe-Buttons ✅/❌
import {
  escapeHtml,
  findAdminByTelegramId,
  fullName,
  type Person,
  safeEqual,
  sendMessage,
  supabase,
  tg,
} from "../_shared/telegram.ts";

const WEBHOOK_SECRET = Deno.env.get("TELEGRAM_WEBHOOK_SECRET") ?? "";

type Message = {
  message_id: number;
  text?: string;
  chat: { id: number; type: string };
  from?: { id: number };
};
type CallbackQuery = {
  id: string;
  data?: string;
  from: { id: number };
  message?: Message;
};

Deno.serve(async (req) => {
  // Telegram sendet das bei setWebhook hinterlegte secret_token mit
  if (!safeEqual(req.headers.get("x-telegram-bot-api-secret-token") ?? "", WEBHOOK_SECRET)) {
    return new Response("unauthorized", { status: 401 });
  }

  const update = await req.json().catch(() => ({}));
  try {
    if (update.callback_query) await handleCallback(update.callback_query);
    else if (update.message) await handleMessage(update.message);
  } catch (e) {
    console.error("Update-Verarbeitung fehlgeschlagen:", e);
  }
  return new Response("ok"); // immer 200, sonst stellt Telegram das Update erneut zu
});

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

// Buttons entfernen und Ergebnis an die Nachricht anhängen
function closeMessage(msg: Message, resultHtml: string) {
  return tg("editMessageText", {
    chat_id: msg.chat.id,
    message_id: msg.message_id,
    parse_mode: "HTML",
    text: `${escapeHtml(msg.text ?? "")}\n\n${resultHtml}`,
  });
}
