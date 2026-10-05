// Schichttausch: primär im eigenen Studio; studioübergreifend über eigenen Knopf (beide Leitungen geben frei)
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { Avatar, Field, LeadingIcon, Notice, PageHeader, Pill, Row, Section, Sheet } from "../components/ui";
import { berlinDate, berlinTime, fmtDay } from "../lib/dates";
import { dbMessage } from "../lib/errors";
import { portalDb } from "../lib/supabase";
import { type Location, studioShort } from "../lib/types";
import type { Colleague, Me } from "./PortalApp";

type MyShift = { id: string; starts_at: string; ends_at: string; location_id: string | null; location: { name: string } | null };
type Request = {
  id: string;
  status: "pending" | "approved" | "rejected" | "cancelled";
  reason: string | null;
  is_cross_studio: boolean;
  approved_own_by: string | null;
  approved_other_by: string | null;
  requester_id: string;
  requester: { first_name: string; last_name: string } | null;
  target: { first_name: string; last_name: string } | null;
  requester_shift: MyShift | null;
  target_shift: MyShift | null;
};

const shiftWhen = (s: MyShift) => `${fmtDay(berlinDate(s.starts_at))} · ${berlinTime(s.starts_at)}–${berlinTime(s.ends_at)}`;
const shiftText = (s: MyShift | null) => (s ? `${shiftWhen(s)} · ${studioShort(s.location?.name ?? "?")}` : "–");
const name = (p: { first_name: string; last_name: string } | null) => (p ? `${p.first_name} ${p.last_name}` : "?");

async function upcomingShifts(userId: string): Promise<MyShift[]> {
  const now = new Date();
  const { data } = await portalDb
    .from("shifts")
    .select("id, starts_at, ends_at, location_id, location:locations(name)")
    .eq("user_id", userId)
    .eq("shift_type", "work")
    .gt("starts_at", now.toISOString())
    .lt("starts_at", new Date(now.getTime() + 35 * 86_400_000).toISOString())
    .order("starts_at");
  return (data ?? []) as unknown as MyShift[];
}

