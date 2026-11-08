// Reiter „Statistik“: Kennzahlen aus dem Ausstempeln (shift_reports).
// Jede Person sieht nur die eigenen Zahlen (Tag, Woche, Monat, Alltime). Tobias & Dominik (Admin) sehen alle
// in einer Tabelle (sortieren, filtern, Zeitraum wählbar); die Studioleitung ihr Heimatstudio (RLS).
import { useEffect, useMemo, useState } from "react";
import { weekStart } from "../gamification/stats";
import { useNotes } from "../state";
import type { ShiftReport } from "../types";
import { addDays, isoDay, today } from "../util";
import { REPORT_FIELDS, type ReportKey, reportSum, sumReports } from "./report";

type Period = "day" | "week" | "month" | "all";
const PERIODS: { id: Period; label: string }[] = [
  { id: "day", label: "Tag" },
  { id: "week", label: "Woche" },
  { id: "month", label: "Monat" },
  { id: "all", label: "Alltime" },
];

/** Zeitraum zu einem Tag (Woche Mo–So wie das Wochenranking, Kalendermonat), Ende exklusiv */
export function periodBounds(period: Period, day: string): { from: string | null; to: string | null; label: string } {
  if (period === "day") return { from: day, to: addDays(day, 1), label: day.split("-").reverse().join(".") };
  if (period === "week") {
    const from = weekStart(day);
    return { from, to: addDays(from, 7), label: `Woche ab ${from.split("-").reverse().join(".")}` };
  }
  if (period === "month") {
    const from = `${day.slice(0, 7)}-01`;
    const [y, m] = from.split("-").map(Number);
    const to = isoDay(new Date(y, m, 1));
    return { from, to, label: new Date(y, m - 1, 1).toLocaleDateString("de-DE", { month: "long", year: "numeric" }) };
  }
  return { from: null, to: null, label: "seit der ersten Abgabe" };
}

const dayOfIso = (iso: string) => isoDay(new Date(iso));
const inPeriod = (r: ShiftReport, b: { from: string | null; to: string | null }) => {
  const d = dayOfIso(r.createdAt);
  return (!b.from || d >= b.from) && (!b.to || d < b.to);
};

function useReports() {
  const notes = useNotes();
  const [reports, setReports] = useState<ShiftReport[] | null>(null);
  const [error, setError] = useState<string>();
  useEffect(() => {
    let cancelled = false;
    if (!notes.store.shiftReports) return void setReports([]);
    notes.store
      .shiftReports()
      .then((r) => !cancelled && setReports(r))
      .catch((e: unknown) => !cancelled && (setError(e instanceof Error ? e.message : String(e)), setReports([])));
    return () => {
      cancelled = true;
    };
  }, [notes.store]);
  return { reports, error };
}

export function StatisticsTab() {
  const notes = useNotes();
  const { reports, error } = useReports();
  if (notes.access.studio) {
    return <p className="nk-muted">Die eigene Statistik siehst du in Clock-In auf deinem Handy (Aufgaben → Studio-Dashboard → Statistik).</p>;
  }
  if (!reports) return <p className="nk-muted">Lädt …</p>;
  return (
    <div className="nk-stats">
      {error && <p className="nk-stats-error">{error}</p>}
      <MyStatistics reports={reports.filter((r) => r.authUserId === notes.me.id)} />
      {notes.access.oversee && <TeamStatistics reports={reports} />}
    </div>
  );
}

function MyStatistics(props: { reports: ShiftReport[] }) {
  const day = today();
  return (
    <section>
      <h2 className="nk-home-heading">📊 Meine Statistik</h2>
      {props.reports.length === 0 && <p className="nk-muted">Noch keine Abgaben – die Zahlen trägst du beim Ausstempeln ein.</p>}
      <div className="nk-stats-cards">
        {PERIODS.map((p) => {
          const b = periodBounds(p.id, day);
          const list = props.reports.filter((r) => inPeriod(r, b));
          const sums = sumReports(list);
          return (
            <div key={p.id} className="nk-stats-card">
              <header>
                <b>{p.id === "day" ? "Heute" : p.id === "week" ? "Diese Woche" : p.id === "month" ? "Dieser Monat" : "Alltime"}</b>
                <span className="nk-muted">{list.length} {list.length === 1 ? "Schicht" : "Schichten"}</span>
              </header>
              <dl>
                {REPORT_FIELDS.map((f) => (
                  <div key={f.key}>
                    <dt>{f.label}</dt>
                    <dd>{sums[f.key]}</dd>
                  </div>
                ))}
              </dl>
            </div>
          );
        })}
      </div>
    </section>
  );
}

