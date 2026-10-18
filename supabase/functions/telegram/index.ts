// Telegram-Integration – eine Datei, damit sie direkt im Supabase-Dashboard deploybar ist.
// Meldungen: Stempelungen, Freigaben (Nachtrag, Überstunden, Schichttausch), 18-Uhr-Abwesenheitsfrage,
// Wochenbericht am Freitag. Dazu am 1. jedes Monats der Monatsbericht per Mail (Resend, Secret RESEND_API_KEY).
// PC als Terminal: Anfrage mit „✅ Ja, passt“ → Terminal-Konto anlegen (wie ein Tablet, fest einem Studio zugeordnet).
//   POST mit Header x-notify-secret                 → neue Buchung melden (Aufruf per pg_net aus der DB)
//   POST mit Header x-telegram-bot-api-secret-token → Update von Telegram (/start, Buttons ✅/❌)
// JWT-Prüfung der Function muss AUS sein; abgesichert wird über die beiden Secrets.
import { createClient } from "npm:@supabase/supabase-js@2";
import * as XLSX from "npm:xlsx@0.18.5";

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
  early_status?: string | null; // „pending“: mehr als 30 Min. vor Schichtende gegangen
  early_reason?: "slow" | "sick" | null;
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
      for (const a of await adminChats()) await sendMessage(a.chat_id, `⚠️ Monatsbericht per Mail fehlgeschlagen: ${escapeHtml(result.text)}`);
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
  const isEarly = !isApproval && log.event_type === "clock_out" && log.early_status === "pending";
  // Erstes Einstempeln des Tages im Studio → "Studio besetzt" (auch für Admins mit /kurz)
  let isFirst = false;
  if (!isApproval && log.event_type === "clock_in") {
    const { data: first } = await supabase.rpc("is_first_checkin", { p_log_id: log.id });
    isFirst = first === true;
  }
  // Entscheidungen gehen immer raus, einfache Meldungen nur bei notify_bookings
  const recipients = (await adminChats()).filter((l) =>
    isApproval || isOvertime || isEarly || l.notify_bookings || (isFirst && l.notify_studio_status)
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
  } else if (isEarly) {
    text = earlyText(log);
    const no = { text: "❌ Ablehnen (Minusstunden)", callback_data: `el:no:${log.id}` };
    const sick = { text: "🤒 Ab da krank anrechnen", callback_data: `el:sick:${log.id}` };
    const ok = { text: "✅ OK – bis Schichtende anrechnen", callback_data: `el:ok:${log.id}` };
    keyboard = log.early_reason === "sick" ? [[sick], [no]] : log.early_reason === "slow" ? [[ok], [no]] : [[sick], [ok], [no]];
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

// Früher gegangen (mehr als 30 Min. vor Schichtende) – Grund vom Handy, Entscheidung per Button
function earlyText(log: TimeLog): string {
  const end = log.shift?.ends_at ?? log.recorded_at;
  const minutes = Math.max(0, Math.round((Date.parse(end) - Date.parse(log.recorded_at)) / 60_000));
  const reason = log.early_reason === "sick" ? "🤒 krank"
    : log.early_reason === "slow" ? "📉 wenig los / weniger Trainings" : "nicht angegeben";
  return [
    `🏃 <b>${escapeHtml(fullName(log.user))}</b> ist <b>${formatHours(minutes)}</b> vor Schichtende gegangen`,
    `${escapeHtml(log.location?.name ?? "")} · Schicht ${log.shift ? `${formatClock(log.shift.starts_at)}–${formatClock(log.shift.ends_at)}` : "?"} · gegangen ${formatClock(log.recorded_at)}`,
    `Grund: <b>${reason}</b>`,
    "Ohne Freigabe zählt nur die gearbeitete Zeit (Minusstunden).",
  ].join("\n");
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
// Monatsbericht per Mail (1. des Monats bzw. /monatsbericht) – aufgebaut wie Personio/Papershift-Auswertungen:
// 1. Kennzahlen des Vormonats  2. Auffälligkeiten (Minusstunden, häufig zu spät, Krank)  3. je Studio eine Zeile
// pro Mitarbeiter (Soll/Ist/Saldo, Verspätungen mit Ampel, Krank, Urlaub)  4. Wochenübersicht  5. Ausblick
// (aktueller + kommender Monat: geplant vs. Soll). Excel im Anhang: Übersicht, Wochen, Ausblick, Dienstplan
// und je Mitarbeiter ein Stundenzettel. Soll = Wochenstunden ÷ 7 × Kalendertage (wie im Portal).
// -----------------------------------------------------------------------------
type ReportPerson = {
  id: string; first_name: string; last_name: string; role: string; studio: string | null;
  weekly_target_minutes: number | null; employment_start: string | null; employment_end: string | null;
};
type ReportEntry = {
  user_id: string; type: string; starts_at: string; ends_at: string; note: string | null;
  is_acquisition: boolean; is_herold: boolean; studio: string | null; day: string;
};
type ReportDay = {
  user_id: string; day: string; planned: number; worked: number; break: number; credit: number;
  absence: string | null; late: number; ot_pending: number; ot_approved: number; open: boolean;
};
type ReportVacation = { user_id: string; year: number; allowance: number; taken: number; planned: number };
type ReportData = {
  from: string; to: string; trend_from: string; today: string;
  settings: { absence_credit_minutes: number; absence_week_days: number; school_credit_minutes: number | null };
  people: ReportPerson[]; entries: ReportEntry[]; days: ReportDay[]; vacation: ReportVacation[];
  sick_year: Record<string, number>;
};
type Month = { key: string; label: string; first: string; last: string };
type Stats = {
  p: ReportPerson; soll: number; ist: number; saldo: number; late: number; lateMin: number; late3: number;
  sick: number; sickYear: number; vacation: number; school: number; vacationLeft: number | null; open: number; otPending: number;
  noShow: number; // geplante Schicht ohne Stempelung und ohne Abwesenheit
};

const TYPE_LABEL: Record<string, string> = { work: "Schicht", vacation: "Urlaub", sick: "Krank", vocational_school: "Schule", day_off: "Frei" };
const LATE_ALERT = 3; // ab so vielen Verspätungen im Monat rot
const MINUS_ALERT = -60; // Saldo unter −1 Std. gilt als Minusstunden
const monthFmt = new Intl.DateTimeFormat("de-DE", { month: "long", year: "numeric", timeZone: "UTC" });
const shortDayFmt = new Intl.DateTimeFormat("de-DE", { timeZone: "Europe/Berlin", weekday: "short", day: "2-digit", month: "2-digit" });
const studioShort = (name: string | null) => (name ?? "Ohne Studio").replace(/^Studio\s+/i, "");
const numDe = (n: number, digits = 1) => n.toLocaleString("de-DE", { minimumFractionDigits: digits, maximumFractionDigits: digits });
const hoursDe = (minutes: number) => numDe(minutes / 60);
const signedHours = (minutes: number) => (Math.abs(minutes) < 15 ? "±0,0" : `${minutes > 0 ? "+" : "−"}${hoursDe(Math.abs(minutes))}`);
const hours2 = (minutes: number) => Math.round(minutes / 0.6) / 100; // Excel: Dezimalstunden
const minutesOf = (e: { starts_at: string; ends_at: string }) => Math.round((Date.parse(e.ends_at) - Date.parse(e.starts_at)) / 60_000);
const fullNameOf = (p: ReportPerson) => `${p.first_name} ${p.last_name}`;
const entryLabel = (e: ReportEntry) =>
  e.type === "work" ? (e.is_herold ? "Herold" : e.is_acquisition ? "Akquise" : "Schicht") : TYPE_LABEL[e.type] ?? e.type;
const ROLE_DE: Record<string, string> = { employee: "Mitarbeiter", trainee: "Azubi", manager: "Studioleitung" };

function addDaysIso(day: string, n: number): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function datesBetween(first: string, last: string): string[] {
  const out: string[] = [];
  for (let d = first; d <= last; d = addDaysIso(d, 1)) out.push(d);
  return out;
}
function isoWeek(day: string): number {
  const d = new Date(`${day}T12:00:00Z`);
  const dow = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - dow + 3);
  const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  return 1 + Math.round((d.getTime() - firstThursday.getTime()) / 604_800_000 - ((firstThursday.getUTCDay() + 6) % 7 - 3) / 7);
}
const employedOn = (p: ReportPerson, day: string) =>
  (!p.employment_start || p.employment_start <= day) && (!p.employment_end || p.employment_end >= day);
const sollFor = (p: ReportPerson, days: string[]) =>
  Math.round(((p.weekly_target_minutes ?? 0) / 7) * days.filter((d) => employedOn(p, d)).length);
const shortDate = (day: string) => `${day.slice(8, 10)}.${day.slice(5, 7)}.`;

async function monthlyReport(month?: string): Promise<{ ok: boolean; text: string }> {
  const settings = await ruleSettings() as Settings & { monthly_report_email?: string | null };
  const to = (settings.monthly_report_email ?? "gf@bsnewfitness.de").split(/[,;\s]+/).filter(Boolean);
  if (!RESEND_API_KEY) return { ok: false, text: "Secret RESEND_API_KEY fehlt (Supabase → Edge Functions → Secrets)." };
  if (to.length === 0) return { ok: false, text: "Keine Empfänger-Adresse hinterlegt." };

  const current = month ?? `${new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Berlin", year: "numeric", month: "2-digit" }).format(new Date())}-01`;
  const { data, error } = await supabase.rpc("monthly_report", { p_month: current });
  if (error || !data) return { ok: false, text: `Daten fehlen: ${error?.message ?? "leer"}` };
  const report = data as ReportData;

  const months: Month[] = [0, 1, 2].map((i) => {
    const d = new Date(`${report.from}T12:00:00Z`);
    d.setUTCMonth(d.getUTCMonth() + i);
    const first = d.toISOString().slice(0, 10);
    const next = new Date(d);
    next.setUTCMonth(next.getUTCMonth() + 1);
    return { key: first.slice(0, 7), label: monthFmt.format(d), first, last: addDaysIso(next.toISOString().slice(0, 10), -1) };
  });
  const stats = monthStats(report, months[0]);
  const title = `Monatsbericht ${months[0].label}`;
  const html = reportHtml(report, months, stats, title);
  const xlsx = reportXlsx(report, months, stats);

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({
      from: MAIL_FROM,
      to,
      subject: `Clock-In · ${title} + Ausblick ${months[1].label.split(" ")[0]}/${months[2].label.split(" ")[0]}`,
      html,
      attachments: [{ filename: `clockin_${months[0].key}.xlsx`, content: xlsx }],
    }),
  });
  if (!res.ok) return { ok: false, text: `Mail-Versand fehlgeschlagen (${res.status}): ${(await res.text()).slice(0, 300)}` };
  return { ok: true, text: `${title} an ${to.join(", ")} verschickt.` };
}

