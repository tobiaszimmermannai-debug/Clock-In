// Wird per pg_net vom DB-Trigger notify_telegram aufgerufen (neue Buchung in time_logs)
// und schickt die Meldung an alle verknüpften Admins.
import {
  escapeHtml,
  formatClock,
  formatDateTime,
  fullName,
  type Person,
  safeEqual,
  sendMessage,
  supabase,
} from "../_shared/telegram.ts";

const NOTIFY_SECRET = Deno.env.get("NOTIFY_SECRET") ?? "";

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

Deno.serve(async (req) => {
  if (!safeEqual(req.headers.get("x-notify-secret") ?? "", NOTIFY_SECRET)) {
    return new Response("unauthorized", { status: 401 });
  }

  const { type, id } = await req.json().catch(() => ({}));
  if (type !== "time_log" || typeof id !== "string") {
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
    .eq("id", id)
    .single<TimeLog>();
  if (error || !log) {
    console.error("Buchung nicht gefunden:", id, error?.message);
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
});

// "🔔 Max Muster ist im Studio Nord eingestempelt (08:57)"
function bookingText(log: TimeLog): string {
  const name = escapeHtml(fullName(log.user));
  const studio = escapeHtml(log.location?.name ?? "?");
  const verb = EVENT_VERB[log.event_type] ?? log.event_type;

  switch (log.source) {
    case "auto_checkout":
      return `🤖 <b>${name}</b> wurde im ${studio} automatisch ausgestempelt (${formatClock(log.recorded_at)})`;
    case "manual":
      return `✍️ Nachtrag von ${escapeHtml(fullName(log.creator))}: <b>${name}</b> · ` +
        `${EVENT_LABEL[log.event_type]} ${formatDateTime(log.recorded_at)} · ${studio}` +
        (log.note ? `\n💬 ${escapeHtml(log.note)}` : "");
    default:
      return `🔔 <b>${name}</b> ist im ${studio} ${verb} (${formatClock(log.recorded_at)})` +
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