type SortKey = "name" | "studio" | "count" | "sum" | ReportKey;

function TeamStatistics(props: { reports: ShiftReport[] }) {
  const notes = useNotes();
  const [period, setPeriod] = useState<Period>("week");
  const [day, setDay] = useState(today());
  const [studio, setStudio] = useState("");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: "sum", desc: true });
  const b = periodBounds(period, day);
  const studioName = (id: string | null) => notes.locations.find((l) => l.id === id)?.name.replace(/^Studio\s+/, "") ?? "–";

  const rows = useMemo(() => {
    const byUser = new Map<string, ShiftReport[]>();
    for (const r of props.reports) if (inPeriod(r, b)) byUser.set(r.userId, [...(byUser.get(r.userId) ?? []), r]);
    const list = [...byUser.values()].map((list) => {
      const sums = sumReports(list);
      return { name: list[0].name, studioId: list[0].studioId, count: list.length, sum: reportSum(sums), sums };
    });
    const q = query.trim().toLowerCase();
    const filtered = list.filter((r) => (!studio || r.studioId === studio) && (!q || r.name.toLowerCase().includes(q)));
    const val = (r: (typeof list)[number]): string | number =>
      sort.key === "name" ? r.name : sort.key === "studio" ? studioName(r.studioId) : sort.key === "count" ? r.count : sort.key === "sum" ? r.sum : r.sums[sort.key];
    return filtered.sort((x, y) => {
      const a = val(x);
      const c = val(y);
      const cmp = typeof a === "number" && typeof c === "number" ? a - c : String(a).localeCompare(String(c), "de");
      return (sort.desc ? -cmp : cmp) || x.name.localeCompare(y.name, "de");
    });
    // studioName hängt nur an den Studios
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.reports, b.from, b.to, studio, query, sort]);

  const head = (key: SortKey, label: string, title?: string) => (
    <th aria-sort={sort.key === key ? (sort.desc ? "descending" : "ascending") : "none"}>
      <button type="button" title={title ?? label} onClick={() => setSort((s) => ({ key, desc: s.key === key ? !s.desc : key !== "name" && key !== "studio" }))}>
        {label} {sort.key === key ? (sort.desc ? "▼" : "▲") : ""}
      </button>
    </th>
  );

  return (
    <section>
      <h2 className="nk-home-heading">👥 Alle Mitarbeitenden {notes.access.admin ? "· alle Studios" : "· mein Studio"}</h2>
      <div className="nk-stats-filters">
        <select value={period} onChange={(e) => setPeriod(e.target.value as Period)} aria-label="Zeitraum">
          {PERIODS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
        </select>
        {period !== "all" && <input type="date" value={day} onChange={(e) => e.target.value && setDay(e.target.value)} aria-label="Tag im Zeitraum" />}
        <select value={studio} onChange={(e) => setStudio(e.target.value)} aria-label="Studio">
          <option value="">Alle Studios</option>
          {notes.locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
        </select>
        <input type="search" placeholder="Person suchen …" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Person" />
        <span className="nk-muted">{b.label}</span>
      </div>
      <div className="nk-stats-table-wrap">
        <table className="nk-stats-table">
          <thead>
            <tr>
              {head("name", "Person")}
              {head("studio", "Studio")}
              {head("count", "Abgaben")}
              {REPORT_FIELDS.map((f) => <th key={f.key} aria-sort={sort.key === f.key ? (sort.desc ? "descending" : "ascending") : "none"}>
                <button type="button" title={f.label} onClick={() => setSort((s) => ({ key: f.key, desc: s.key === f.key ? !s.desc : true }))}>
                  {f.short} {sort.key === f.key ? (sort.desc ? "▼" : "▲") : ""}
                </button>
              </th>)}
              {head("sum", "Summe")}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.name + r.studioId}>
                <td>{r.name}</td>
                <td>{studioName(r.studioId)}</td>
                <td className="num">{r.count}</td>
                {REPORT_FIELDS.map((f) => <td key={f.key} className="num">{r.sums[f.key]}</td>)}
                <td className="num"><b>{r.sum}</b></td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={REPORT_FIELDS.length + 4} className="nk-muted">Keine Abgaben in diesem Zeitraum.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
