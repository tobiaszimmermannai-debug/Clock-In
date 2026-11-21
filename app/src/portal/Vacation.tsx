// Mein Resturlaub: Anspruch − genommen − eingetragen (zählt runter, sobald Urlaub im Dienstplan steht)
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { holidayName } from "../lib/holidays";
import { Field, LeadingIcon, Notice, Pill, Row, Section, Sheet } from "../components/ui";
import { absenceDays, berlinDate, berlinToISO, fmtDay, rangeLabel, vacationRanges } from "../lib/dates";
import { dbMessage } from "../lib/errors";
import { portalDb } from "../lib/supabase";
import { approvers } from "../lib/approvers";

export type MyVacation = { user_id: string; allowance: number | null; taken: number; planned: number };

const fmt = (n: number) => String(n).replace(".", ",");
const days = (n: number) => `${fmt(n)} ${n === 1 ? "Tag" : "Tage"}`;
export const vacationLeft = (v: MyVacation) => (v.allowance === null ? null : Number(v.allowance) - v.taken - v.planned);

// Eigene Zeile wählen: Studioleitungen bekommen hier auch ihre Leute zurück – nicht einfach die erste nehmen
export function useMyVacation(meId: string, year: number) {
  const [vacation, setVacation] = useState<MyVacation | null>();
  useEffect(() => {
    // Fehler: nichts anzeigen statt „Anspruch nicht hinterlegt“ (das wäre falsch)
    void portalDb.rpc("vacation_overview", { p_year: year }).then(({ data, error }) =>
      setVacation(error ? undefined : ((data ?? []) as MyVacation[]).find((v) => v.user_id === meId) ?? null));
  }, [meId, year]);
  return vacation;
}

// Karte in „Meine Stunden“
export function VacationCard(props: { year: number; vacation: MyVacation | null | undefined }) {
  const v = props.vacation;
  if (v === undefined) return null;
  const left = v ? vacationLeft(v) : null;
  return (
    <div className="stat">
      <span className="stat-label">Resturlaub {props.year}</span>
      {v && left !== null ? (
        <>
          <span className="stat-value">{fmt(left)} <small>von {fmt(Number(v.allowance))} Tagen</small></span>
          <span className="stat-diff muted">{fmt(v.taken)} genommen · {fmt(v.planned)} eingetragen</span>
        </>
      ) : (
        <span className="stat-diff muted">Urlaubsanspruch noch nicht hinterlegt – bitte {approvers()} fragen.</span>
      )}
    </div>
  );
}

// Abschnitt im Konto: Zähler + nächste Urlaubstage
export function VacationSection(props: { meId: string }) {
  const today = berlinDate();
  const year = Number(today.slice(0, 4));
  const vacation = useMyVacation(props.meId, year);
  const [upcoming, setUpcoming] = useState<string[]>([]);
  const [loadError, setLoadError] = useState<string>();

  useEffect(() => {
    void portalDb
      .from("shifts")
      .select("starts_at")
      .eq("user_id", props.meId)
      .eq("shift_type", "vacation")
      .gte("starts_at", berlinToISO(today))
      .order("starts_at")
      .limit(120)
      .then(({ data, error }) => {
        setLoadError(error ? `Urlaubstage konnten nicht geladen werden: ${dbMessage(error)}` : undefined);
        setUpcoming((data ?? []).map((r) => berlinDate(r.starts_at as string)));
      });
  }, [props.meId, today]);

  const left = vacation ? vacationLeft(vacation) : null;
  const ranges = vacationRanges(upcoming);
  // ab Oktober auch das nächste Jahr zeigen (Urlaub fürs Folgejahr wird dann schon geplant)
  const showNext = Number(today.slice(5, 7)) >= 10;
  const next = useMyVacation(props.meId, year + 1);
  const nextLeft = showNext && next ? vacationLeft(next) : null;
  return (
    <Section title={`Mein Urlaub ${year}`} footer="Urlaub beantragst du hier: erst stimmt die Studioleitung zu, dann gibt die Geschäftsführung frei.">
      {loadError && <Notice tone="error">{loadError}</Notice>}
      {vacation === undefined && !loadError && <p className="list-empty">Lädt …</p>}
      {vacation !== undefined && (!vacation || left === null) && (
        <Row title="Urlaubsanspruch noch nicht hinterlegt" subtitle={`Bitte ${approvers()} fragen.`} />
      )}
      {vacation && left !== null && (
        <>
          <Row title={<strong>Resturlaub</strong>} trailing={<strong className={`num${left < 0 ? " text-danger" : ""}`}>{days(left)}</strong>} />
          <Row title="Anspruch" trailing={<span className="num">{days(Number(vacation.allowance))}</span>} />
          <Row title="Genommen" trailing={<span className="num">{days(vacation.taken)}</span>} />
          <Row title="Eingetragen (kommt noch)" trailing={<span className="num">{days(vacation.planned)}</span>} />
        </>
      )}
      {next && nextLeft !== null && (
        <Row title={`Resturlaub ${year + 1}`} subtitle={`Anspruch ${fmt(Number(next.allowance))} · eingetragen ${fmt(next.taken + next.planned)}`}
          trailing={<span className={`num${nextLeft < 0 ? " text-danger" : ""}`}>{days(nextLeft)}</span>} />
      )}
      <VacationRequests meId={props.meId} left={left} />
      {ranges.slice(0, 6).map((r) => (
        <Row key={r.from} title={r.from === r.to ? fmtDay(r.from) : `${fmtDay(r.from)} – ${fmtDay(r.to)}`}
          subtitle="Urlaub geplant" trailing={<span className="num">{days(r.count)}</span>} />
      ))}
    </Section>
  );
}

