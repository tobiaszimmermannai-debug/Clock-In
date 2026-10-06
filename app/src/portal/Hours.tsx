// Soll/Ist pro Woche und Monat, Tagesübersicht mit Stempelzeiten und Hinweisen
import { useCallback, useEffect, useState } from "react";
import { DayTable, type DaySummary, istMinutes, type Stamp, SummaryCard } from "../components/DayTable";
import { Notice, PageHeader, WeekNav } from "../components/ui";
import { addDays, berlinDate, berlinToISO, daysBetween, monthStart, weekStart } from "../lib/dates";
import { dbMessage } from "../lib/errors";
import { portalDb } from "../lib/supabase";
import type { Me } from "./PortalApp";

export function Hours({ me }: { me: Me }) {
  const today = berlinDate();
  const [start, setStart] = useState(weekStart(today));
  const [days, setDays] = useState<DaySummary[]>([]);
  const [stamps, setStamps] = useState<Stamp[]>([]);
  const [month, setMonth] = useState<{ ist: number; soll: number }>();
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

  return (
    <>
      <PageHeader title="Meine Stunden" subtitle={`Hallo ${me.first_name}!`} />
      <div className="stats">
        <SummaryCard title="Diese Woche" ist={istMinutes(days)} soll={target} />
        {month && <SummaryCard title="Monat bis heute" ist={month.ist} soll={month.soll} hint="Soll anteilig" />}
      </div>
      <WeekNav start={start} onChange={setStart} />
      {error && <Notice tone="error">{error}</Notice>}
      <DayTable days={days} stamps={stamps} />
      <details className="panel explain">
        <summary>So wird gezählt</summary>
        <p className="muted small">
          Ab Schichtbeginn (bis 5 Min. Verspätung gilt als pünktlich) bis Schichtende; Überstunden nach Freigabe.
          Jede Pause zählt mindestens 15 Min., gesetzlich 30 Min. ab 6 Std. und 45 Min. ab 9 Std. Arbeit.
          IST, Krank und Urlaub zählen je 6,5 Std. Ausstempeln vergessen? Dann zählt die Zeit erst nach Freigabe durch Tobias oder Dominik.
        </p>
      </details>
    </>
  );
}
