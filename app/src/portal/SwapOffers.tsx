// Offene Tauschanfragen an mich: beim App-Start als Fenster (Zustimmen / Ablehnen / Später) und oben in den Mitteilungen
import { useCallback, useEffect, useState } from "react";
import { Avatar, Notice, Row, Section, Sheet } from "../components/ui";
import { berlinDate, berlinTime, fmtDay } from "../lib/dates";
import { dbMessage } from "../lib/errors";
import { portalDb } from "../lib/supabase";
import { studioShort } from "../lib/types";

type Shift = { starts_at: string; ends_at: string; location: { name: string } | null };
export type SwapOffer = {
  id: string;
  reason: string | null;
  requester: { first_name: string; last_name: string } | null;
  requester_shift: Shift | null;
  target_shift: Shift | null;
};

const shiftText = (s: Shift | null) =>
  s ? `${fmtDay(berlinDate(s.starts_at))} · ${berlinTime(s.starts_at)}–${berlinTime(s.ends_at)} · ${studioShort(s.location?.name ?? "?")}` : "–";

/** Anträge an mich, denen ich noch nicht zugestimmt habe */
export async function loadSwapOffers(meId: string): Promise<SwapOffer[]> {
  const { data, error } = await portalDb
    .from("swap_requests")
    .select(`id, reason,
      requester:users!swap_requests_requester_id_fkey(first_name, last_name),
      requester_shift:shifts!swap_requests_requester_shift_id_fkey(starts_at, ends_at, location:locations(name)),
      target_shift:shifts!swap_requests_target_shift_id_fkey(starts_at, ends_at, location:locations(name))`)
    .eq("target_user_id", meId)
    .eq("status", "pending")
    .is("target_accepted_at", null)
    .order("created_at");
  if (error) return [];
  // Schicht schon vorbei → nicht mehr anzeigen
  const now = Date.now();
  return ((data ?? []) as unknown as SwapOffer[]).filter((o) => !o.requester_shift || new Date(o.requester_shift.starts_at).getTime() > now);
}

export const offerTitle = (o: SwapOffer) => `${o.requester?.first_name ?? "Jemand"} möchte mit dir tauschen`;

function OfferText(props: { offer: SwapOffer }) {
  const o = props.offer;
  return (
    <>
      Du übernimmst: {shiftText(o.requester_shift)}
      {o.target_shift && <><br />Du gibst ab: {shiftText(o.target_shift)}</>}
      {o.reason && <><br />„{o.reason}“</>}
    </>
  );
}

async function respond(id: string, accept: boolean): Promise<string | undefined> {
  const { error } = await portalDb.rpc("swap_respond", { p_id: id, p_accept: accept });
  return error ? dbMessage(error) : undefined;
}

/** Liste mit Knöpfen (Mitteilungen) */
export function SwapOfferList(props: { meId: string; onChanged?: () => void }) {
  const [offers, setOffers] = useState<SwapOffer[]>([]);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string }>();
  const load = useCallback(() => void loadSwapOffers(props.meId).then(setOffers), [props.meId]);
  useEffect(load, [load]);

  async function act(o: SwapOffer, accept: boolean) {
    const error = await respond(o.id, accept);
    setMessage(error ? { tone: "error", text: error } : { tone: "ok", text: accept ? "Zugestimmt – jetzt entscheidet die Studioleitung." : "Abgelehnt." });
    load();
    props.onChanged?.();
  }

  if (!offers.length && !message) return null;
  return (
    <>
      {message && <Notice tone={message.tone}>{message.text}</Notice>}
      {offers.length > 0 && (
        <Section title="Tauschanfragen an dich" aside={<span>{offers.length}</span>}>
          {offers.map((o) => (
            <div key={o.id} className="list-item">
              <Row leading={<Avatar first={o.requester?.first_name ?? "?"} last={o.requester?.last_name} />} title={offerTitle(o)} subtitle={<OfferText offer={o} />} />
              <div className="list-actions indent">
                <button type="button" className="btn btn-outline btn-sm" onClick={() => void act(o, false)}>Ablehnen</button>
                <button type="button" className="btn btn-primary btn-sm" onClick={() => void act(o, true)}>Zustimmen</button>
              </div>
            </div>
          ))}
        </Section>
      )}
    </>
  );
}

// „Später“: Anfrage bis morgen nicht mehr als Fenster zeigen (unter Mitteilungen bleibt sie sichtbar)
const SKIP_KEY = "clockin.swapSkip";
const today = () => new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Berlin" });
const skipped = (): string[] => {
  try {
    const v = JSON.parse(localStorage.getItem(SKIP_KEY) ?? "{}") as { day?: string; ids?: string[] };
    return v.day === today() ? (v.ids ?? []) : [];
  } catch {
    return [];
  }
};
const skip = (id: string) => {
  try {
    localStorage.setItem(SKIP_KEY, JSON.stringify({ day: today(), ids: [...skipped(), id] }));
  } catch {
    /* ohne Speicher: nur für diese Ansicht */
  }
};

/** Fenster beim App-Start: eine Anfrage nach der anderen. onDone, wenn nichts (mehr) offen ist. */
export function SwapOfferPopup(props: { meId: string; onDone: () => void }) {
  const [offers, setOffers] = useState<SwapOffer[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const { onDone } = props;

  useEffect(() => {
    void loadSwapOffers(props.meId).then((list) => {
      const open = list.filter((o) => !skipped().includes(o.id));
      setOffers(open);
      if (!open.length) onDone();
    });
  }, [props.meId, onDone]);

  if (!offers?.length) return null;
  const o = offers[0];
  const next = () => {
    const rest = offers.slice(1);
    setOffers(rest);
    setError(undefined);
    if (!rest.length) onDone();
  };
  async function act(accept: boolean) {
    setBusy(true);
    const err = await respond(o.id, accept);
    setBusy(false);
    if (err) return setError(err);
    next();
  }
  const later = () => {
    skip(o.id);
    next();
  };

  return (
    <Sheet
      title="Tauschanfrage"
      subtitle={offers.length > 1 ? `1 von ${offers.length}` : undefined}
      onClose={later}
      footer={
        <div className="list-actions">
          <button type="button" className="btn btn-plain" onClick={later} disabled={busy}>Später</button>
          <button type="button" className="btn btn-outline" onClick={() => void act(false)} disabled={busy}>Ablehnen</button>
          <button type="button" className="btn btn-primary" onClick={() => void act(true)} disabled={busy}>Zustimmen</button>
        </div>
      }
    >
      {error && <Notice tone="error">{error}</Notice>}
      <Section>
        <Row leading={<Avatar first={o.requester?.first_name ?? "?"} last={o.requester?.last_name} />} title={offerTitle(o)} subtitle={<OfferText offer={o} />} />
      </Section>
      <p className="muted small">Nach deiner Zustimmung entscheidet die Studioleitung. Mit „Später“ erinnern wir dich morgen wieder – die Anfrage steht auch unter Mitteilungen (Glocke).</p>
    </Sheet>
  );
}
