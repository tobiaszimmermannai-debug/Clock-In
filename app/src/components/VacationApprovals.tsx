// Offene Urlaubsanträge: Studioleitung stimmt zu (1. Schritt), der Freigeber gibt endgültig frei.
// Wird in der Verwaltung (Freigaben) und im Portal der Studioleitung (Mitteilungen) gezeigt.
import type { SupabaseClient } from "@supabase/supabase-js";
import { useCallback, useEffect, useState } from "react";
import { rangeLabel } from "../lib/dates";
import { dbMessage } from "../lib/errors";
import { Avatar, Field, Notice, Pill, Row, Section, Sheet } from "./ui";

export type OpenVacation = {
  id: string; user_id: string; first_name: string; last_name: string; from_day: string; to_day: string; days: number;
  note: string | null; status: "pending_lead" | "pending_final"; left_after: number; can_decide: boolean; approver: string | null;
};

const dayWord = (n: number) => `${n} ${n === 1 ? "Tag" : "Tage"}`;

export function VacationApprovals(props: { db: SupabaseClient; meId: string; onChanged?: () => void }) {
  const { db, onChanged } = props;
  const [list, setList] = useState<OpenVacation[]>([]);
  const [message, setMessage] = useState<{ tone: "ok" | "info" | "error"; text: string }>();
  const [busy, setBusy] = useState(false);
  const [reject, setReject] = useState<OpenVacation>();

  const load = useCallback(async () => {
    const { data, error } = await db.rpc("vacation_requests_open");
    if (error) return; // ältere Datenbank ohne Urlaubsanträge: Abschnitt bleibt leer
    setList(((data ?? []) as OpenVacation[]).filter((v) => v.user_id !== props.meId));
  }, [db, props.meId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function decide(v: OpenVacation, ok: boolean, note?: string) {
    if (busy) return;
    setBusy(true);
    const { data, error } = await db.rpc("vacation_request_decide", { p_id: v.id, p_ok: ok, p_note: note?.trim() || null });
    setBusy(false);
    setReject(undefined);
    setMessage(error
      ? { tone: "error", text: dbMessage(error).replace(/^Urlaub: /, "") }
      : data === "pending_final"
        ? { tone: "info", text: `Zugestimmt – jetzt gibt ${v.approver ?? "die Geschäftsführung"} endgültig frei.` }
        : { tone: "ok", text: data === "approved" ? "Urlaub freigegeben – steht im Dienstplan." : "Urlaub abgelehnt." });
    void load();
    onChanged?.();
  }

  if (!list.length && !message) return null;
  return (
    <>
      {message && <Notice tone={message.tone}>{message.text}</Notice>}
      {list.length > 0 && (
        <Section title="Urlaubsanträge" aside={<span>{list.length}</span>}
          footer="Erst stimmt die Studioleitung zu, dann gibt die Geschäftsführung frei. Danach steht der Urlaub im Dienstplan.">
          {list.map((v) => (
            <div key={v.id} className="list-item">
              <Row
                leading={<Avatar first={v.first_name} last={v.last_name} />}
                title={`${v.first_name} ${v.last_name} · ${dayWord(v.days)}`}
                subtitle={
                  <>
                    {rangeLabel(v.from_day, v.to_day)} · danach noch {String(v.left_after).replace(".", ",")} übrig
                    {v.note && <><br />„{v.note}“</>}
                  </>
                }
                trailing={<Pill tone="warn">{v.status === "pending_lead" ? "wartet auf Studioleitung" : `wartet auf ${v.approver ?? "Freigabe"}`}</Pill>}
              />
              {v.can_decide && (
                <div className="list-actions indent">
                  <button type="button" className="btn btn-outline btn-sm" disabled={busy} onClick={() => setReject(v)}>Ablehnen</button>
                  <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => void decide(v, true)}>
                    {v.status === "pending_lead" ? "Zustimmen" : "Freigeben"}
                  </button>
                </div>
              )}
            </div>
          ))}
        </Section>
      )}
      {reject && (
        <Sheet title="Urlaub ablehnen" subtitle={`${reject.first_name} ${reject.last_name} · ${rangeLabel(reject.from_day, reject.to_day)}`}
          onClose={() => setReject(undefined)}
          footer={<button type="submit" form="vac-reject" className="btn btn-danger-solid" disabled={busy}>Ablehnen</button>}>
          <form id="vac-reject" className="form" onSubmit={(e) => { e.preventDefault(); void decide(reject, false, String(new FormData(e.currentTarget).get("reason") ?? "")); }}>
            <Field label="Grund (optional)" hint="Sieht die Person in der App.">
              <input id="vac-reject-reason" name="reason" maxLength={200} placeholder="z. B. zu viele gleichzeitig im Urlaub" autoFocus />
            </Field>
          </form>
        </Sheet>
      )}
    </>
  );
}