// Kennzahlen je Mitarbeiter im Vormonat
function monthStats(r: ReportData, m: Month): Stats[] {
  const dates = datesBetween(m.first, m.last);
  const year = Number(r.today.slice(0, 4));
  return r.people.map((p) => {
    const days = r.days.filter((d) => d.user_id === p.id);
    const inMonth = days.filter((d) => d.day >= m.first && d.day <= m.last);
    const entries = r.entries.filter((e) => e.user_id === p.id && e.day >= m.first && e.day <= m.last);
    const countDays = (type: string) => new Set(entries.filter((e) => e.type === type).map((e) => e.day)).size;
    const v = r.vacation.find((x) => x.user_id === p.id && x.year === year);
    const soll = sollFor(p, dates);
    const ist = inMonth.reduce((n, d) => n + d.worked + d.credit, 0);
    return {
      p, soll, ist, saldo: ist - soll,
      late: inMonth.filter((d) => d.late > 0).length,
      lateMin: inMonth.reduce((n, d) => n + d.late, 0),
      late3: days.filter((d) => d.late > 0).length,
      sick: countDays("sick"), sickYear: r.sick_year[p.id] ?? 0,
      vacation: countDays("vacation"), school: countDays("vocational_school"),
      vacationLeft: v ? Number(v.allowance) - v.taken - v.planned : null,
      open: inMonth.filter((d) => d.open).length,
      otPending: inMonth.reduce((n, d) => n + d.ot_pending, 0),
      noShow: inMonth.filter((d) => d.planned > 0 && d.worked === 0 && d.credit === 0 && !d.absence && !d.open && d.day < r.today).length,
    };
  });
}

