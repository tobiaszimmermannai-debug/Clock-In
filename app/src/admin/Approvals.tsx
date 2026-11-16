// Offene Freigaben: Nachträge und Überstunden (Admin), Schichttausch (beteiligte Studioleitung oder Admin)
import { useCallback, useEffect, useState } from "react";
import { Avatar, Empty, Field, Notice, PageHeader, Pill, Row, Section, Sheet } from "../components/ui";
import { berlinDate, berlinTime, fmtDay } from "../lib/dates";
import { dbMessage } from "../lib/errors";
import { adminDb } from "../lib/supabase";
import { EVENT_LABEL, type EventType, studioShort } from "../lib/types";
import type { Profile } from "./AdminApp";
import { approvers } from "../lib/approvers";
import { VacationApprovals } from "../components/VacationApprovals";

type Person = { first_name: string; last_name: string } | null;
type Booking = {
  id: string;
  event_type: EventType;
  recorded_at: string;
  source: string;
  note: string | null;
  device_unverified?: boolean;
  early_reason?: "slow" | "sick" | null;
  user: Person;
  creator: Person;
  location: { name: string } | null;
  shift: { starts_at: string; ends_at: string } | null;
};
type EarlyDecision = "sick" | "approved" | "rejected";
type ShiftRef = { starts_at: string; ends_at: string; location: { name: string } | null } | null;
type SwapRow = {
  id: string;
  reason: string | null;
  is_cross_studio: boolean;
  approved_own_by: string | null;
  approved_other_by: string | null;
  requester: Person;
  target: Person;
  requester_shift: ShiftRef;
  target_shift: ShiftRef;
};

const SOURCE_PILL: Record<string, string> = { auto_checkout: "vergessen", offline_sync: "offline" };
const name = (p: Person) => (p ? `${p.first_name} ${p.last_name}` : "?");
const when = (iso: string) => `${fmtDay(berlinDate(iso))} ${berlinTime(iso)}`;
const shiftText = (s: ShiftRef) => (s ? `${when(s.starts_at)}–${berlinTime(s.ends_at)} · ${studioShort(s.location?.name ?? "?")}` : "–");

const BOOKING_SELECT = `*,
  user:users!time_logs_user_id_fkey(first_name, last_name),
  creator:users!time_logs_created_by_fkey(first_name, last_name),
  location:locations(name), shift:shifts!time_logs_shift_id_fkey(starts_at, ends_at)`;

