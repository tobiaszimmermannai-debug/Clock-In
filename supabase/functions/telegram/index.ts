// Telegram-Integration – eine Datei, damit sie direkt im Supabase-Dashboard deploybar ist.
// Meldungen: Stempelungen, Freigaben (Nachtrag, Überstunden, Schichttausch), 18-Uhr-Abwesenheitsfrage,
// Wochenbericht am Freitag. Dazu am 1. jedes Monats die Monatsübersicht per Mail (Resend, Secret RESEND_API_KEY).
// PC als Terminal: Anfrage mit „✅ Ja, passt“ → Terminal-Konto anlegen (wie ein Tablet, fest einem Studio zugeordnet).
//   POST mit Header x-notify-secret                 → neue Buchung melden (Aufruf per pg_net aus der DB)
//   POST mit Header x-telegram-bot-api-secret-token → Update von Telegram (/start, Buttons ✅/❌)
// JWT-Prüfung der Function muss AUS sein; abgesichert wird über die beiden Secrets.
import { createClient } from "npm:@supabase/supabase-js@2";

const BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
const NOTIFY_SECRET = Deno.env.get("NOTIFY_SECRET") ?? "";
const WEBHOOK_SECRET = Deno.env.get("TELEGRAM_WEBHOOK_SECRET") ?? "";
// Mail-Versand: ohne eigene Domain nur an die Adresse, mit der das Resend-Konto angelegt wurde
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") ?? "";
const MAIL_FROM = Deno.env.get("MAIL_FROM") || "Clock-In <onboarding@resend.dev>";

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
  device_unverified?: boolean;  // gestempelt mit nicht registriertem Handy/Browser
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
type Settings = { late_tolerance_minutes: number; absence_credit_minutes: number; school_credit_minutes?: number };

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
  i: { type: "vocational_school", label: "📚 Schule" },
  u: { type: "vacation", label: "🏖 Urlaub" },
};

