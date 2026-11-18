// Statistik → „Stunden & Abwesenheit“: Soll/Ist, Krank, Urlaub, Schule, Verspätungen, Überstunden je Person.
// Daten aus team_stats (Datenbank prüft: Admin alle, Studioleitung ihre Leute).
import { useEffect, useMemo, useState } from "react";
import { Empty, Notice } from "../components/ui";
import { addDays, berlinDate, fmtHM } from "../lib/dates";
import { dbMessage } from "../lib/errors";
import { adminDb } from "../lib/supabase";

export type HoursRow = {
  user_id: string; first_name: string; last_name: string; home_location_id: string | null;
  weekly_target_minutes: number; target_minutes: number; worked_minutes: number; credit_minutes: number;
  late_count: number; late_minutes: number; overtime_pending_minutes: number; overtime_approved_minutes: number;
  open_days: number; forgotten_count: number; early_count: number;
  sick_days: number; vacation_days: number; school_days: number; work_shifts: number;
  counted_from?: string | null;
};

type Col = { key: string; label: string; title?: string; value: (r: HoursRow) => number; show: (r: HoursRow) => string; warn?: (r: HoursRow) => boolean };
const ist = (r: HoursRow) => r.worked_minutes + r.credit_minutes;
const COLS: Col[] = [
  { key: "target", label: "Soll", title: "Wochenstunden ÷ 5 je Werktag – ab Beginn der Zählung bis gestern", value: (r) => r.target_minutes, show: (r) => fmtHM(r.target_minutes) },
  { key: "ist", label: "Ist", title: "Gearbeitet + Gutschriften (Urlaub, Krank, Schule)", value: ist, show: (r) => fmtHM(ist(r)) },
  { key: "diff", label: "Differenz", value: (r) => ist(r) - r.target_minutes, show: (r) => `${ist(r) >= r.target_minutes ? "+" : ""}${fmtHM(ist(r) - r.target_minutes)}`, warn: (r) => ist(r) - r.target_minutes < -120 },
  { key: "shifts", label: "Schichten", value: (r) => r.work_shifts, show: (r) => String(r.work_shifts) },
  { key: "sick", label: "Krank", title: "Krankheitstage", value: (r) => r.sick_days, show: (r) => String(r.sick_days), warn: (r) => r.sick_days > 0 },
  { key: "vacation", label: "Urlaub", title: "Urlaubstage", value: (r) => r.vacation_days, show: (r) => String(r.vacation_days) },
  { key: "school", label: "Schule", title: "Schultage", value: (r) => r.school_days, show: (r) => String(r.school_days) },
  { key: "late", label: "Verspätet", title: "Anzahl (Minuten gesamt)", value: (r) => r.late_minutes, show: (r) => (r.late_count ? `${r.late_count}× (${r.late_minutes} Min.)` : "0"), warn: (r) => r.late_count > 0 },
  { key: "ot", label: "Überstunden", title: "freigegeben (offen)", value: (r) => r.overtime_approved_minutes, show: (r) => `${fmtHM(r.overtime_approved_minutes)}${r.overtime_pending_minutes ? ` (+${fmtHM(r.overtime_pending_minutes)} offen)` : ""}` },
  { key: "early", label: "Früher gegangen", value: (r) => r.early_count, show: (r) => String(r.early_count) },
  { key: "forgot", label: "Ausstempeln vergessen", value: (r) => r.forgotten_count, show: (r) => String(r.forgotten_count), warn: (r) => r.forgotten_count > 0 },
];

