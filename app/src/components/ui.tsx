// Kleine wiederkehrende Bausteine: Wochen-Navigation, Studio-Filter, Status-Pillen
import type { ReactNode } from "react";
import { addDays, berlinDate, isoWeek, weekStart } from "../lib/dates";

const ddmm = (date: string) => `${date.slice(8, 10)}.${date.slice(5, 7)}.`;
import type { Location } from "../lib/types";

export function WeekNav(props: { start: string; onChange: (start: string) => void }) {
  const current = weekStart(berlinDate());
  return (
    <div className="weeknav">
      <button type="button" className="btn-small" aria-label="Vorige Woche" onClick={() => props.onChange(addDays(props.start, -7))}>‹</button>
      <strong className="num">
        KW {isoWeek(props.start)} · {ddmm(props.start)}–{ddmm(addDays(props.start, 6))}
      </strong>
      <button type="button" className="btn-small" aria-label="Nächste Woche" onClick={() => props.onChange(addDays(props.start, 7))}>›</button>
      {props.start !== current && (
        <button type="button" className="btn-small" onClick={() => props.onChange(current)}>Heute</button>
      )}
    </div>
  );
}

export function StudioFilter(props: { locations: Location[]; value: string; onChange: (id: string) => void }) {
  return (
    <div className="chips" role="group" aria-label="Studio">
      {[{ id: "", name: "Alle" }, ...props.locations].map((l) => (
        <button key={l.id} type="button" aria-pressed={props.value === l.id} onClick={() => props.onChange(l.id)}>
          {l.name.replace(/^Studio /, "")}
        </button>
      ))}
    </div>
  );
}

export function Pill(props: { tone?: "ok" | "warn" | "bad" | "muted"; children: ReactNode }) {
  return <span className={`pill pill-${props.tone ?? "muted"}`}>{props.children}</span>;
}