async function handleNotify(
  body: { type?: string; id?: unknown; date?: unknown; from?: unknown; to?: unknown; month?: unknown },
): Promise<Response> {
  if (body.type === "terminal_request" && typeof body.id === "string") return await terminalRequest(body.id);
  if (body.type === "terminal_create" && typeof body.id === "string") {
    const result = await createTerminal(body.id);
    if (!result.ok) {
      for (const a of await adminChats()) await sendMessage(a.chat_id, `⚠️ PC-Terminal konnte nicht angelegt werden: ${escapeHtml(result.text)}`);
    }
    return new Response(result.text, { status: result.ok ? 200 : 500 });
  }
  if (body.type === "monthly_report") {
    const result = await monthlyReport(typeof body.month === "string" ? body.month : undefined);
    if (!result.ok) {
      for (const a of await adminChats()) await sendMessage(a.chat_id, `⚠️ Monatsübersicht per Mail fehlgeschlagen: ${escapeHtml(result.text)}`);
    }
    return new Response(result.text, { status: result.ok ? 200 : 500 });
  }
  if (body.type === "absence_check" && typeof body.date === "string") return await absenceCheck(body.date);
  if (body.type === "swap_request" && typeof body.id === "string") return await swapRequest(body.id);
  if (body.type === "studio_unstaffed") return await studioUnstaffed(body as Unstaffed);
  if (body.type === "not_checked_in") return await notCheckedIn(body as NotCheckedIn);
  if (body.type === "phone_registered") return await phoneRegistered(body as PhoneRegistered);
  if (body.type === "weekly_report" && typeof body.from === "string" && typeof body.to === "string") {
    return await weeklyReport(body.from, body.to);
  }
  if (body.type !== "time_log" || typeof body.id !== "string") {
    return new Response("bad request", { status: 400 });
  }

  const { data: log, error } = await supabase
    .from("time_logs")
    .select(`
      *,
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
  // Erstes Einstempeln des Tages im Studio → "Studio besetzt" (auch für Admins mit /kurz)
  let isFirst = false;
  if (!isApproval && log.event_type === "clock_in") {
    const { data: first } = await supabase.rpc("is_first_checkin", { p_log_id: log.id });
    isFirst = first === true;
  }
  // Entscheidungen gehen immer raus, einfache Meldungen nur bei notify_bookings
  const recipients = (await adminChats()).filter((l) =>
    isApproval || isOvertime || l.notify_bookings || (isFirst && l.notify_studio_status)
  );
  if (recipients.length === 0) return new Response("no recipients");

  let text: string;
  let keyboard: InlineButton[][] | undefined;
  if (isApproval && log.source === "auto_checkout") {
    text = forgottenText(log);
    keyboard = [[
      { text: `✅ Bis ${formatClock(log.recorded_at)} anrechnen`, callback_data: `ok:${log.id}` },
      { text: "❌ Ablehnen", callback_data: `no:${log.id}` },
    ]];
  } else if (isApproval && log.device_unverified) {
    text = unknownPhoneText(log);
    keyboard = [[
      { text: "✅ OK + Handy merken", callback_data: `ok:${log.id}` },
      { text: "❌ Ablehnen", callback_data: `no:${log.id}` },
    ]];
  } else if (isApproval) {
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
    if (isFirst) text = `🟢 <b>${escapeHtml(log.location?.name ?? "Studio")} ist besetzt</b>\n${text}`;
  }

  await Promise.all(recipients.map((r) => sendMessage(r.chat_id, text, keyboard)));
  return new Response("sent");
}

// "🔔 Max Muster ist im Studio Krailling eingestempelt (08:57)"
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

// Gestempelt mit nicht registriertem Handy/Browser (z. B. iPhone: Kamera-Scan öffnet Safari statt der App)
function unknownPhoneText(log: TimeLog): string {
  return [
    "📱 <b>Anderes Handy – wartet auf Freigabe</b>",
    `👤 ${escapeHtml(fullName(log.user))} · ${escapeHtml(log.location?.name ?? "?")}`,
    `⏱ ${EVENT_LABEL[log.event_type]} · ${formatDateTime(log.recorded_at)}`,
    "Nicht das registrierte Handy bzw. ein anderer Browser. ✅ = Buchung zählt und das Handy wird künftig erkannt.",
  ].join("\n");
}

// Ausstempeln vergessen → automatisch zur geplanten Endzeit, zählt erst nach Freigabe
function forgottenText(log: TimeLog): string {
  return [
    "🤖 <b>Ausstempeln vergessen</b>",
    `👤 ${escapeHtml(fullName(log.user))} · ${escapeHtml(log.location?.name ?? "?")}`,
    `Automatisch zum Schichtende ${formatDateTime(log.recorded_at)} eingetragen.`,
    "Bis Schichtende anrechnen? Bei ❌ die echte Gehzeit in der Verwaltung unter Zeiten nachtragen.",
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

// 18 Uhr: Wer hatte heute weder Schicht noch Stempelung? → Krank / Schule / Urlaub / Frei
async function absenceCheck(day: string): Promise<Response> {
  const { data: people, error } = await supabase.rpc("absence_candidates", { p_day: day });
  if (error) {
    console.error("absence_candidates fehlgeschlagen:", error.message);
    return new Response("error", { status: 500 });
  }
  const list = (people ?? []) as { user_id: string; first_name: string; last_name: string }[];
  if (list.length === 0) return new Response("nobody");

  const admins = await adminChats();
  const settings = await ruleSettings();
  const hours = formatHours(settings.absence_credit_minutes);
  const school = formatHours(settings.school_credit_minutes ?? 420);
  const compact = day.replaceAll("-", "");
  for (const p of list) {
    const text =
      `❓ <b>${escapeHtml(fullName(p))}</b> hatte am ${formatDay(day)} keine Schicht und hat nicht gestempelt.\n` +
      `Was war los? (Krank und Urlaub werden mit ${hours} gutgeschrieben, bei Azubis Wochenstunden ÷ 5,25; Schule mit ${school})`;
    const cb = (code: string) => `ab:${code}:${p.user_id}:${compact}`;
    const keyboard = [
      [{ text: ABSENCE.s.label, callback_data: cb("s") }, { text: ABSENCE.i.label, callback_data: cb("i") }],
      [{ text: ABSENCE.u.label, callback_data: cb("u") }, { text: "✓ Frei", callback_data: cb("f") }],
    ];
    await Promise.all(admins.map((a) => sendMessage(a.chat_id, text, keyboard)));
  }
  return new Response(`asked ${list.length}`);
}

// Studio 10 Min. nach der ersten geplanten Schicht noch leer
type Unstaffed = { location?: string; start?: string; names?: string[] };
async function studioUnstaffed(b: Unstaffed): Promise<Response> {
  const names = (b.names ?? []).map(escapeHtml).join(", ") || "?";
  const text = `🔴 <b>${escapeHtml(b.location ?? "Studio")} ist noch nicht besetzt</b>\n` +
    `Geplant ab ${escapeHtml(b.start ?? "?")}: ${names}`;
  const admins = (await adminChats()).filter((a) => a.notify_studio_status);
  await Promise.all(admins.map((a) => sendMessage(a.chat_id, text)));
  return new Response("sent");
}

// 5 Min. nach Schichtbeginn noch nicht eingestempelt (je Schicht einmal)
type NotCheckedIn = { name?: string; location?: string; start?: string; acquisition?: boolean };
async function notCheckedIn(b: NotCheckedIn): Promise<Response> {
  const text = `⏰ <b>${escapeHtml(b.name ?? "?")}</b> ist noch nicht da\n` +
    `${b.acquisition ? "Akquise" : "Schicht"} in ${escapeHtml((b.location ?? "?").replace(/^Studio\s+/, ""))} ab ` +
    `${escapeHtml(b.start ?? "?")} Uhr – noch nicht eingestempelt.`;
  const admins = (await adminChats()).filter((a) => a.notify_studio_status);
  await Promise.all(admins.map((a) => sendMessage(a.chat_id, text)));
  return new Response("sent");
}

// Stempel-Handy neu registriert → Admins können Missbrauch sofort erkennen
type PhoneRegistered = { name?: string; location?: string };
async function phoneRegistered(b: PhoneRegistered): Promise<Response> {
  const text = `📱 <b>${escapeHtml(b.name ?? "?")}</b> hat ein Stempel-Handy registriert` +
    (b.location ? ` (${escapeHtml(b.location)})` : "") +
    `.\nNicht plausibel? In der Verwaltung unter Team → Person → Stempel-Handy zurücksetzen.`;
  await Promise.all((await adminChats()).map((a) => sendMessage(a.chat_id, text)));
  return new Response("sent");
}

// Neuer Schichttausch-Antrag → Freigabe durch Admin per Button
async function swapRequest(id: string): Promise<Response> {
  const { data: swap, error } = await supabase
    .from("swap_requests")
    .select(`
      id, reason, is_cross_studio,
      requester:users!swap_requests_requester_id_fkey(first_name, last_name),
      target:users!swap_requests_target_user_id_fkey(first_name, last_name),
      requester_shift:shifts!swap_requests_requester_shift_id_fkey(starts_at, ends_at, location:locations(name)),
      target_shift:shifts!swap_requests_target_shift_id_fkey(starts_at, ends_at, location:locations(name))
    `)
    .eq("id", id)
    .single<{
      id: string;
      reason: string | null;
      is_cross_studio: boolean;
      requester: Person | null;
      target: Person | null;
      requester_shift: ShiftInfo | null;
      target_shift: ShiftInfo | null;
    }>();
  if (error || !swap) return new Response("not found", { status: 404 });

  const lines = [
    "🔄 <b>Schichttausch-Antrag</b>",
    `${escapeHtml(fullName(swap.requester))} gibt ab: ${shiftLabel(swap.requester_shift)}`,
    swap.target_shift
      ? `${escapeHtml(fullName(swap.target))} gibt dafür ab: ${shiftLabel(swap.target_shift)}`
      : `Übernehmen soll: ${escapeHtml(fullName(swap.target))}`,
    ...(swap.reason ? [`💬 ${escapeHtml(swap.reason)}`] : []),
    ...(swap.is_cross_studio
      ? ["🏢 Studioübergreifend: braucht beide Studioleitungen – dein Admin-OK gibt für beide frei."]
      : []),
  ];
  const keyboard = [[
    { text: "✅ Tausch OK", callback_data: `sw:ok:${swap.id}` },
    { text: "❌ Ablehnen", callback_data: `sw:no:${swap.id}` },
  ]];
  const admins = await adminChats();
  await Promise.all(admins.map((a) => sendMessage(a.chat_id, lines.join("\n"), keyboard)));
  return new Response("sent");
}

type ShiftInfo = { starts_at: string; ends_at: string; location: { name: string } | null };
const shiftLabel = (s: ShiftInfo | null) =>
  s ? `${formatDateTime(s.starts_at)}–${formatClock(s.ends_at)} · ${escapeHtml(s.location?.name ?? "?")}` : "?";

// Freitag: Wochenbericht über Stunden, Verspätungen, Überstunden und offene Freigaben
async function weeklyReport(from: string, to: string): Promise<Response> {
  const { data, error } = await supabase.rpc("weekly_report", { p_from: from, p_to: to });
  if (error) {
    console.error("weekly_report fehlgeschlagen:", error.message);
    return new Response("error", { status: 500 });
  }
  const rows = (data ?? []) as {
    first_name: string;
    last_name: string;
    target_minutes: number;
    worked_minutes: number;
    credit_minutes: number;
    late_count: number;
    late_minutes: number;
    overtime_pending_minutes: number;
    overtime_approved_minutes: number;
    open_days: number;
    forgotten_count: number;
  }[];

  const [bookings, overtime, swaps] = await Promise.all([
    supabase.from("time_logs").select("id", { count: "exact", head: true }).eq("approval_status", "pending"),
    supabase.from("time_logs").select("id", { count: "exact", head: true }).eq("overtime_status", "pending"),
    supabase.from("swap_requests").select("id", { count: "exact", head: true }).eq("status", "pending"),
  ]);

  const lines = [`📊 <b>Wochenbericht ${formatDay(from)} – ${formatDay(to)}</b>`, ""];
  for (const r of rows) {
    const ist = r.worked_minutes + r.credit_minutes;
    const parts = [`${formatHours(ist)} / ${formatHours(r.target_minutes)}`];
    if (r.credit_minutes) parts.push(`davon ${formatHours(r.credit_minutes)} Gutschrift`);
    if (r.late_count) parts.push(`⏰ ${r.late_count}× zu spät (${r.late_minutes} Min.)`);
    if (r.overtime_approved_minutes) parts.push(`➕ ${r.overtime_approved_minutes} Min. Überstunden`);
    if (r.overtime_pending_minutes) parts.push(`⏳ ${r.overtime_pending_minutes} Min. Überstunden offen`);
    if (r.forgotten_count) parts.push(`🤖 ${r.forgotten_count}× nicht ausgestempelt`);
    if (r.open_days) parts.push(`⚠️ ${r.open_days}× Gehzeit noch offen`);
    lines.push(`<b>${escapeHtml(fullName(r))}</b>: ${parts.join(" · ")}`);
  }
  if (rows.length === 0) lines.push("Keine Mitarbeiter mit Daten.");
  const open = [
    bookings.count ? `${bookings.count} Nachträge` : "",
    overtime.count ? `${overtime.count}× Überstunden` : "",
    swaps.count ? `${swaps.count} Schichttausch` : "",
  ].filter(Boolean);
  lines.push("", open.length ? `🔔 Offene Freigaben: ${open.join(", ")}` : "✅ Keine offenen Freigaben");

  // Telegram erlaubt max. 4096 Zeichen pro Nachricht → bei Bedarf aufteilen
  const chunks: string[] = [];
  let current = "";
  for (const line of lines) {
    if ((current + line).length > 3800) {
      chunks.push(current);
      current = "";
    }
    current += line + "\n";
  }
  chunks.push(current);

  const admins = await adminChats();
  for (const chunk of chunks) await Promise.all(admins.map((a) => sendMessage(a.chat_id, chunk)));
  return new Response(`report ${rows.length}`);
}

// -----------------------------------------------------------------------------
// Telegram-Updates: /start und Buttons
// -----------------------------------------------------------------------------
// -----------------------------------------------------------------------------
// PC als Terminal: Anfrage → „Ja, passt“ → Konto anlegen (Benutzer pc-<studio>-xxxx, Passwort = Schlüssel des PCs)
// -----------------------------------------------------------------------------
const TERMINAL_DOMAIN = "kiosk.clockin.invalid"; // wie Tablets (account-admin)
type TerminalRequest = {
  id: string; name: string; status: string; password: string | null; location_id: string;
  location: { name: string; code: string } | null; requester: Person | null;
};

async function loadTerminalRequest(id: string) {
  const { data } = await supabase
    .from("terminal_requests")
    .select("id, name, status, password, location_id, location:locations(name, code), requester:users!terminal_requests_requested_by_fkey(first_name, last_name)")
    .eq("id", id)
    .maybeSingle<TerminalRequest>();
  return data;
}

async function terminalRequest(id: string): Promise<Response> {
  const r = await loadTerminalRequest(id);
  if (!r) return new Response("not found", { status: 404 });
  const text = `🖥 <b>Neues Terminal</b>\nPC „${escapeHtml(r.name)}“ möchte Terminal für <b>${escapeHtml(r.location?.name ?? "?")}</b> sein.\n` +
    `Angefragt von ${escapeHtml(fullName(r.requester))}.`;
  const keyboard = [[{ text: "✅ Ja, passt", callback_data: `tm:ok:${id}` }, { text: "❌ Nein", callback_data: `tm:no:${id}` }]];
  await Promise.all((await adminChats()).map((a) => sendMessage(a.chat_id, text, keyboard)));
  return new Response("sent");
}

async function decideTerminal(cq: CallbackQuery, admin: Admin, approve: boolean, id: string) {
  const { data: updated } = await supabase
    .from("terminal_requests")
    .update(approve
      ? { status: "approved", decided_by: admin.user_id, decided_at: new Date().toISOString() }
      : { status: "rejected", password: null, decided_by: admin.user_id, decided_at: new Date().toISOString() })
    .eq("id", id)
    .eq("status", "pending")
    .select("id");
  if (!updated?.length) return await alreadyDone(cq, "Diese Anfrage ist schon entschieden.");
  if (!approve) return await done(cq, "Abgelehnt", `❌ Abgelehnt von ${escapeHtml(fullName(admin.user))}`);
  const result = await createTerminal(id);
  return await done(cq, result.ok ? "Freigegeben" : "Fehler",
    result.ok ? `✅ Freigegeben von ${escapeHtml(fullName(admin.user))} – ${escapeHtml(result.text)}` : `⚠️ ${escapeHtml(result.text)}`);
}

async function createTerminal(id: string): Promise<{ ok: boolean; text: string }> {
  const r = await loadTerminalRequest(id);
  if (!r || r.status !== "approved" || !r.password) return { ok: false, text: "Anfrage nicht gefunden oder schon erledigt." };
  const code = (r.location?.code ?? "studio").toLowerCase().replace(/[^a-z0-9]/g, "");
  const username = `pc-${code}-${crypto.randomUUID().slice(0, 4)}`;
  const { data: auth, error } = await supabase.auth.admin.createUser({
    email: `${username}@${TERMINAL_DOMAIN}`,
    password: r.password,
    email_confirm: true,
    app_metadata: { kiosk: true },
  });
  if (error || !auth.user) return { ok: false, text: `Konto konnte nicht angelegt werden: ${error?.message}` };
  const { data: device, error: devErr } = await supabase
    .from("kiosk_devices")
    .insert({ auth_user_id: auth.user.id, name: r.name, location_id: r.location_id, username, kind: "pc" })
    .select("id")
    .single();
  if (devErr || !device) {
    await supabase.auth.admin.deleteUser(auth.user.id); // nichts Halbes zurücklassen
    return { ok: false, text: `Terminal konnte nicht registriert werden: ${devErr?.message}` };
  }
  await supabase.from("terminal_requests")
    .update({ status: "ready", username, device_id: device.id, password: null })
    .eq("id", id);
  return { ok: true, text: `„${r.name}“ ist jetzt Terminal für ${r.location?.name ?? "das Studio"}.` };
}

// -----------------------------------------------------------------------------
// Monatsübersicht per Mail (1. des Monats bzw. /monatsbericht): Vormonat, aktueller und kommender Monat –
// alle Schichten mit Zeiten, Abwesenheiten und Urlaub (genommen / eingetragen / übrig). Dazu eine CSV für Excel.
// -----------------------------------------------------------------------------
type ReportPerson = { id: string; first_name: string; last_name: string; role: string; studio: string | null };
type ReportEntry = {
  user_id: string; type: string; starts_at: string; ends_at: string; note: string | null;
  is_acquisition: boolean; is_herold: boolean; studio: string | null; day: string;
};
type ReportVacation = { user_id: string; year: number; allowance: number; taken: number; planned: number };
type ReportData = { from: string; to: string; today: string; people: ReportPerson[]; entries: ReportEntry[]; vacation: ReportVacation[] };

const TYPE_LABEL: Record<string, string> = { work: "Schicht", vacation: "Urlaub", sick: "Krank", vocational_school: "Schule", day_off: "Frei" };
const ABSENCE_TYPES = ["vacation", "sick", "vocational_school", "day_off"];
const monthFmt = new Intl.DateTimeFormat("de-DE", { month: "long", year: "numeric", timeZone: "UTC" });
const shortDayFmt = new Intl.DateTimeFormat("de-DE", { timeZone: "Europe/Berlin", weekday: "short", day: "2-digit", month: "2-digit" });
const studioShort = (name: string | null) => (name ?? "Ohne Studio").replace(/^Studio\s+/i, "");
const numDe = (n: number) => n.toLocaleString("de-DE", { maximumFractionDigits: 2 });
const hoursDe = (minutes: number) => numDe(minutes / 60);
const minutesOf = (e: ReportEntry) => Math.round((Date.parse(e.ends_at) - Date.parse(e.starts_at)) / 60_000);
const entryLabel = (e: ReportEntry) =>
  e.type === "work" ? (e.is_herold ? "Herold" : e.is_acquisition ? "Akquise" : "Schicht") : TYPE_LABEL[e.type] ?? e.type;

async function monthlyReport(month?: string): Promise<{ ok: boolean; text: string }> {
  const settings = await ruleSettings() as Settings & { monthly_report_email?: string | null };
  const to = (settings.monthly_report_email ?? "gf@bsnewfitness.de").split(/[,;\s]+/).filter(Boolean);
  if (!RESEND_API_KEY) return { ok: false, text: "Secret RESEND_API_KEY fehlt (Supabase → Edge Functions → Secrets)." };
  if (to.length === 0) return { ok: false, text: "Keine Empfänger-Adresse hinterlegt." };

  const now = new Date();
  const current = month ?? `${new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Berlin", year: "numeric", month: "2-digit" }).format(now)}-01`;
  const { data, error } = await supabase.rpc("monthly_report", { p_month: current });
  if (error || !data) return { ok: false, text: `Daten fehlen: ${error?.message ?? "leer"}` };
  const report = data as ReportData;

  const months = [0, 1, 2].map((i) => {
    const d = new Date(`${report.from}T12:00:00Z`);
    d.setUTCMonth(d.getUTCMonth() + i);
    const key = d.toISOString().slice(0, 7);
    return { key, label: monthFmt.format(d), hint: ["Vormonat", "aktueller Monat", "kommender Monat"][i] };
  });
  const title = `Monatsübersicht ${months[1].label}`;
  const html = reportHtml(report, months, title);
  const csv = reportCsv(report, months);

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({
      from: MAIL_FROM,
      to,
      subject: `Clock-In · ${title}`,
      html,
      attachments: [{ filename: `dienstplan_${months[0].key}_bis_${months[2].key}.csv`, content: base64(csv) }],
    }),
  });
  if (!res.ok) return { ok: false, text: `Mail-Versand fehlgeschlagen (${res.status}): ${(await res.text()).slice(0, 300)}` };
  return { ok: true, text: `${title} an ${to.join(", ")} verschickt.` };
}