/** CSV für Excel */
export function hoursCsv(rows: HoursRow[], studioName: (id: string | null) => string): string {
  const head = ["Person", "Studio", ...COLS.map((c) => c.label)];
  const lines = rows.map((r) => [`${r.first_name} ${r.last_name}`, studioName(r.home_location_id), ...COLS.map((c) => c.show(r))]);
  return "﻿" + [head, ...lines].map((l) => l.map((v) => (/[;"\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)).join(";")).join("\r\n");
}

export function HoursTable(props: { from: string | null; to: string | null; label: string; studio: string; studioName: (id: string | null) => string }) {
  const today = berlinDate();
  // „Alles“: höchstens das letzte Jahr (Stundenberechnung je Tag)
  const from = props.from ?? addDays(today, -365);
  const to = props.to ? addDays(props.to, -1) : today; // die Datenbank rechnet höchstens bis gestern
  const [rows, setRows] = useState<HoursRow[] | null>(null);
  const [error, setError] = useState<string>();
  const [sort, setSort] = useState<{ key: string; desc: boolean }>({ key: "name", desc: false });

  useEffect(() => {
    setRows(null);
    if (from > today) return setRows([]);
    void adminDb.rpc("team_stats", { p_from: from, p_to: to }).then(({ data, error }) => {
      setError(error ? `Konnte nicht geladen werden: ${dbMessage(error)}` : undefined);
      setRows((data ?? []) as HoursRow[]);
    });
  }, [from, to, today]);

  const list = useMemo(() => {
    const l = (rows ?? []).filter((r) => !props.studio || r.home_location_id === props.studio);
    const col = COLS.find((c) => c.key === sort.key);
    l.sort((a, b) => {
      const c = col ? col.value(a) - col.value(b) : `${a.first_name} ${a.last_name}`.localeCompare(`${b.first_name} ${b.last_name}`, "de");
      return sort.desc ? -c : c;
    });
    return l;
  }, [rows, props.studio, sort]);

  const th = (key: string, label: string, title?: string) => (
    <th key={key} title={title} aria-sort={sort.key === key ? (sort.desc ? "descending" : "ascending") : undefined}>
      <button type="button" onClick={() => setSort((s) => ({ key, desc: s.key === key ? !s.desc : key !== "name" }))}>
        {label}{sort.key === key ? (sort.desc ? " ▾" : " ▴") : ""}
      </button>
    </th>
  );

  function exportCsv() {
    const blob = new Blob([hoursCsv(list, props.studioName)], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `Stunden ${props.label}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  const sum = (f: (r: HoursRow) => number) => list.reduce((n, r) => n + f(r), 0);
  return (
    <>
      {!props.from && <Notice>Bei „Alles“ zeigen die Stunden höchstens das letzte Jahr – je Person ab dem ersten Stempeln.</Notice>}
      {error && <Notice tone="error">{error}</Notice>}
      {rows === null && !error && <p className="list-empty">Lädt … (bei langen Zeiträumen ein paar Sekunden)</p>}
      {rows !== null && (
        <div className="stats">
          <div className="stat"><span className="stat-label">Ist / Soll</span><span className="stat-value">{fmtHM(sum(ist))} <small>/ {fmtHM(sum((r) => r.target_minutes))} Std.</small></span></div>
          <div className="stat"><span className="stat-label">Krankheitstage</span><span className="stat-value">{sum((r) => r.sick_days)}</span></div>
          <div className="stat"><span className="stat-label">Urlaubstage</span><span className="stat-value">{sum((r) => r.vacation_days)}</span></div>
          <div className="stat"><span className="stat-label">Verspätungen</span><span className="stat-value">{sum((r) => r.late_count)}</span></div>
        </div>
      )}
      {rows !== null && list.length === 0 && !error && <div className="panel"><Empty icon="inbox" title="Keine Daten">Für diesen Zeitraum gibt es nichts anzuzeigen.</Empty></div>}
      {list.length > 0 && (
        <>
          <div className="list-actions"><button type="button" className="btn btn-outline btn-sm" onClick={exportCsv}>Export (Excel)</button></div>
          <div className="panel stat-table-wrap">
            <table className="stat-table">
              <thead><tr>{th("name", "Person")}{COLS.map((c) => th(c.key, c.label, c.title))}</tr></thead>
              <tbody>
                {list.map((r) => (
                  <tr key={r.user_id}>
                    <th scope="row">{r.first_name} {r.last_name}<small>{props.studioName(r.home_location_id)} · {fmtHM(r.weekly_target_minutes)} Std./Woche{r.counted_from ? ` · ab ${r.counted_from.slice(8, 10)}.${r.counted_from.slice(5, 7)}.` : " · noch nie gestempelt"}</small></th>
                    {COLS.map((c) => <td key={c.key} className={c.warn?.(r) ? "is-warn" : c.value(r) ? "" : "is-zero"}>{c.show(r)}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="muted small">
            Soll: Wochenstunden ÷ 5 je Werktag (Mo–Fr), gezählt ab dem ersten Stempeln in Clock-In (bzw. Arbeitsbeginn) bis gestern.
            Ist: gezählte Arbeitszeit plus Gutschriften für Urlaub, Krank und Schule – wie unter Zeiten. Verspätungen sind darin schon
            abgezogen (gezählt wird ab dem echten Kommen), freigegebene Überstunden schon dazugerechnet; offene Überstunden zählen erst nach Freigabe.
          </p>
        </>
      )}
    </>
  );
}
