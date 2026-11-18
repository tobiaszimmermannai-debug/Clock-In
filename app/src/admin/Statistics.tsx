// Statistik (nur Admins): Kennzahlen aus dem Ausstempeln (shift_reports) je Person oder Studio.
// Zeitraum wählbar (Woche, Monat, Jahr, alles), Studio-Filter, Spalte antippen = sortieren, Export als CSV (Excel).
import { useEffect, useMemo, useState } from "react";
import { Empty, Notice, PageHeader, Segmented, StudioFilter } from "../components/ui";
import { berlinDate, berlinToISO } from "../lib/dates";
import { dbMessage } from "../lib/errors";
import { REPORT_FIELDS, type ReportKey } from "../lib/shiftReport";
import { groupReports, type Period, periodRange, type ReportRow, type StatRow, toCsv, totalRow } from "../lib/statistics";
import { adminDb } from "../lib/supabase";
import { type Location, studioShort } from "../lib/types";

type Person = { id: string; first_name: string; last_name: string; home_location_id: string | null };
type SortKey = "label" | "shifts" | "sum" | ReportKey;

const PERIODS: { id: Period; label: string }[] = [
  { id: "week", label: "Woche" },
  { id: "month", label: "Monat" },
  { id: "year", label: "Jahr" },
  { id: "all", label: "Alles" },
];