function reportHtml(r: ReportData, months: { key: string; label: string; hint: string }[], title: string): string {
  const th = 'style="text-align:left;padding:6px 8px;border-bottom:2px solid #d0d5dd;font-size:12px;color:#475467;white-space:nowrap"';
  const thNum = 'style="text-align:right;padding:6px 8px;border-bottom:2px solid #d0d5dd;font-size:12px;color:#475467;white-space:nowrap"';
  const td = 'style="padding:6px 8px;border-bottom:1px solid #eaecf0;vertical-align:top;font-size:13px"';
  const tdNum = 'style="padding:6px 8px;border-bottom:1px solid #eaecf0;vertical-align:top;font-size:13px;text-align:right;white-space:nowrap"';
  const name = (p: ReportPerson) => escapeHtml(`${p.first_name} ${p.last_name}`);
  const studios = [...new Set(r.people.map((p) => studioShort(p.studio)))];
  const out: string[] = [];
  out.push(`<div style="font-family:Arial,Helvetica,sans-serif;color:#101828;max-width:960px">`);
  out.push(`<h1 style="font-size:20px;margin:0 0 4px">${escapeHtml(title)}</h1>`);
  out.push(`<p style="margin:0 0 20px;color:#475467;font-size:13px">${escapeHtml(months.map((m) => m.label).join(" · "))} (Stand ${escapeHtml(formatDay(r.today))}) · Alle Einträge auch als CSV im Anhang (Excel).</p>`);

  // Urlaub je Jahr
  for (const year of [...new Set(r.vacation.map((v) => v.year))]) {
    out.push(`<h2 style="font-size:16px;margin:24px 0 8px">Urlaub ${year}</h2>`);
    out.push(`<table style="border-collapse:collapse;width:100%"><tr><th ${th}>Mitarbeiter</th><th ${th}>Studio</th><th ${thNum}>Anspruch</th><th ${thNum}>genommen</th><th ${thNum}>eingetragen</th><th ${thNum}>übrig</th></tr>`);
    for (const p of r.people) {
      const v = r.vacation.find((x) => x.user_id === p.id && x.year === year);
      if (!v) continue;
      const left = Number(v.allowance) - v.taken - v.planned;
      out.push(`<tr><td ${td}>${name(p)}</td><td ${td}>${escapeHtml(studioShort(p.studio))}</td><td ${tdNum}>${numDe(Number(v.allowance))}</td><td ${tdNum}>${v.taken}</td><td ${tdNum}>${v.planned}</td><td ${tdNum}><b${left < 0 ? ' style="color:#d1293d"' : ""}>${numDe(left)}</b></td></tr>`);
    }
    out.push(`</table>`);
  }

  // Monate
  for (const m of months) {
    const inMonth = r.entries.filter((e) => e.day.startsWith(m.key));
    out.push(`<h2 style="font-size:16px;margin:28px 0 4px">${escapeHtml(m.label)} <span style="color:#667085;font-weight:normal">(${m.hint})</span></h2>`);
    for (const studio of studios) {
      const people = r.people.filter((p) => studioShort(p.studio) === studio);
      out.push(`<h3 style="font-size:13px;margin:14px 0 6px;color:#475467;text-transform:uppercase;letter-spacing:.04em">${escapeHtml(studio)}</h3>`);
      out.push(`<table style="border-collapse:collapse;width:100%"><tr><th ${th}>Mitarbeiter</th><th ${thNum}>Schichten</th><th ${thNum}>Std.</th><th ${thNum}>Urlaub</th><th ${thNum}>Krank</th><th ${thNum}>Schule</th><th ${thNum}>Frei</th><th ${th}>Einträge</th></tr>`);
      for (const p of people) {
        const mine = inMonth.filter((e) => e.user_id === p.id);
        const work = mine.filter((e) => e.type === "work");
        const days = (type: string) => new Set(mine.filter((e) => e.type === type).map((e) => e.day)).size || "–";
        const list = mine.map((e) => {
          const day = shortDayFmt.format(new Date(e.starts_at));
          const label = entryLabel(e);
          const where = e.type === "work" && e.studio && studioShort(e.studio) !== studio ? ` ${studioShort(e.studio)}` : "";
          const text = e.type === "work"
            ? `${day} ${formatClock(e.starts_at)}–${formatClock(e.ends_at)}${label !== "Schicht" ? ` ${label}` : ""}${where}`
            : `${day} ${label}`;
          const color = e.type === "work" ? "#101828" : e.type === "sick" ? "#d1293d" : "#027a48";
          return `<span style="white-space:nowrap;color:${color}">${escapeHtml(text)}</span>`;
        });
        out.push(`<tr><td ${td}><b>${name(p)}</b></td><td ${tdNum}>${work.length || "–"}</td><td ${tdNum}>${work.length ? hoursDe(work.reduce((n, e) => n + minutesOf(e), 0)) : "–"}</td>` +
          `<td ${tdNum}>${days("vacation")}</td><td ${tdNum}>${days("sick")}</td><td ${tdNum}>${days("vocational_school")}</td><td ${tdNum}>${days("day_off")}</td>` +
          `<td ${td}>${list.length ? list.join(" · ") : '<span style="color:#98a2b3">keine Einträge</span>'}</td></tr>`);
      }
      out.push(`</table>`);
    }
  }
  out.push(`<p style="margin:24px 0 0;color:#98a2b3;font-size:12px">Automatisch erstellt von Clock-In (Dienstplan-Stand zum Versand). Std. = geplante Schichtstunden.</p></div>`);
  return out.join("\n");
}