export function Approvals({ profile }: { profile: Profile }) {
  const isAdmin = profile.role === "admin";
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [overtime, setOvertime] = useState<Booking[]>([]);
  const [early, setEarly] = useState<Booking[]>([]);
  const [swaps, setSwaps] = useState<SwapRow[]>([]);
  const [message, setMessage] = useState<{ tone: "ok" | "info" | "error"; text: string }>();
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState<string>();
  // Ablehnen: erst kurz nach dem Grund fragen (schützt auch vor Vertippen)
  const [reject, setReject] = useState<{ kind: "booking" | "overtime" | "swap"; id: string; title: string }>();

  const load = useCallback(async () => {
    const [b, o, s, e] = await Promise.all([
      adminDb.from("time_logs").select(BOOKING_SELECT).eq("approval_status", "pending").order("recorded_at"),
      adminDb.from("time_logs").select(BOOKING_SELECT).eq("overtime_status", "pending").order("recorded_at"),
      adminDb
        .from("swap_requests")
        .select(`id, reason, is_cross_studio, approved_own_by, approved_other_by,
          requester:users!swap_requests_requester_id_fkey(first_name, last_name),
          target:users!swap_requests_target_user_id_fkey(first_name, last_name),
          requester_shift:shifts!swap_requests_requester_shift_id_fkey(starts_at, ends_at, location:locations(name)),
          target_shift:shifts!swap_requests_target_shift_id_fkey(starts_at, ends_at, location:locations(name))`)
        .eq("status", "pending")
        .not("target_accepted_at", "is", null)  // erst wenn die angefragte Person zugestimmt hat
        .order("created_at"),
      adminDb.from("time_logs").select(BOOKING_SELECT).eq("early_status", "pending").order("recorded_at"),
    ]);
    const failed = b.error ?? o.error ?? s.error ?? e.error;
    setLoadError(failed ? `Freigaben konnten nicht geladen werden: ${dbMessage(failed)}` : undefined);
    setEarly((e.data ?? []) as unknown as Booking[]);
    setBookings((b.data ?? []) as unknown as Booking[]);
    setOvertime((o.data ?? []) as unknown as Booking[]);
    setSwaps((s.data ?? []) as unknown as SwapRow[]);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function decide(kind: "booking" | "overtime" | "swap", id: string, approve: boolean, note?: string) {
    if (busy) return;
    setBusy(true);
    const reason = note?.trim() || null;
    const result = kind === "swap"
      ? await adminDb.from("swap_requests").update({ status: approve ? "approved" : "rejected", ...(reason ? { decision_note: reason } : {}) }).eq("id", id).select("status").maybeSingle()
      : await adminDb
        .from("time_logs")
        .update({
          ...(kind === "booking" ? { approval_status: approve ? "approved" : "rejected" } : { overtime_status: approve ? "approved" : "rejected" }),
          ...(reason ? { review_note: reason } : {}),
        })
        .eq("id", id)
        .select("id")
        .maybeSingle();
    setBusy(false);
    setReject(undefined);
    if (result.error) {
      setMessage({ tone: "error", text: dbMessage(result.error) });
    } else if (kind === "swap" && approve && (result.data as { status: string } | null)?.status === "pending") {
      setMessage({ tone: "info", text: "Deine Freigabe ist vermerkt – jetzt fehlt noch die Leitung des anderen Studios." });
    } else {
      setMessage({ tone: "ok", text: approve ? "Freigegeben." : "Abgelehnt." });
    }
    void load();
  }

  // Alle eines Abschnitts freigeben (nur Admin: Nachträge bzw. Überstunden)
  async function approveAll(kind: "booking" | "overtime", ids: string[]) {
    if (busy || !ids.length) return;
    setBusy(true);
    const { error } = await adminDb
      .from("time_logs")
      .update(kind === "booking" ? { approval_status: "approved" } : { overtime_status: "approved" })
      .in("id", ids);
    setBusy(false);
    setMessage(error ? { tone: "error", text: dbMessage(error) } : { tone: "ok", text: `${ids.length} freigegeben.` });
    void load();
  }

  // Früher gegangen: krank (Rest als Krank) / bis Schichtende anrechnen / ablehnen (Minusstunden)
  async function decideEarly(id: string, decision: EarlyDecision) {
    if (busy) return;
    setBusy(true);
    const { error } = await adminDb.rpc("decide_early_leave", { p_log_id: id, p_decision: decision });
    setMessage(error ? { tone: "error", text: dbMessage(error) } : {
      tone: "ok",
      text: decision === "sick" ? "Ab dem Gehen als krank angerechnet." : decision === "approved" ? "Bis Schichtende angerechnet." : "Abgelehnt – es zählt nur die gearbeitete Zeit.",
    });
    setBusy(false);
    void load();
  }

  const empty = bookings.length + overtime.length + swaps.length + early.length === 0;

  const avatar = (p: Person) => <Avatar first={p?.first_name ?? "?"} last={p?.last_name} />;

  return (
    <>
      <PageHeader title="Freigaben" />
      {message && <Notice tone={message.tone}>{message.text}</Notice>}
      {loadError && (
        <Notice tone="error">
          {loadError} <button type="button" className="btn btn-plain btn-sm" onClick={() => void load()}>Erneut versuchen</button>
        </Notice>
      )}
      <VacationApprovals db={adminDb} meId={profile.id} />
      {empty && !loadError && (
        <div className="panel">
          <Empty icon="checkCircle" title="Alles erledigt">Keine offenen Freigaben.</Empty>
        </div>
      )}

      {bookings.length > 0 && (
        <Section title="Nachträge" aside={<SectionAside count={bookings.length} enabled={isAdmin && bookings.length > 1} busy={busy} onAll={() => void approveAll("booking", bookings.map((x) => x.id))} />}
          footer={isAdmin
            ? "Bei „Ausstempeln vergessen“ ablehnen und die echte Gehzeit unter Zeiten nachtragen. „Anderes Handy“ freigeben = Handy wird für die Person gemerkt."
            : `Nachträge geben nur ${approvers()} frei.`}>
          {bookings.map((b) => (
            <div key={b.id} className="list-item">
              <Row
                leading={avatar(b.user)}
                title={`${name(b.user)} · ${b.source === "auto_checkout" ? "Ausstempeln vergessen" : EVENT_LABEL[b.event_type]}`}
                subtitle={
                  b.source === "auto_checkout"
                    ? `Automatisch zum Schichtende ${when(b.recorded_at)} · ${studioShort(b.location?.name ?? "")} – anrechnen?`
                    : `${when(b.recorded_at)} · ${studioShort(b.location?.name ?? "")}${b.note ? ` · „${b.note}“` : ""}`
                }
                trailing={<Pill tone="warn">
                  {b.device_unverified ? "anderes Handy" : SOURCE_PILL[b.source] ?? `von ${b.creator?.first_name ?? "?"}`}
                </Pill>}
              />
              <Decision enabled={isAdmin} busy={busy} onDecide={(ok) => (ok ? void decide("booking", b.id, true) : setReject({ kind: "booking", id: b.id, title: name(b.user) }))} />
            </div>
          ))}
        </Section>
      )}

      {overtime.length > 0 && (
        <Section title="Überstunden" aside={<SectionAside count={overtime.length} enabled={isAdmin && overtime.length > 1} busy={busy} onAll={() => void approveAll("overtime", overtime.map((x) => x.id))} />}
          footer={!isAdmin ? `Überstunden geben nur ${approvers()} frei.` : undefined}>
          {overtime.map((o) => {
            const minutes = o.shift ? Math.floor((Date.parse(o.recorded_at) - Date.parse(o.shift.ends_at)) / 60_000) : 0;
            return (
              <div key={o.id} className="list-item">
                <Row
                  leading={avatar(o.user)}
                  title={`${name(o.user)} · ${minutes} Min.`}
                  subtitle={`${studioShort(o.location?.name ?? "")} · Schichtende ${o.shift ? berlinTime(o.shift.ends_at) : "?"} · gegangen ${when(o.recorded_at)}`}
                />
                <Decision enabled={isAdmin} busy={busy} onDecide={(ok) => (ok ? void decide("overtime", o.id, true) : setReject({ kind: "overtime", id: o.id, title: name(o.user) }))} />
              </div>
            );
          })}
        </Section>
      )}

      {early.length > 0 && (
        <Section title="Früher gegangen" aside={<span>{early.length}</span>}
          footer={isAdmin ? "Ohne Freigabe zählt nur die gearbeitete Zeit (Minusstunden)." : `Entscheiden ${approvers()} (auch per Telegram).`}>
          {early.map((e) => {
            const minutes = e.shift ? Math.max(0, Math.round((Date.parse(e.shift.ends_at) - Date.parse(e.recorded_at)) / 60_000)) : 0;
            return (
              <div key={e.id} className="list-item">
                <Row
                  leading={avatar(e.user)}
                  title={`${name(e.user)} · ${minutes} Min. früher`}
                  subtitle={`${studioShort(e.location?.name ?? "")} · Schicht ${e.shift ? `${berlinTime(e.shift.starts_at)}–${berlinTime(e.shift.ends_at)}` : "?"} · gegangen ${when(e.recorded_at)}`}
                  trailing={<Pill tone={e.early_reason === "sick" ? "bad" : "warn"}>
                    {e.early_reason === "sick" ? "krank" : e.early_reason === "slow" ? "wenig los" : "ohne Grund"}
                  </Pill>}
                />
                {isAdmin && (
                  <div className="list-actions indent">
                    <button type="button" className="btn btn-outline btn-sm" disabled={busy} onClick={() => void decideEarly(e.id, "rejected")}>Ablehnen</button>
                    {e.early_reason !== "slow" && (
                      <button type="button" className="btn btn-outline btn-sm" disabled={busy} onClick={() => void decideEarly(e.id, "sick")}>Krank anrechnen</button>
                    )}
                    {e.early_reason !== "sick" && (
                      <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => void decideEarly(e.id, "approved")}>Bis Schichtende</button>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </Section>
      )}

      {swaps.length > 0 && (
        <Section title="Schichttausch" aside={<span>{swaps.length}</span>}>
          {swaps.map((s) => {
            const approvals = (s.approved_own_by ? 1 : 0) + (s.approved_other_by ? 1 : 0);
            return (
              <div key={s.id} className="list-item">
                <Row
                  leading={avatar(s.requester)}
                  title={`${name(s.requester)} → ${name(s.target)}`}
                  subtitle={
                    <>
                      Abgabe: {shiftText(s.requester_shift)}
                      {s.target_shift && <><br />Dafür: {shiftText(s.target_shift)}</>}
                      {s.reason && <><br />„{s.reason}“</>}
                    </>
                  }
                  trailing={s.is_cross_studio && <Pill tone="warn">2 Studios · {approvals}/2</Pill>}
                />
                <Decision enabled busy={busy} onDecide={(ok) => (ok ? void decide("swap", s.id, true) : setReject({ kind: "swap", id: s.id, title: `${name(s.requester)} → ${name(s.target)}` }))} />
              </div>
            );
          })}
        </Section>
      )}
      {reject && (
        <Sheet
          title="Ablehnen"
          subtitle={reject.title}
          onClose={() => setReject(undefined)}
          footer={<button type="submit" form="reject-form" className="btn btn-danger-solid" disabled={busy}>Ablehnen</button>}
        >
          <form
            id="reject-form"
            className="form"
            onSubmit={(e) => {
              e.preventDefault();
              void decide(reject.kind, reject.id, false, String(new FormData(e.currentTarget).get("reason") ?? ""));
            }}
          >
            <Field label="Grund (optional)" hint="Sieht die Person in der App.">
              <input id="reject-reason" name="reason" maxLength={200} placeholder="z. B. bitte echte Zeit nachtragen lassen" autoFocus />
            </Field>
          </form>
        </Sheet>
      )}
    </>
  );
}

function SectionAside(props: { count: number; enabled: boolean; busy: boolean; onAll: () => void }) {
  return (
    <span>
      {props.count}
      {props.enabled && (
        <button type="button" className="btn btn-plain btn-sm" disabled={props.busy} onClick={props.onAll}>Alle freigeben</button>
      )}
    </span>
  );
}

function Decision(props: { enabled: boolean; busy?: boolean; onDecide: (approve: boolean) => void }) {
  if (!props.enabled) return null;
  return (
    <div className="list-actions indent">
      <button type="button" className="btn btn-outline btn-sm" disabled={props.busy} onClick={() => props.onDecide(false)}>Ablehnen</button>
      <button type="button" className="btn btn-primary btn-sm" disabled={props.busy} onClick={() => props.onDecide(true)}>Freigeben</button>
    </div>
  );
}
