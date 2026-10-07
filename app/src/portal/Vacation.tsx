// Meine Urlaubstage: Anspruch, genommen, geplant, übrig – und die nächsten Urlaubstage
import { useEffect, useState } from "react";
import { Row, Section } from "../components/ui";
import { berlinDate, berlinToISO, fmtDay, vacationRanges } from "../lib/dates";
import { portalDb } from "../lib/supabase";

export type MyVacation = { allowance: number | null; taken: number; planned: number };

const fmt = (n: number) => String(n).replace(".", ",");
const days = (n: number) => `${fmt(n)} ${n === 1 ? "Tag" : "Tage"}`;
export const vacationLeft = (v: MyVacation) => (v.allowance === null ? null : Number(v.allowance) - v.taken - v.planned);

export function useMyVacation(year: number) {
  const [vacation, setVacation] = useState<MyVacation | null>();
  useEffect(() => {
    void portalDb.rpc("vacation_overview", { p_year: year }).then(({ data }) => setVacation((data ?? [])[0] ?? null));
  }, [year]);
  return vacation;
}

// Karte in „Meine Stunden“
export function VacationCard(props: { year: number; vacation: MyVacation | null | undefined }) {
  const v = props.vacation;
  if (v === undefined) return null;
  const left = v ? vacationLeft(v) : null;
  return (
    <div className="stat">
      <span className="stat-label">Urlaub {props.year}</span>
      {v && left !== null ? (
        <>
          <span className="stat-value">{fmt(left)} <small>von {fmt(Number(v.allowance))} Tagen übrig</small></span>
          <span className="stat-diff muted">{fmt(v.taken)} genommen · {fmt(v.planned)} geplant</span>
        </>
      ) : (
        <span className="stat-diff muted">Urlaubsanspruch noch nicht hinterlegt – bitte Tobias oder Dominik fragen.</span>
      )}
    </div>
  );
}

// Abschnitt im Konto: Zähler + nächste Urlaubstage
export function VacationSection(props: { meId: string }) {
  const today = berlinDate();
  const year = Number(today.slice(0, 4));
  const vacation = useMyVacation(year);
  const [upcoming, setUpcoming] = useState<string[]>([]);

  useEffect(() => {
    void portalDb
      .from("shifts")
      .select("starts_at")
      .eq("user_id", props.meId)
      .eq("shift_type", "vacation")
      .gte("starts_at", berlinToISO(today))
      .order("starts_at")
      .limit(120)
      .then(({ data }) => setUpcoming((data ?? []).map((r) => berlinDate(r.starts_at as string))));
  }, [props.meId, today]);

  const left = vacation ? vacationLeft(vacation) : null;
  const ranges = vacationRanges(upcoming);
  return (
    <Section title={`Mein Urlaub ${year}`} footer="Urlaub trägt deine Studioleitung im Dienstplan ein.">
      {vacation === undefined && <p className="list-empty">Lädt …</p>}
      {vacation !== undefined && (!vacation || left === null) && (
        <Row title="Urlaubsanspruch noch nicht hinterlegt" subtitle="Bitte Tobias oder Dominik fragen." />
      )}
      {vacation && left !== null && (
        <>
          <Row title={<strong>Übrig</strong>} trailing={<strong className={`num${left < 0 ? " text-danger" : ""}`}>{days(left)}</strong>} />
          <Row title="Anspruch" trailing={<span className="num">{days(Number(vacation.allowance))}</span>} />
          <Row title="Genommen" trailing={<span className="num">{days(vacation.taken)}</span>} />
          <Row title="Geplant" trailing={<span className="num">{days(vacation.planned)}</span>} />
        </>
      )}
      {ranges.slice(0, 6).map((r) => (
        <Row key={r.from} title={r.from === r.to ? fmtDay(r.from) : `${fmtDay(r.from)} – ${fmtDay(r.to)}`}
          subtitle="Urlaub geplant" trailing={<span className="num">{days(r.count)}</span>} />
      ))}
    </Section>
  );
}
