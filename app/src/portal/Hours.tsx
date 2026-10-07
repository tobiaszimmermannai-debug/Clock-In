// Soll/Ist pro Woche und Monat, Urlaubstage, Tagesübersicht mit Stempelzeiten und Hinweisen
import { useCallback, useEffect, useState } from "react";
import { DayTable, type DaySummary, istMinutes, type Stamp, SummaryCard } from "../components/DayTable";
import { Notice, PageHeader, WeekNav } from "../components/ui";
import { addDays, berlinDate, berlinToISO, daysBetween, fmtHM, monthStart, weekStart } from "../lib/dates";
import { dbMessage } from "../lib/errors";
import { portalDb } from "../lib/supabase";
import { ABSENCE_WEEK_DAYS } from "../lib/types";
import type { Me } from "./PortalApp";

export function Hours({ me }: { me: Me }) {
  const today = berlinDate();
  const [start, setStart] = useState(weekStart(today));
  const [days, setDays] = useState<DaySummary[]>([]);
  const [stamps, setStamps] = useState<Stamp[]>([]);
  const [month, setMonth] = useState<{ ist: number; soll: number }>();
  const [vacation, setVacation] = useState<{ allowance: number | null; taken: number; planned: number }>();
  const year = Number(today.slice(0, 4));
  const [error, setError] = useState<string>();
  const target = me.employment_details?.weekly_target_minutes ?? 0;

  const load = useCallback(async () => {
    const [summary, logs] = await Promise.all([
      portalDb.rpc("work_day_summary", { p_user: me.id, p_from: start, p_to: addDays(start, 6) }),
      portalDb
        .from("time_logs")
        .select("id, event_type, recorded_at, approval_status, source")
        .eq("user_id", me.id)
        .gte("recorded_at", berlinToISO(start))
        .lt("recorded_at", berlinToISO(addDays(start, 7)))
        .order("recorded_at"),
    ]);
    setError(summary.error ? dbMessage(summary.error) : undefined);
    setDays((summary.data ?? []) as DaySummary[]);
    setStamps((logs.data ?? []) as Stamp[]);
  }, [me.id, start]);

  // Monat bis heute (Soll anteilig: Wochenstunden ÷ 7 × Kalendertage)
  useEffect(() => {
    const from = monthStart(today);
    void portalDb.rpc("work_day_summary", { p_user: me.id, p_from: from, p_to: today }).then(({ data }) => {
      setMonth({ ist: istMinutes((data ?? []) as DaySummary[]), soll: Math.round((target / 7) * (daysBetween(from, today) + 1)) });
    });
  }, [me.id, target, today]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    void portalDb.rpc("vacation_overview", { p_year: year }).then(({ data }) => setVacation((data ?? [])[0]));
  }, [year]);

  const left = vacation && vacation.allowance !== null ? Number(vacation.allowance) - vacation.taken - vacation.planned : null;
  const fmt = (n: number) => String(n).replace(".", ",");

  return (
    <>
      <PageHeader title="Meine Stunden" subtitle={`Hallo ${me.first_name}!`} />
      <div className="stats">
        <SummaryCard title="Diese Woche" ist={istMinutes(days)} soll={target} />
        {month && <SummaryCard title="Monat bis heute" ist={month.ist} soll={month.soll} hint="Soll anteilig" />}
        {vacation && left !== null && (
          <div className="stat">
            <span className="stat-label">Urlaub {year}</span>
            <span className="stat-value">{fmt(left)} <small>von {fmt(Number(vacation.allowance))} Tagen übrig</small></span>
            <span className="stat-diff muted">{fmt(vacation.taken)} genommen · {fmt(vacation.planned)} geplant</span>
          </div>
        )}
      </div>
      <WeekNav start={start} onChange={setStart} />
      {error && <Notice tone="error">{error}</Notice>}
      <DayTable days={days} stamps={stamps} />
      <details className="panel explain">
        <summary>So wird gezählt</summary>
        <p className="muted small">
          Ab Schichtbeginn (bis 5 Min. Verspätung gilt als pünktlich) bis Schichtende; Überstunden nach Freigabe.
          Jede Pause zählt mindestens 15 Min., gesetzlich 30 Min. ab 6 Std. und 45 Min. ab 9 Std. Arbeit.
          {me.role === "trainee"
            ? `Urlaub, Schule und Krank zählen je Tag Wochenstunden ÷ ${String(ABSENCE_WEEK_DAYS).replace(".", ",")}${target > 0 ? ` (bei dir ${fmtHM(Math.round(target / ABSENCE_WEEK_DAYS))} Std.)` : ""}; krank ab einer Uhrzeit anteilig.`
            : "Urlaub und Schule zählen je 6,5 Std., Krank mit den Stunden der geplanten Schicht."}{" "}
          Ausstempeln vergessen? Dann zählt die Zeit erst nach Freigabe durch Tobias oder Dominik.
        </p>
      </details>
    </>
  );
}