// Plan (aktueller/kommender Monat): Schichtstunden + Gutschrift für Abwesenheiten gegen das Soll
function planStats(r: ReportData, m: Month) {
  const dates = datesBetween(m.first, m.last);
  return r.people.map((p) => {
    const entries = r.entries.filter((e) => e.user_id === p.id && e.day >= m.first && e.day <= m.last);
    const daily = p.role === "trainee" && p.weekly_target_minutes
      ? p.weekly_target_minutes / r.settings.absence_week_days : r.settings.absence_credit_minutes;
    const work = entries.filter((e) => e.type === "work").reduce((n, e) => n + minutesOf(e), 0);
    const days = (type: string) => new Set(entries.filter((e) => e.type === type).map((e) => e.day)).size;
    const credit = (days("vacation") + days("sick")) * daily + days("vocational_school") * (r.settings.school_credit_minutes ?? 420);
    const soll = sollFor(p, dates);
    return { p, soll, work, credit: Math.round(credit), diff: Math.round(work + credit - soll), shifts: entries.filter((e) => e.type === "work").length,
      vacation: days("vacation"), school: days("vocational_school"), dayOff: days("day_off"), sick: days("sick") };
  });
}

// Wochen des Monats (an Monatsgrenzen gekürzt)
function monthWeeks(m: Month) {
  const weeks: { kw: number; days: string[] }[] = [];
  for (const d of datesBetween(m.first, m.last)) {
    const kw = isoWeek(d);
    if (weeks.at(-1)?.kw === kw) weeks.at(-1)!.days.push(d);
    else weeks.push({ kw, days: [d] });
  }
  return weeks;
}

const C = {
  red: "#b42318", redBg: "#fef3f2", amber: "#b54708", amberBg: "#fffaeb", green: "#067647", greenBg: "#ecfdf3",
  grey: "#667085", line: "#eaecf0", head: "#475467",
};