function reportCsv(r: ReportData, months: { key: string; label: string }[]): string {
  const cell = (v: string | number) => {
    const s = String(v);
    return /[;"\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
  };
  const rows = [["Monat", "Heimatstudio", "Mitarbeiter", "Datum", "Tag", "Art", "Von", "Bis", "Stunden", "Ort", "Hinweis"]];
  const people = new Map(r.people.map((p) => [p.id, p]));
  for (const e of r.entries) {
    const p = people.get(e.user_id);
    const m = months.find((x) => e.day.startsWith(x.key));
    if (!p || !m) continue;
    const work = e.type === "work";
    rows.push([
      m.label, studioShort(p.studio), `${p.first_name} ${p.last_name}`, e.day.split("-").reverse().join("."),
      shortDayFmt.format(new Date(e.starts_at)).split(",")[0], entryLabel(e),
      work ? formatClock(e.starts_at) : "", work ? formatClock(e.ends_at) : "", work ? hoursDe(minutesOf(e)) : "",
      work ? studioShort(e.studio) : "", e.note ?? "",
    ]);
  }
  // BOM + Semikolon: Excel (deutsch) öffnet die Datei direkt richtig
  return "﻿" + rows.map((row) => row.map(cell).join(";")).join("\r\n");
}

function base64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

async function handleMessage(msg: Message) {
  if (msg.chat.type !== "private" || !msg.text?.startsWith("/")) return;

  const admin = await findAdminByTelegramId(msg.chat.id);
  if (admin) {
    const command = msg.text.split(/[\s@]/)[0].toLowerCase();
    if (command === "/monatsbericht") {
      const result = await monthlyReport();
      await sendMessage(msg.chat.id, result.ok ? `📧 ${escapeHtml(result.text)}` : `⚠️ ${escapeHtml(result.text)}`);
      return;
    }
    if (command === "/kurz" || command === "/alle") {
      const all = command === "/alle";
      await supabase.from("telegram_links").update({ notify_bookings: all }).eq("chat_id", msg.chat.id);
      await sendMessage(
        msg.chat.id,
        all
          ? "✅ Ab jetzt bekommst du <b>jede Stempelung</b>. Mit /kurz wieder nur das Wichtigste."
          : "✅ Ab jetzt nur noch: 🟢/🔴 Studio besetzt, Freigaben, 18-Uhr-Frage und Wochenbericht. Mit /alle wieder jede Stempelung.",
      );
      return;
    }
    await sendMessage(
      msg.chat.id,
      `✅ Verbunden als <b>${escapeHtml(fullName(admin.user))}</b>.\n\n` +
        "Befehle:\n/kurz – nur Studio besetzt, Freigaben und Berichte\n/alle – zusätzlich jede Stempelung\n" +
        "/monatsbericht – Monatsübersicht jetzt per Mail schicken",
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
    case "sw":
      return await decideSwap(cq, admin, parts[1] === "ok", parts[2]);
    case "tm":
      return await decideTerminal(cq, admin, parts[1] === "ok", parts[2]);
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
    .select("id, source");

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
  const forgotten = updated[0].source === "auto_checkout";
  await done(
    cq,
    approve ? "Freigegeben ✅" : "Abgelehnt ❌",
    `${approve ? "✅ Freigegeben" : "❌ Abgelehnt"} von ${escapeHtml(fullName(admin.user))}` +
      (forgotten && !approve ? "\n👉 Echte Gehzeit in der Verwaltung unter Zeiten nachtragen." : ""),
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
  await done(cq, `${absence.label} eingetragen`, `${absence.label} – eingetragen von ${by}`);
}

// Schichttausch entscheiden; die Datenbank prüft Schichten und tauscht atomar
async function decideSwap(cq: CallbackQuery, admin: Admin, approve: boolean, id: string) {
  const { data: updated, error } = await supabase
    .from("swap_requests")
    .update({
      status: approve ? "approved" : "rejected",
      decided_by: admin.user_id,
      decision_note: "per Telegram",
    })
    .eq("id", id)
    .eq("status", "pending")
    .select("id");
  if (error) return await alreadyDone(cq, error.message.replace(/^Schichttausch: /, ""));
  if (!updated?.length) {
    const { data: swap } = await supabase
      .from("swap_requests")
      .select("status, decider:users!swap_requests_decided_by_fkey(first_name, last_name)")
      .eq("id", id)
      .maybeSingle<{ status: string; decider: Person | null }>();
    const label: Record<string, string> = { approved: "freigegeben", rejected: "abgelehnt", cancelled: "storniert" };
    const text = !swap
      ? "Antrag nicht gefunden."
      : `Bereits ${label[swap.status] ?? swap.status}` + (swap.decider ? ` von ${fullName(swap.decider)}` : "");
    return await alreadyDone(cq, text);
  }
  const by = escapeHtml(fullName(admin.user));
  await done(
    cq,
    approve ? "Tausch freigegeben ✅" : "Tausch abgelehnt ❌",
    approve ? `✅ Tausch freigegeben von ${by} – Dienstplan ist aktualisiert` : `❌ Tausch abgelehnt von ${by}`,
  );
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
    .select("chat_id, notify_bookings, notify_studio_status, user:users!inner(role, is_active)")
    .eq("user.role", "admin")
    .eq("user.is_active", true);
  return (data ?? []) as { chat_id: number; notify_bookings: boolean; notify_studio_status: boolean }[];
}

async function ruleSettings(): Promise<Settings> {
  const { data } = await supabase.from("rule_settings").select("*")
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
