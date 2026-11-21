// Soll/Ist pro Woche und Monat, Urlaubstage, Tagesübersicht mit Stempelzeiten und Hinweisen
import { useCallback, useEffect, useState } from "react";
import { DayTable, type DaySummary, istMinutes, type Stamp, SummaryCard } from "../components/DayTable";
import { Notice, PageHeader, WeekNav } from "../components/ui";
import { addDays, berlinDate, berlinToISO, fmtHM, isoWeek, monthStart, weekStart } from "../lib/dates";
import { dbMessage } from "../lib/errors";
import { workdaysBetween } from "../lib/holidays";
import { portalDb } from "../lib/supabase";
import { ABSENCE_WEEK_DAYS, SCHOOL_CREDIT_MINUTES } from "../lib/types";
import type { Me } from "./PortalApp";
import { VacationCard, useMyVacation } from "./Vacation";
import { approvers, currentRules } from "../lib/approvers";

export function Hours({ me }: { me: Me }) {
  const today = berlinDate();
  const [start, setStart] = useState(weekStart(today));
  const [days, setDays] = useState<DaySummary[]>([]);
  const [stamps, setStamps] = useState<Stamp[]>([]);
  const [month, setMonth] = useState<{ ist: number; soll: number }>();
  const year = Number(today.slice(0, 4));
  const vacation = useMyVacation(me.id, year);
  const [error, setError] = useState<string>();
  const target = me.employment_details?.weekly_target_minutes ?? 0;

  const load = useCallback(async () => {
    const [summary, logs] = await Promise.all([
      portalDb.rpc("work_day_summary", { p_user: me.id, p_from: start, p_to: addDays(start, 6) }),
      portalDb
        .from("time_logs")
        .select("*")
        .eq("user_id", me.id)
        .gte("recorded_at", berlinToISO(start))
        .lt("recorded_at", berlinToISO(addDays(start, 7)))
        .order("recorded_at"),
    ]);
    setError(summary.error || logs.error ? `Stunden konnten nicht geladen werden: ${dbMessage(summary.error ?? logs.error)}` : undefined);
    setDays((summary.data ?? []) as DaySummary[]);
    setStamps((logs.data ?? []) as Stamp[]);
  }, [me.id, start]);

  // Monat bis heute (Soll anteilig: Wochenstunden ÷ 5 je Werktag Mo–Fr)
  useEffect(() => {
    const from = monthStart(today);
    void portalDb.rpc("work_day_summary", { p_user: me.id, p_from: from, p_to: today }).then(({ data, error }) => {
      if (error) return setMonth(undefined);
      // Feiertage (Bayern) zählen nicht fürs Soll
      setMonth({ ist: istMinutes((data ?? []) as DaySummary[]), soll: Math.round((target / 5) * workdaysBetween(from, today)) });
    });
  }, [me.id, target, today]);

  useEffect(() => {
    void load();
  }, [load]);


  // Laufende Woche: Soll nur bis heute (geplante Schichten + Gutschriften) – sonst stünde dienstags ein dickes Minus
  const isCurrent = start === weekStart(today);
  const untilToday = days.filter((d) => d.day <= today);
  const sollNow = untilToday.reduce((n, d) => n + d.planned_minutes + d.credit_minutes, 0);
  // Wochen-Soll ohne Feiertage (z. B. Ostermontag: 4 × Wochenstunden ÷ 5)
  const weekSoll = Math.round((target / 5) * workdaysBetween(start, addDays(start, 6)));
  const partial = isCurrent && sollNow > 0 && sollNow < weekSoll;
  const rules = currentRules();

  return (
    <>
      <PageHeader title="Meine Stunden" subtitle={`Hallo ${me.first_name}!`} />
      <div className="stats">
        <SummaryCard
          title={isCurrent ? "Diese Woche" : `KW ${isoWeek(start)}`}
          ist={istMinutes(partial ? untilToday : days)}
          soll={partial ? sollNow : weekSoll}
          hint={partial ? `bis heute · Woche ${fmtHM(weekSoll)} Std.` : weekSoll < target ? "mit Feiertag" : undefined}
        />
        {month && <SummaryCard title="Monat bis heute" ist={month.ist} soll={month.soll} hint="Soll anteilig" />}
        <VacationCard year={year} vacation={vacation} />
      </div>
      <WeekNav start={start} onChange={setStart} />
      {error && <Notice tone="error">{error}</Notice>}
      <DayTable days={days} stamps={stamps} />
      <details className="panel explain">
        <summary>So wird gezählt</summary>
        <p className="muted small">
          Ab Schichtbeginn (bis {rules.late_tolerance_minutes} Min. Verspätung gilt als pünktlich) bis Schichtende; Überstunden nach Freigabe.
          Jede Pause zählt mindestens {rules.min_break_minutes} Min., gesetzlich 30 Min. ab 6 Std. und 45 Min. ab 9 Std. Arbeit.
          {me.role === "trainee"
            ? `Urlaub und Krank zählen je Tag Wochenstunden ÷ ${String(ABSENCE_WEEK_DAYS).replace(".", ",")}${target > 0 ? ` (bei dir ${fmtHM(Math.round(target / ABSENCE_WEEK_DAYS))} Std.)` : ""}, Schule ${fmtHM(SCHOOL_CREDIT_MINUTES)} Std.; krank ab einer Uhrzeit anteilig.`
            : `Urlaub zählt 6,5 Std., Schule ${fmtHM(SCHOOL_CREDIT_MINUTES)} Std., Krank mit den Stunden der geplanten Schicht.`}{" "}
          Ausstempeln vergessen? Dann zählt die Zeit erst nach Freigabe durch {approvers()}.
        </p>
      </details>
    </>
  );
}