// Kompakt auf der Startseite (Stempeln)
export function VacationRow(props: { meId: string; onOpen?: () => void }) {
  const year = Number(berlinDate().slice(0, 4));
  const v = useMyVacation(props.meId, year);
  const left = v ? vacationLeft(v) : null;
  if (!v || left === null) return null;
  return (
    <Section>
      <Row
        leading={<LeadingIcon name="sun" />}
        title={`Resturlaub ${year}`}
        subtitle={`Anspruch ${fmt(Number(v.allowance))} · genommen ${fmt(v.taken)} · eingetragen ${fmt(v.planned)}`}
        trailing={<strong className={`num${left < 0 ? " text-danger" : ""}`}>{days(left)}</strong>}
        chevron={!!props.onOpen}
        onClick={props.onOpen}
      />
    </Section>
  );
}

// Urlaub beantragen + eigene Anträge (offen, zuletzt entschieden)
type MyRequest = { id: string; from_day: string; to_day: string; days: number; status: string; decision_note: string | null };
const REQUEST_PILL: Record<string, { tone: "ok" | "warn" | "bad" | "muted"; text: string }> = {
  pending_lead: { tone: "warn", text: "wartet auf Studioleitung" },
  pending_final: { tone: "warn", text: "wartet auf Freigabe" },
  approved: { tone: "ok", text: "genehmigt" },
  rejected: { tone: "bad", text: "abgelehnt" },
  cancelled: { tone: "muted", text: "zurückgezogen" },
};

function VacationRequests(props: { meId: string; left: number | null }) {
  const today = berlinDate();
  const [list, setList] = useState<MyRequest[]>([]);
  const [open, setOpen] = useState(false);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [error, setError] = useState<string>();
  const [message, setMessage] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [available, setAvailable] = useState(true);

  const load = useCallback(async () => {
    const { data, error } = await portalDb
      .from("vacation_requests")
      .select("id, from_day, to_day, days, status, decision_note")
      .eq("user_id", props.meId)
      .order("created_at", { ascending: false })
      .limit(6);
    if (error) return setAvailable(false); // ältere Datenbank: Antrag noch nicht möglich
    setList((data ?? []) as MyRequest[]);
  }, [props.meId]);
  useEffect(() => {
    void load();
  }, [load]);

  // wie in der Datenbank: Wochenende und Feiertage zählen nicht
  const count = from && to && to >= from ? absenceDays(from, to).filter((d, _i, all) => all.length === 1 || !holidayName(d)).length : 0;

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    const note = String(new FormData(e.currentTarget).get("note") ?? "");
    const { error } = await portalDb.rpc("vacation_request_create", { p_from: from, p_to: to || from, p_note: note });
    setBusy(false);
    if (error) return setError(dbMessage(error).replace(/^Urlaub: /, ""));
    setOpen(false);
    setFrom("");
    setTo("");
    setError(undefined);
    setMessage("Antrag gestellt – du bekommst eine Mitteilung, sobald entschieden ist.");
    void load();
  }

  async function cancel(id: string) {
    const { error } = await portalDb.rpc("vacation_request_cancel", { p_id: id });
    setMessage(error ? dbMessage(error).replace(/^Urlaub: /, "") : "Antrag zurückgezogen.");
    void load();
  }

  if (!available) return null;
  return (
    <>
      {message && <Notice tone="ok">{message}</Notice>}
      <div className="list-actions">
        <button type="button" className="btn btn-primary btn-sm" onClick={() => { setOpen(true); setMessage(undefined); }}>Urlaub beantragen</button>
      </div>
      {list.map((r) => (
        <div key={r.id} className="list-item">
          <Row
            title={rangeLabel(r.from_day, r.to_day)}
            subtitle={<>{days(r.days)}{r.status === "rejected" && r.decision_note ? <> · „{r.decision_note}“</> : null}</>}
            trailing={<Pill tone={REQUEST_PILL[r.status]?.tone}>{REQUEST_PILL[r.status]?.text ?? r.status}</Pill>}
          />
          {(r.status === "pending_lead" || r.status === "pending_final") && (
            <div className="list-actions indent">
              <button type="button" className="btn btn-outline btn-sm" onClick={() => void cancel(r.id)}>Antrag zurückziehen</button>
            </div>
          )}
        </div>
      ))}
      {open && (
        <Sheet title="Urlaub beantragen" onClose={() => setOpen(false)}
          footer={<button type="submit" form="vac-form" className="btn btn-primary" disabled={busy || !from}>{busy ? "Sendet …" : "Antrag stellen"}</button>}>
          <form id="vac-form" className="form" onSubmit={submit}>
            <Field label="Von">
              <input id="vac-from" type="date" min={today} value={from} onChange={(e) => { setFrom(e.target.value); if (!to || to < e.target.value) setTo(e.target.value); }} required />
            </Field>
            <Field label="Bis" hint={count > 0 ? `${days(count)} (Mo–Fr)${props.left !== null ? ` · danach noch ${fmt(props.left - count)} übrig` : ""}` : undefined}>
              <input id="vac-to" type="date" min={from || today} value={to} onChange={(e) => setTo(e.target.value)} required />
            </Field>
            <Field label="Notiz (optional)">
              <input id="vac-note" name="note" maxLength={200} placeholder="z. B. Familienurlaub" />
            </Field>
            {props.left !== null && count > props.left && <Notice tone="warn">Das sind mehr Tage, als du noch übrig hast.</Notice>}
            {error && <Notice tone="error">{error}</Notice>}
          </form>
        </Sheet>
      )}
    </>
  );
}