export function Swap(props: { me: Me; colleagues: Colleague[]; locations: Location[] }) {
  const [shifts, setShifts] = useState<MyShift[]>([]);
  const [requests, setRequests] = useState<Request[]>([]);
  const [draft, setDraft] = useState<{ shift: MyShift; cross: boolean } | null>(null);
  const [message, setMessage] = useState<string>();

  const load = useCallback(async () => {
    setShifts(await upcomingShifts(props.me.id));
    const { data } = await portalDb
      .from("swap_requests")
      .select(`id, status, reason, is_cross_studio, approved_own_by, approved_other_by, requester_id,
        requester:users!swap_requests_requester_id_fkey(first_name, last_name),
        target:users!swap_requests_target_user_id_fkey(first_name, last_name),
        requester_shift:shifts!swap_requests_requester_shift_id_fkey(id, starts_at, ends_at, location_id, location:locations(name)),
        target_shift:shifts!swap_requests_target_shift_id_fkey(id, starts_at, ends_at, location_id, location:locations(name))`)
      .order("created_at", { ascending: false })
      .limit(30);
    setRequests((data ?? []) as unknown as Request[]);
  }, [props.me.id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function cancel(id: string) {
    const { error } = await portalDb.from("swap_requests").update({ status: "cancelled" }).eq("id", id);
    setMessage(error ? dbMessage(error) : "Antrag storniert.");
    void load();
  }

  const pendingFor = (shiftId: string) =>
    requests.some((r) => r.status === "pending" && r.requester_shift?.id === shiftId);

  return (
    <>
      <PageHeader title="Schicht tauschen" />
      {message && <Notice tone="ok">{message}</Notice>}

      <Section title="Meine nächsten Schichten" footer="Tausch im eigenen Studio – „Anderes Studio“ braucht die Zustimmung beider Studioleitungen.">
        {shifts.length === 0 && <p className="list-empty">Keine Schichten in den nächsten 5 Wochen.</p>}
        {shifts.map((s) => (
          <div key={s.id} className="list-item">
            <Row
              leading={<LeadingIcon name="calendar" />}
              title={shiftWhen(s)}
              subtitle={studioShort(s.location?.name ?? "")}
              trailing={pendingFor(s.id) && <Pill tone="warn">Antrag läuft</Pill>}
            />
            {!pendingFor(s.id) && (
              <div className="list-actions indent">
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => setDraft({ shift: s, cross: false })}>Tauschen</button>
                <button type="button" className="btn btn-outline btn-sm" onClick={() => setDraft({ shift: s, cross: true })}>
                  Mit anderem Studio
                </button>
              </div>
            )}
          </div>
        ))}
      </Section>

      <Section title="Anträge">
        {requests.length === 0 && <p className="list-empty">Noch keine Anträge.</p>}
        {requests.map((r) => {
          const mine = r.requester_id === props.me.id;
          const other = mine ? r.target : r.requester;
          const approvals = (r.approved_own_by ? 1 : 0) + (r.approved_other_by ? 1 : 0);
          return (
            <div key={r.id} className="list-item">
              <Row
                leading={<Avatar first={other?.first_name ?? "?"} last={other?.last_name} />}
                title={mine ? `An ${name(r.target)}` : `Von ${name(r.requester)}`}
                subtitle={
                  <>
                    Abgabe: {shiftText(r.requester_shift)}
                    {r.target_shift && <><br />Dafür: {shiftText(r.target_shift)}</>}
                    {r.reason && <><br />„{r.reason}“</>}
                  </>
                }
                trailing={<StatusPill status={r.status} cross={r.is_cross_studio} approvals={approvals} />}
              />
              {mine && r.status === "pending" && (
                <div className="list-actions indent">
                  <button type="button" className="btn btn-outline btn-sm" onClick={() => void cancel(r.id)}>Antrag zurückziehen</button>
                </div>
              )}
            </div>
          );
        })}
      </Section>

      {draft && (
        <SwapForm
          me={props.me}
          shift={draft.shift}
          cross={draft.cross}
          colleagues={props.colleagues}
          onCancel={() => setDraft(null)}
          onSent={(text) => {
            setDraft(null);
            setMessage(text);
            void load();
          }}
        />
      )}
    </>
  );
}

function StatusPill(props: { status: Request["status"]; cross: boolean; approvals: number }) {
  if (props.status === "approved") return <Pill tone="ok">Freigegeben</Pill>;
  if (props.status === "rejected") return <Pill tone="bad">Abgelehnt</Pill>;
  if (props.status === "cancelled") return <Pill>Zurückgezogen</Pill>;
  return <Pill tone="warn">{props.cross ? `${props.approvals}/2 Freigaben` : "Wartet"}</Pill>;
}

function SwapForm(props: {
  me: Me;
  shift: MyShift;
  cross: boolean;
  colleagues: Colleague[];
  onCancel: () => void;
  onSent: (text: string) => void;
}) {
  const studioId = props.shift.location_id;
  // Normal: Kollegen desselben Studios; Studioübergreifend: Kollegen anderer Studios
  const options = props.colleagues.filter((c) =>
    c.id !== props.me.id && (props.cross ? c.home_location_id !== studioId : c.home_location_id === studioId)
  );
  const [targetId, setTargetId] = useState("");
  const [targetShifts, setTargetShifts] = useState<MyShift[]>([]);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!targetId) return setTargetShifts([]);
    void upcomingShifts(targetId).then((list) =>
      setTargetShifts(list.filter((s) => (props.cross ? true : s.location_id === studioId)))
    );
  }, [targetId, props.cross, studioId]);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true);
    const { error } = await portalDb.from("swap_requests").insert({
      requester_id: props.me.id,
      requester_shift_id: props.shift.id,
      target_user_id: targetId,
      target_shift_id: String(f.get("target_shift")) || null,
      reason: String(f.get("reason")).trim() || null,
    });
    setBusy(false);
    if (error) return setError(dbMessage(error));
    props.onSent(
      props.cross
        ? "Antrag gestellt. Beide Studioleitungen müssen zustimmen – du siehst den Stand unten."
        : "Antrag gestellt. Die Studioleitung entscheidet – du siehst den Stand unten.",
    );
  }

  return (
    <Sheet
      title={props.cross ? "Mit anderem Studio tauschen" : "Schicht tauschen"}
      subtitle={shiftText(props.shift)}
      onClose={props.onCancel}
      footer={<button type="submit" form="swap-form" className="btn btn-primary" disabled={busy || !targetId}>Antrag stellen</button>}
    >
      <form id="swap-form" className="form" onSubmit={submit}>
        {props.cross && (
          <Notice tone="warn">Studioübergreifend: Die Leitungen <b>beider</b> Studios müssen zustimmen.</Notice>
        )}
        <Field label={props.cross ? "Kollege aus anderem Studio" : "Kollege aus deinem Studio"}
          hint={options.length === 0 ? "Keine passenden Kollegen gefunden." : undefined}>
          <select id="swap-target" value={targetId} onChange={(e) => setTargetId(e.target.value)} required>
            <option value="">Bitte wählen</option>
            {options.map((c) => <option key={c.id} value={c.id}>{c.first_name} {c.last_name}</option>)}
          </select>
        </Field>
        <Field label="Gegenschicht (optional)">
          <select id="swap-target-shift" name="target_shift" defaultValue="" disabled={!targetId}>
            <option value="">Keine – Kollege übernimmt nur</option>
            {targetShifts.map((s) => <option key={s.id} value={s.id}>{shiftText(s)}</option>)}
          </select>
        </Field>
        <Field label="Grund (optional)">
          <input id="swap-reason" name="reason" maxLength={200} placeholder="z. B. Arzttermin" />
        </Field>
        {error && <Notice tone="error">{error}</Notice>}
      </form>
    </Sheet>
  );
}
