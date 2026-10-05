// Offene Freigaben: Nachträge und Überstunden (Admin), Schichttausch (beteiligte Studioleitung oder Admin)
import { useCallback, useEffect, useState } from "react";
import { Avatar, Empty, Notice, PageHeader, Pill, Row, Section } from "../components/ui";
import { berlinDate, berlinTime, fmtDay } from "../lib/dates";
import { dbMessage } from "../lib/errors";
import { adminDb } from "../lib/supabase";
import { EVENT_LABEL, type EventType, studioShort } from "../lib/types";
import type { Profile } from "./AdminApp";

type Person = { first_name: string; last_name: string } | null;
type Booking = {
  id: string;
  event_type: EventType;
  recorded_at: string;
  source: string;
  note: string | null;
  user: Person;
  creator: Person;
  location: { name: string } | null;
  shift: { ends_at: string } | null;
};
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

const name = (p: Person) => (p ? `${p.first_name} ${p.last_name}` : "?");
const when = (iso: string) => `${fmtDay(berlinDate(iso))} ${berlinTime(iso)}`;
const shiftText = (s: ShiftRef) => (s ? `${when(s.starts_at)}–${berlinTime(s.ends_at)} · ${studioShort(s.location?.name ?? "?")}` : "–");

const BOOKING_SELECT = `id, event_type, recorded_at, source, note,
  user:users!time_logs_user_id_fkey(first_name, last_name),
  creator:users!time_logs_created_by_fkey(first_name, last_name),
  location:locations(name), shift:shifts!time_logs_shift_id_fkey(ends_at)`;

export function Approvals({ profile }: { profile: Profile }) {
  const isAdmin = profile.role === "admin";
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [overtime, setOvertime] = useState<Booking[]>([]);
  const [swaps, setSwaps] = useState<SwapRow[]>([]);
  const [message, setMessage] = useState<{ tone: "ok" | "info" | "error"; text: string }>();

  const load = useCallback(async () => {
    const [b, o, s] = await Promise.all([
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
        .order("created_at"),
    ]);
    setBookings((b.data ?? []) as unknown as Booking[]);
    setOvertime((o.data ?? []) as unknown as Booking[]);
    setSwaps((s.data ?? []) as unknown as SwapRow[]);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function decide(kind: "booking" | "overtime" | "swap", id: string, approve: boolean) {
    const result = kind === "swap"
      ? await adminDb.from("swap_requests").update({ status: approve ? "approved" : "rejected" }).eq("id", id).select("status").maybeSingle()
      : await adminDb
        .from("time_logs")
        .update(kind === "booking" ? { approval_status: approve ? "approved" : "rejected" } : { overtime_status: approve ? "approved" : "rejected" })
        .eq("id", id)
        .select("id")
        .maybeSingle();
    if (result.error) {
      setMessage({ tone: "error", text: dbMessage(result.error) });
    } else if (kind === "swap" && approve && (result.data as { status: string } | null)?.status === "pending") {
      setMessage({ tone: "info", text: "Deine Freigabe ist vermerkt – jetzt fehlt noch die Leitung des anderen Studios." });
    } else {
      setMessage({ tone: "ok", text: approve ? "Freigegeben." : "Abgelehnt." });
    }
    void load();
  }

  const empty = bookings.length + overtime.length + swaps.length === 0;

  const avatar = (p: Person) => <Avatar first={p?.first_name ?? "?"} last={p?.last_name} />;

  return (
    <>
      <PageHeader title="Freigaben" />
      {message && <Notice tone={message.tone}>{message.text}</Notice>}
      {empty && (
        <div className="panel">
          <Empty icon="checkCircle" title="Alles erledigt">Keine offenen Freigaben.</Empty>
        </div>
      )}

      {bookings.length > 0 && (
        <Section title="Nachträge" aside={<span>{bookings.length}</span>}
          footer={!isAdmin ? "Nachträge geben nur Tobias oder Dominik frei." : undefined}>
          {bookings.map((b) => (
            <div key={b.id} className="list-item">
              <Row
                leading={avatar(b.user)}
                title={`${name(b.user)} · ${EVENT_LABEL[b.event_type]}`}
                subtitle={`${when(b.recorded_at)} · ${studioShort(b.location?.name ?? "")}${b.note ? ` · „${b.note}“` : ""}`}
                trailing={<Pill tone="warn">{b.source === "manual" ? `von ${b.creator?.first_name ?? "?"}` : "offline"}</Pill>}
              />
              <Decision enabled={isAdmin} onDecide={(ok) => void decide("booking", b.id, ok)} />
            </div>
          ))}
        </Section>
      )}

      {overtime.length > 0 && (
        <Section title="Überstunden" aside={<span>{overtime.length}</span>}
          footer={!isAdmin ? "Überstunden geben nur Tobias oder Dominik frei." : undefined}>
          {overtime.map((o) => {
            const minutes = o.shift ? Math.floor((Date.parse(o.recorded_at) - Date.parse(o.shift.ends_at)) / 60_000) : 0;
            return (
              <div key={o.id} className="list-item">
                <Row
                  leading={avatar(o.user)}
                  title={`${name(o.user)} · ${minutes} Min.`}
                  subtitle={`${studioShort(o.location?.name ?? "")} · Schichtende ${o.shift ? berlinTime(o.shift.ends_at) : "?"} · gegangen ${when(o.recorded_at)}`}
                />
                <Decision enabled={isAdmin} onDecide={(ok) => void decide("overtime", o.id, ok)} />
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
                <Decision enabled onDecide={(ok) => void decide("swap", s.id, ok)} />
              </div>
            );
          })}
        </Section>
      )}
    </>
  );
}

function Decision(props: { enabled: boolean; onDecide: (approve: boolean) => void }) {
  if (!props.enabled) return null;
  return (
    <div className="list-actions indent">
      <button type="button" className="btn btn-outline btn-sm" onClick={() => props.onDecide(false)}>Ablehnen</button>
      <button type="button" className="btn btn-primary btn-sm" onClick={() => props.onDecide(true)}>Freigeben</button>
    </div>
  );
}