function reportHtml(r: ReportData, months: Month[], stats: Stats[], title: string): string {
  const th = (align = "left") => `style="text-align:${align};padding:6px 8px;border-bottom:2px solid #d0d5dd;font-size:11px;color:${C.head};text-transform:uppercase;letter-spacing:.03em;white-space:nowrap"`;
  const td = (align = "left", extra = "") => `style="padding:7px 8px;border-bottom:1px solid ${C.line};font-size:13px;text-align:${align};vertical-align:top;${extra}"`;
  const pill = (text: string, fg: string, bg: string) =>
    `<span style="display:inline-block;padding:1px 8px;border-radius:10px;background:${bg};color:${fg};font-weight:600;white-space:nowrap">${escapeHtml(text)}</span>`;
  const muted = (text: string) => `<span style="color:${C.grey}">${escapeHtml(text)}</span>`;
  const saldoCell = (min: number) =>
    min < MINUS_ALERT ? pill(signedHours(min), C.red, C.redBg) : min > 15 ? pill(signedHours(min), C.green, C.greenBg) : muted(signedHours(min));
  const lateCell = (n: number, minutes: number) =>
    n === 0 ? muted("–") : n >= LATE_ALERT ? pill(`${n}× · ${minutes} Min.`, C.red, C.redBg) : pill(`${n}× · ${minutes} Min.`, C.amber, C.amberBg);
  const late3Cell = (n: number) => (n === 0 ? muted("–") : n >= LATE_ALERT * 2 ? pill(`${n}×`, C.red, C.redBg) : `${n}×`);
  const studios = [...new Set(r.people.map((p) => studioShort(p.studio)))];
  const vm = months[0];
  const out: string[] = [];
  out.push(`<div style="font-family:Arial,Helvetica,sans-serif;color:#101828;max-width:980px">`);
  out.push(`<h1 style="font-size:22px;margin:0 0 2px">${escapeHtml(title)}</h1>`);
  out.push(`<p style="margin:0 0 18px;color:${C.grey};font-size:13px">Abrechnungsmonat ${escapeHtml(vm.label)} · Ausblick ${escapeHtml(months[1].label)} und ${escapeHtml(months[2].label)} · Stand ${escapeHtml(formatDay(r.today))}</p>`);

  // 1. Kennzahlen
  const sum = (f: (s: Stats) => number) => stats.reduce((n, s) => n + f(s), 0);
  const minus = stats.filter((s) => s.saldo < MINUS_ALERT);
  const lateAlerts = stats.filter((s) => s.late >= LATE_ALERT);
  const kpi = (label: string, value: string, hint: string, color = "#101828") =>
    `<td style="padding:12px 14px;border:1px solid ${C.line};border-radius:10px;background:#fcfcfd;vertical-align:top;width:20%">
      <div style="font-size:11px;color:${C.head};text-transform:uppercase;letter-spacing:.03em">${label}</div>
      <div style="font-size:22px;font-weight:700;color:${color};margin:4px 0 2px">${value}</div>
      <div style="font-size:12px;color:${C.grey}">${hint}</div></td>`;
  out.push(`<table style="border-collapse:separate;border-spacing:8px 0;width:100%;margin:0 -8px 18px"><tr>
    ${kpi("Ist-Stunden", hoursDe(sum((s) => s.ist)), `Soll ${hoursDe(sum((s) => s.soll))} Std.`)}
    ${kpi("Minusstunden", minus.length ? hoursDe(-minus.reduce((n, s) => n + s.saldo, 0)) : "0", `${minus.length} Mitarbeiter im Minus`, minus.length ? C.red : C.green)}
    ${kpi("Verspätungen", String(sum((s) => s.late)), `${lateAlerts.length} Mitarbeiter ≥ ${LATE_ALERT}×`, lateAlerts.length ? C.red : "#101828")}
    ${kpi("Krankheitstage", String(sum((s) => s.sick)), `${sum((s) => s.sickYear)} im Jahr ${r.today.slice(0, 4)}`)}
    ${kpi("Urlaubstage", String(sum((s) => s.vacation)), `Schule: ${sum((s) => s.school)} ${sum((s) => s.school) === 1 ? "Tag" : "Tage"}`)}
  </tr></table>`);

  // 2. Auffälligkeiten
  const notes: string[] = [];
  for (const s of [...minus].sort((a, b) => a.saldo - b.saldo)) {
    notes.push(`${pill("Minus", C.red, C.redBg)} <b>${escapeHtml(fullNameOf(s.p))}</b> ${muted(studioShort(s.p.studio))}: ${signedHours(s.saldo)} Std. (Ist ${hoursDe(s.ist)} / Soll ${hoursDe(s.soll)})`);
  }
  for (const s of stats.filter((x) => x.late >= LATE_ALERT || x.late3 >= LATE_ALERT * 2).sort((a, b) => b.late - a.late || b.late3 - a.late3)) {
    notes.push(`${pill("Zu spät", C.red, C.redBg)} <b>${escapeHtml(fullNameOf(s.p))}</b> ${muted(studioShort(s.p.studio))}: ${s.late}× im ${escapeHtml(vm.label.split(" ")[0])} (${s.lateMin} Min.), ${s.late3}× in 3 Monaten`);
  }
  for (const s of stats.filter((x) => x.sick >= 3 || x.sickYear >= 10).sort((a, b) => b.sickYear - a.sickYear)) {
    notes.push(`${pill("Krank", C.amber, C.amberBg)} <b>${escapeHtml(fullNameOf(s.p))}</b>: ${s.sick} Tage im Monat, ${s.sickYear} im Jahr`);
  }
  for (const s of stats.filter((x) => x.noShow > 0).sort((a, b) => b.noShow - a.noShow)) {
    notes.push(`${pill("Fehlt", C.red, C.redBg)} <b>${escapeHtml(fullNameOf(s.p))}</b> ${muted(studioShort(s.p.studio))}: ${s.noShow}× geplante Schicht ohne Stempelung (weder gearbeitet noch Urlaub/Krank eingetragen)`);
  }
  for (const s of stats.filter((x) => x.open > 0)) {
    notes.push(`${pill("Stempeln", C.amber, C.amberBg)} <b>${escapeHtml(fullNameOf(s.p))}</b>: ${s.open}× Ausstempeln vergessen bzw. offen`);
  }
  out.push(`<h2 style="font-size:16px;margin:8px 0 8px">Auffälligkeiten</h2>`);
  out.push(notes.length
    ? `<div style="border:1px solid ${C.line};border-radius:10px;padding:6px 12px">${notes.map((n, i) =>
      `<div style="padding:6px 0;font-size:13px;${i < notes.length - 1 ? `border-bottom:1px solid ${C.line}` : ""}">${n}</div>`).join("")}</div>`
    : `<p style="font-size:13px;color:${C.green}">Keine Auffälligkeiten – alle im Soll, niemand häufig zu spät.</p>`);

  // 3. Je Studio: Mitarbeiter-Übersicht
  out.push(`<h2 style="font-size:16px;margin:26px 0 4px">Mitarbeiter je Studio · ${escapeHtml(vm.label)}</h2>`);
  out.push(`<p style="margin:0 0 6px;font-size:12px;color:${C.grey}">Ist = gearbeitete Zeit + Gutschrift (Urlaub/Krank/Schule). Verspätungen: ${pill("1–2×", C.amber, C.amberBg)} ${pill(`ab ${LATE_ALERT}×`, C.red, C.redBg)}</p>`);
  for (const studio of studios) {
    const rows = stats.filter((s) => studioShort(s.p.studio) === studio).sort((a, b) => fullNameOf(a.p).localeCompare(fullNameOf(b.p)));
    out.push(`<h3 style="font-size:13px;margin:16px 0 4px;color:${C.head};text-transform:uppercase;letter-spacing:.04em">${escapeHtml(studio)} <span style="font-weight:normal">· ${rows.length}</span></h3>`);
    out.push(`<table style="border-collapse:collapse;width:100%"><tr><th ${th()}>Mitarbeiter</th><th ${th("right")}>Soll</th><th ${th("right")}>Ist</th><th ${th("right")}>Saldo</th><th ${th()}>Zu spät</th><th ${th("right")}>3 Mon.</th><th ${th("right")}>Krank</th><th ${th("right")}>Urlaub</th><th ${th("right")}>Rest</th></tr>`);
    for (const s of rows) {
      const hint = [s.noShow ? `${s.noShow}× Schicht ohne Stempelung` : "", s.open ? `${s.open}× nicht ausgestempelt` : "", s.otPending ? `${hoursDe(s.otPending)} Std. Überstunden offen` : ""].filter(Boolean).join(" · ");
      out.push(`<tr><td ${td()}><b>${escapeHtml(fullNameOf(s.p))}</b><br><span style="font-size:11px;color:${C.grey}">${escapeHtml(ROLE_DE[s.p.role] ?? s.p.role)}${hint ? ` · ${escapeHtml(hint)}` : ""}</span></td>` +
        `<td ${td("right")}>${hoursDe(s.soll)}</td><td ${td("right")}>${hoursDe(s.ist)}</td><td ${td("right")}>${saldoCell(s.saldo)}</td>` +
        `<td ${td()}>${lateCell(s.late, s.lateMin)}</td><td ${td("right")}>${late3Cell(s.late3)}</td>` +
        `<td ${td("right")}>${s.sick ? `<b>${s.sick}</b>` : muted("0")} ${muted(`/ ${s.sickYear}`)}</td>` +
        `<td ${td("right")}>${s.vacation || muted("0")}</td><td ${td("right")}>${s.vacationLeft === null ? muted("–") : s.vacationLeft < 0 ? pill(numDe(s.vacationLeft, 0), C.red, C.redBg) : numDe(s.vacationLeft, s.vacationLeft % 1 ? 1 : 0)}</td></tr>`);
    }
    const t = (f: (s: Stats) => number) => rows.reduce((n, s) => n + f(s), 0);
    out.push(`<tr><td ${td("left", "font-weight:700;border-bottom:0")}>Summe</td><td ${td("right", "font-weight:700;border-bottom:0")}>${hoursDe(t((s) => s.soll))}</td><td ${td("right", "font-weight:700;border-bottom:0")}>${hoursDe(t((s) => s.ist))}</td><td ${td("right", "border-bottom:0")}>${saldoCell(t((s) => s.saldo))}</td><td ${td("left", "border-bottom:0")}>${t((s) => s.late) ? `${t((s) => s.late)}×` : muted("–")}</td><td ${td("right", "border-bottom:0")}></td><td ${td("right", "font-weight:700;border-bottom:0")}>${t((s) => s.sick)}</td><td ${td("right", "font-weight:700;border-bottom:0")}>${t((s) => s.vacation)}</td><td ${td("right", "border-bottom:0")}></td></tr></table>`);
  }
  out.push(`<p style="margin:6px 0 0;font-size:11px;color:${C.grey}">Krank: Tage im Monat / im Jahr ${r.today.slice(0, 4)}. Rest = Resturlaub ${r.today.slice(0, 4)} (nach allen eingetragenen Tagen). 3 Mon. = Verspätungen seit ${r.trend_from.split("-").reverse().join(".")}.</p>`);

  // 4. Wochenübersicht
  const weeks = monthWeeks(vm);
  out.push(`<h2 style="font-size:16px;margin:26px 0 4px">Wochenübersicht · ${escapeHtml(vm.label)}</h2>`);
  out.push(`<p style="margin:0 0 6px;font-size:12px;color:${C.grey}">Ist / Soll in Stunden je Kalenderwoche (rot: unter 90 %, grün: über 110 %; angeschnittene Wochen ohne Farbe) · ⏰ zu spät · K krank · U Urlaub · S Schule</p>`);
  for (const studio of studios) {
    const people = r.people.filter((p) => studioShort(p.studio) === studio);
    out.push(`<h3 style="font-size:13px;margin:14px 0 4px;color:${C.head};text-transform:uppercase;letter-spacing:.04em">${escapeHtml(studio)}</h3>`);
    out.push(`<table style="border-collapse:collapse;width:100%"><tr><th ${th()}>Mitarbeiter</th>${weeks.map((w) => `<th ${th("center")}>KW ${w.kw}<br><span style="font-weight:normal;text-transform:none">${shortDate(w.days[0])}–${shortDate(w.days.at(-1)!)}</span></th>`).join("")}</tr>`);
    for (const p of people) {
      const cells = weeks.map((w) => {
        const days = r.days.filter((d) => d.user_id === p.id && w.days.includes(d.day));
        const entries = r.entries.filter((e) => e.user_id === p.id && w.days.includes(e.day));
        const soll = sollFor(p, w.days);
        const ist = days.reduce((n, d) => n + d.worked + d.credit, 0);
        const count = (type: string) => new Set(entries.filter((e) => e.type === type).map((e) => e.day)).size;
        const marks = [days.filter((d) => d.late > 0).length ? `⏰${days.filter((d) => d.late > 0).length}` : "",
          count("sick") ? `K${count("sick")}` : "", count("vacation") ? `U${count("vacation")}` : "", count("vocational_school") ? `S${count("vocational_school")}` : ""].filter(Boolean).join(" ");
        if (!soll && !ist) return `<td ${td("center")}>${muted("–")}</td>`;
        // Farbe nur für ganze Wochen – angeschnittene Wochen am Monatsrand wären sonst verzerrt
        const ratio = soll && w.days.length === 7 ? ist / soll : 1;
        const bg = ratio < 0.9 ? C.redBg : ratio > 1.1 ? C.greenBg : "transparent";
        const fg = ratio < 0.9 ? C.red : "#101828";
        return `<td ${td("center", `background:${bg};color:${fg};white-space:nowrap`)}>${hoursDe(ist)} / ${hoursDe(soll)}${marks ? `<br><span style="font-size:11px;color:${C.head}">${escapeHtml(marks)}</span>` : ""}</td>`;
      });
      out.push(`<tr><td ${td()}><b>${escapeHtml(fullNameOf(p))}</b></td>${cells.join("")}</tr>`);
    }
    out.push(`</table>`);
  }

  // 5. Ausblick
  for (const m of months.slice(1)) {
    const plan = planStats(r, m);
    out.push(`<h2 style="font-size:16px;margin:26px 0 4px">Ausblick ${escapeHtml(m.label)} · geplant</h2>`);
    out.push(`<p style="margin:0 0 6px;font-size:12px;color:${C.grey}">Geplante Schichten + Gutschrift für Urlaub/Krank/Schule gegen das Soll. ${pill("rot", C.red, C.redBg)} = mehr als 8 Std. unter Soll (noch nicht ausgeplant).</p>`);
    out.push(`<table style="border-collapse:collapse;width:100%"><tr><th ${th()}>Studio</th><th ${th()}>Mitarbeiter</th><th ${th("right")}>Schichten</th><th ${th("right")}>Geplant</th><th ${th("right")}>+ Abw.</th><th ${th("right")}>Soll</th><th ${th("right")}>Differenz</th><th ${th("right")}>Urlaub</th><th ${th("right")}>Schule</th><th ${th("right")}>Frei</th></tr>`);
    for (const studio of studios) {
      for (const s of plan.filter((x) => studioShort(x.p.studio) === studio)) {
        const diff = s.diff < -480 ? pill(signedHours(s.diff), C.red, C.redBg) : s.diff < -60 ? pill(signedHours(s.diff), C.amber, C.amberBg) : muted(signedHours(s.diff));
        out.push(`<tr><td ${td("left", `color:${C.grey}`)}>${escapeHtml(studio)}</td><td ${td()}><b>${escapeHtml(fullNameOf(s.p))}</b></td><td ${td("right")}>${s.shifts || muted("0")}</td>` +
          `<td ${td("right")}>${hoursDe(s.work)}</td><td ${td("right")}>${s.credit ? hoursDe(s.credit) : muted("–")}</td><td ${td("right")}>${hoursDe(s.soll)}</td><td ${td("right")}>${diff}</td>` +
          `<td ${td("right")}>${s.vacation || muted("0")}</td><td ${td("right")}>${s.school || muted("0")}</td><td ${td("right")}>${s.dayOff || muted("0")}</td></tr>`);
      }
    }
    out.push(`</table>`);
  }

  out.push(`<p style="margin:24px 0 0;color:${C.grey};font-size:12px">Im Excel-Anhang: Übersicht, Wochen, Ausblick, kompletter Dienstplan und je Mitarbeiter ein Stundenzettel (Tag für Tag). ` +
    `Soll = Wochenstunden ÷ 7 × Kalendertage (wie im Portal, Feiertage nicht abgezogen). Automatisch erstellt von Clock-In.</p></div>`);
  return out.join("\n");
}