export function Statistics() {
  const today = berlinDate();
  const [period, setPeriod] = useState<Period>("month");
  const [offset, setOffset] = useState(0);
  const [group, setGroup] = useState<"person" | "studio">("person");
  const [studio, setStudio] = useState("");
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: "sum", desc: true });
  const [rows, setRows] = useState<ReportRow[] | null>(null);
  const [people, setPeople] = useState<Person[]>([]);
  const [locations, setLocations] = useState<Location[]>([]);
  const [error, setError] = useState<string>();
  const range = periodRange(period, today, offset);

  useEffect(() => {
    void Promise.all([
      adminDb.from("users").select("id, first_name, last_name, home_location_id").order("first_name"),
      adminDb.from("locations").select("id, code, name").eq("is_active", true).order("name"),
    ]).then(([u, l]) => {
      setPeople((u.data ?? []) as Person[]);
      setLocations((l.data ?? []) as Location[]);
    });
  }, []);

  useEffect(() => {
    setRows(null);
    let q = adminDb.from("shift_reports").select(`user_id, location_id, created_at, ${REPORT_FIELDS.map((f) => f.key).join(", ")}`).limit(20000);
    if (range.from) q = q.gte("created_at", berlinToISO(range.from));
    if (range.to) q = q.lt("created_at", berlinToISO(range.to));
    void q.then(({ data, error }) => {
      setError(error ? `Statistik konnte nicht geladen werden: ${dbMessage(error)}` : undefined);
      setRows((data ?? []) as unknown as ReportRow[]);
    });
  }, [range.from, range.to]);

  const personOf = useMemo(() => new Map(people.map((p) => [p.id, p])), [people]);
  const studioName = (id: string | null | undefined) => studioShort(locations.find((l) => l.id === id)?.name ?? "Ohne Studio");

  const table = useMemo(() => {
    const filtered = (rows ?? []).filter((r) => !studio || r.location_id === studio);
    const list: StatRow[] = group === "person"
      ? groupReports(filtered, (r) => r.user_id, (id) => {
          const p = personOf.get(id);
          return { label: p ? `${p.first_name} ${p.last_name}` : "Unbekannt", sub: studioName(p?.home_location_id) };
        })
      : groupReports(filtered, (r) => r.location_id ?? "", (id) => ({ label: studioName(id) }));
    const val = (r: StatRow) => (sort.key === "label" ? r.label : sort.key === "shifts" ? r.shifts : sort.key === "sum" ? r.sum : r.values[sort.key]);
    list.sort((a, b) => {
      const x = val(a);
      const y = val(b);
      const c = typeof x === "string" ? x.localeCompare(String(y), "de") : x - (y as number);
      return sort.desc ? -c : c;
    });
    return { list, total: totalRow(list) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, studio, group, sort, personOf, locations]);

  const header = (key: SortKey, label: string, title?: string) => (
    <th key={key} title={title} aria-sort={sort.key === key ? (sort.desc ? "descending" : "ascending") : undefined}>
      <button type="button" onClick={() => setSort((s) => ({ key, desc: s.key === key ? !s.desc : key !== "label" }))}>
        {label}{sort.key === key ? (sort.desc ? " ▾" : " ▴") : ""}
      </button>
    </th>
  );

  function exportCsv() {
    const blob = new Blob([toCsv([...table.list, table.total], group === "person" ? "Person" : "Studio")], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `Statistik ${range.label}${studio ? ` ${studioName(studio)}` : ""}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  return (
    <>
      <PageHeader
        title="Statistik"
        subtitle="Zahlen aus dem Ausstempeln"
        actions={<button type="button" className="btn btn-outline" disabled={!table.list.length} onClick={exportCsv}>Export (Excel)</button>}
      />
      <Segmented label="Zeitraum" value={period} onChange={(p) => { setPeriod(p); setOffset(0); }} fill options={PERIODS} />
      {period !== "all" && (
        <div className="weeknav">
          <button type="button" className="icon-btn" aria-label="Zurück" onClick={() => setOffset((o) => o - 1)}>‹</button>
          <strong>{range.label}</strong>
          <button type="button" className="icon-btn" aria-label="Weiter" disabled={offset >= 0} onClick={() => setOffset((o) => o + 1)}>›</button>
        </div>
      )}
      <div className="stat-filters">
        <Segmented label="Gruppieren" value={group} onChange={setGroup} options={[{ id: "person", label: "Je Person" }, { id: "studio", label: "Je Studio" }]} />
        <StudioFilter locations={locations} value={studio} onChange={setStudio} />
      </div>
      {error && <Notice tone="error">{error}</Notice>}
      {rows === null && !error && <p className="list-empty">Lädt …</p>}

      {rows !== null && (
        <div className="stats">
          <div className="stat"><span className="stat-label">Abgaben (Schichten)</span><span className="stat-value">{table.total.shifts}</span></div>
          <div className="stat"><span className="stat-label">Trainings</span><span className="stat-value">{table.total.values.trainings}</span></div>
          <div className="stat"><span className="stat-label">KVs</span><span className="stat-value">{table.total.values.kvs}</span></div>
          <div className="stat"><span className="stat-label">PTs ausgemacht</span><span className="stat-value">{table.total.values.pts_booked}</span></div>
        </div>
      )}

      {rows !== null && table.list.length === 0 && !error && (
        <div className="panel"><Empty icon="inbox" title="Keine Abgaben">In diesem Zeitraum wurde nach dem Ausstempeln nichts eingetragen.</Empty></div>
      )}

      {table.list.length > 0 && (
        <div className="panel stat-table-wrap">
          <table className="stat-table">
            <thead>
              <tr>
                {header("label", group === "person" ? "Person" : "Studio")}
                {header("shifts", "Schichten", "Anzahl Abgaben beim Ausstempeln")}
                {REPORT_FIELDS.map((f) => header(f.key, f.short, f.label))}
                {header("sum", "Summe")}
              </tr>
            </thead>
            <tbody>
              {table.list.map((r) => (
                <tr key={r.key}>
                  <th scope="row">{r.label}{r.sub && <small>{r.sub}</small>}</th>
                  <td>{r.shifts}</td>
                  {REPORT_FIELDS.map((f) => <td key={f.key} className={r.values[f.key] ? "" : "is-zero"}>{r.values[f.key]}</td>)}
                  <td><b>{r.sum}</b></td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <th scope="row">Gesamt</th>
                <td>{table.total.shifts}</td>
                {REPORT_FIELDS.map((f) => <td key={f.key}>{table.total.values[f.key]}</td>)}
                <td><b>{table.total.sum}</b></td>
              </tr>
              {table.total.shifts > 0 && (
                <tr className="is-avg">
                  <th scope="row">Ø je Schicht</th>
                  <td />
                  {REPORT_FIELDS.map((f) => <td key={f.key}>{(table.total.values[f.key] / table.total.shifts).toLocaleString("de-DE", { maximumFractionDigits: 1 })}</td>)}
                  <td>{(table.total.sum / table.total.shifts).toLocaleString("de-DE", { maximumFractionDigits: 1 })}</td>
                </tr>
              )}
            </tfoot>
          </table>
        </div>
      )}
      <p className="muted small">Spaltenkopf antippen zum Sortieren. Am Handy die Tabelle seitlich wischen.</p>
    </>
  );
}