function reportXlsx(r: ReportData, months: Month[], stats: Stats[]): string {
  const wb = XLSX.utils.book_new();
  const sheet = (name: string, rows: (string | number | null)[][], widths: number[]) => {
    const ws = XLSX.utils.aoa_to_sheet(rows);
    ws["!cols"] = widths.map((wch) => ({ wch }));
    XLSX.utils.book_append_sheet(wb, ws, name);
  };
  const vm = months[0];
  const sorted = [...stats].sort((a, b) => studioShort(a.p.studio).localeCompare(studioShort(b.p.studio)) || fullNameOf(a.p).localeCompare(fullNameOf(b.p)));

  sheet(`Übersicht ${vm.key}`, [
    ["Studio", "Mitarbeiter", "Rolle", "Soll Std.", "Ist Std.", "Saldo Std.", "Zu spät (Anzahl)", "Zu spät (Min.)", "Zu spät 3 Monate", "Krank Tage", `Krank Tage ${r.today.slice(0, 4)}`, "Urlaub Tage", "Resturlaub", "Schule Tage", "Schicht ohne Stempelung", "Nicht ausgestempelt", "Überstunden offen Std."],
    ...sorted.map((s) => [studioShort(s.p.studio), fullNameOf(s.p), ROLE_DE[s.p.role] ?? s.p.role, hours2(s.soll), hours2(s.ist), hours2(s.saldo), s.late, s.lateMin, s.late3,
      s.sick, s.sickYear, s.vacation, s.vacationLeft, s.school, s.noShow, s.open, hours2(s.otPending)]),
  ], [14, 24, 14, 10, 10, 10, 15, 13, 15, 10, 14, 11, 11, 11, 22, 18, 20]);

  const weekRows: (string | number | null)[][] = [["Studio", "Mitarbeiter", "KW", "Von", "Bis", "Soll Std.", "Ist Std.", "Saldo Std.", "Zu spät", "Krank", "Urlaub", "Schule"]];
  for (const s of sorted) {
    for (const w of monthWeeks(vm)) {
      const days = r.days.filter((d) => d.user_id === s.p.id && w.days.includes(d.day));
      const entries = r.entries.filter((e) => e.user_id === s.p.id && w.days.includes(e.day));
      const count = (type: string) => new Set(entries.filter((e) => e.type === type).map((e) => e.day)).size;
      const soll = sollFor(s.p, w.days);
      const ist = days.reduce((n, d) => n + d.worked + d.credit, 0);
      weekRows.push([studioShort(s.p.studio), fullNameOf(s.p), w.kw, shortDate(w.days[0]), shortDate(w.days.at(-1)!), hours2(soll), hours2(ist), hours2(ist - soll),
        days.filter((d) => d.late > 0).length, count("sick"), count("vacation"), count("vocational_school")]);
    }
  }
  sheet("Wochen", weekRows, [14, 24, 6, 8, 8, 10, 10, 10, 9, 7, 8, 8]);

  const planRows: (string | number | null)[][] = [["Monat", "Studio", "Mitarbeiter", "Schichten", "Geplant Std.", "Abwesenheit Std.", "Soll Std.", "Differenz Std.", "Urlaub", "Schule", "Frei", "Krank"]];
  for (const m of months.slice(1)) {
    for (const s of planStats(r, m).sort((a, b) => studioShort(a.p.studio).localeCompare(studioShort(b.p.studio)))) {
      planRows.push([m.label, studioShort(s.p.studio), fullNameOf(s.p), s.shifts, hours2(s.work), hours2(s.credit), hours2(s.soll), hours2(s.diff), s.vacation, s.school, s.dayOff, s.sick]);
    }
  }
  sheet("Ausblick", planRows, [16, 14, 24, 10, 12, 16, 10, 14, 8, 8, 6, 7]);

  const people = new Map(r.people.map((p) => [p.id, p]));
  sheet("Dienstplan", [
    ["Monat", "Heimatstudio", "Mitarbeiter", "Datum", "Tag", "Art", "Von", "Bis", "Stunden", "Ort", "Hinweis"],
    ...r.entries.filter((e) => people.has(e.user_id) && e.day >= vm.first).map((e) => {
      const p = people.get(e.user_id)!;
      const work = e.type === "work";
      const m = months.find((x) => e.day.startsWith(x.key));
      return [m?.label ?? "", studioShort(p.studio), fullNameOf(p), e.day.split("-").reverse().join("."), shortDayFmt.format(new Date(e.starts_at)).split(",")[0],
        entryLabel(e), work ? formatClock(e.starts_at) : "", work ? formatClock(e.ends_at) : "", work ? hours2(minutesOf(e)) : "", work ? studioShort(e.studio) : "", e.note ?? ""];
    }),
  ], [16, 14, 24, 11, 5, 9, 7, 7, 9, 12, 30]);

  // Stundenzettel je Mitarbeiter (Vormonat, Tag für Tag)
  const used = new Set<string>();
  const ABS: Record<string, string> = { sick: "Krank", vacation: "Urlaub", vocational_school: "Schule", day_off: "Frei" };
  for (const s of sorted) {
    let name = fullNameOf(s.p).replace(/[[\]:*?/\\]/g, "").slice(0, 28);
    for (let i = 2; used.has(name); i++) name = `${name.slice(0, 26)} ${i}`;
    used.add(name);
    const rows: (string | number | null)[][] = [
      [`Stundenzettel ${vm.label}`, fullNameOf(s.p), studioShort(s.p.studio)],
      ["Soll Std.", hours2(s.soll), "Ist Std.", hours2(s.ist), "Saldo Std.", hours2(s.saldo)],
      [],
      ["Datum", "Tag", "Geplant Std.", "Gearbeitet Std.", "Pause Min.", "Gutschrift Std.", "Abwesenheit", "Zu spät Min.", "Überstunden offen Min.", "Hinweis"],
    ];
    for (const d of datesBetween(vm.first, vm.last)) {
      const day = r.days.find((x) => x.user_id === s.p.id && x.day === d);
      const wd = new Intl.DateTimeFormat("de-DE", { weekday: "short", timeZone: "UTC" }).format(new Date(`${d}T12:00:00Z`));
      rows.push([d.split("-").reverse().join("."), wd, day ? hours2(day.planned) : 0, day ? hours2(day.worked) : 0, day?.break ?? 0,
        day ? hours2(day.credit) : 0, day?.absence ? ABS[day.absence] ?? day.absence : "", day?.late ?? 0, day?.ot_pending ?? 0,
        day?.open ? "Ausstempeln fehlt"
          : day && day.planned > 0 && day.worked === 0 && day.credit === 0 && !day.absence && d < r.today ? "Schicht ohne Stempelung" : ""]);
    }
    rows.push([], ["Summe", "", hours2(r.days.filter((x) => x.user_id === s.p.id && x.day >= vm.first && x.day <= vm.last).reduce((n, x) => n + x.planned, 0)),
      hours2(r.days.filter((x) => x.user_id === s.p.id && x.day >= vm.first && x.day <= vm.last).reduce((n, x) => n + x.worked, 0)), "",
      hours2(r.days.filter((x) => x.user_id === s.p.id && x.day >= vm.first && x.day <= vm.last).reduce((n, x) => n + x.credit, 0)), "", s.lateMin]);
    sheet(name, rows, [12, 6, 12, 15, 10, 15, 12, 12, 20, 18]);
  }
  return XLSX.write(wb, { type: "base64", bookType: "xlsx" }) as string;
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
        "/monatsbericht – Monatsbericht jetzt per Mail schicken",
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
    case "el":
      return await decideEarly(cq, admin, parts[1], parts[2]);
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

// Früher gegangen: krank (Rest als Krank statt Schicht) / OK (bis Schichtende) / abgelehnt (Minusstunden)
async function decideEarly(cq: CallbackQuery, admin: Admin, code: string, id: string) {
  const decision = code === "sick" ? "sick" : code === "ok" ? "approved" : "rejected";
  const { data, error } = await supabase.rpc("decide_early_leave", { p_log_id: id, p_decision: decision, p_reviewer: admin.user_id });
  if (error) return await alreadyDone(cq, `Fehler: ${error.message}`);
  if (data === "already") return await alreadyDone(cq, "Bereits entschieden.");
  const by = escapeHtml(fullName(admin.user));
  return await done(
    cq,
    decision === "sick" ? "Als krank angerechnet" : decision === "approved" ? "Bis Schichtende angerechnet" : "Abgelehnt – Minusstunden",
    decision === "sick" ? `🤒 Ab dem Gehen krank angerechnet – von ${by}`
      : decision === "approved" ? `✅ Bis Schichtende angerechnet – von ${by}` : `❌ Abgelehnt von ${by} – es zählt nur die gearbeitete Zeit`,
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
