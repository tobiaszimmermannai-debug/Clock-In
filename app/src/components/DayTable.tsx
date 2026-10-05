// Tagesübersicht (Portal und Verwaltung): Stempelzeiten, gezählte Zeit, Pause, Hinweise
import { berlinDate, berlinTime, fmtDay, fmtHM } from "../lib/dates";
import { SHIFT_TYPE_LABEL, type ShiftType } from "../lib/types";
import { Pill, Row, Section } from "./ui";

export type DaySummary = {
  day: string;
  planned_minutes: number;
  worked_minutes: number;
  break_minutes: number;
  credit_minutes: number;
  absence: ShiftType | null;
  late_minutes: number;
  overtime_pending_minutes: number;
  overtime_approved_minutes: number;
  open_session: boolean;
};
export type Stamp = { id?: string; event_type: string; recorded_at: string; approval_status: string; source?: string };

const STAMP_LABEL: Record<string, string> = { clock_in: "Kommen", break_start: "Pause", break_end: "zurück", clock_out: "Gehen" };
const SOURCE_HINT: Record<string, string> = { manual: " ✍️", auto_checkout: " 🤖", offline_sync: " 📶" };

export const istMinutes = (days: DaySummary[]) => days.reduce((n, d) => n + d.worked_minutes + d.credit_minutes, 0);

export function DayTable(props: { days: DaySummary[]; stamps: Stamp[] }) {
  const today = berlinDate();
  return (
    <Section title="Tage" footer="✍️ Nachtrag · 🤖 automatisch ausgestempelt · 📶 offline nachgesendet">
      {props.days.length === 0 && <p className="list-empty">Keine Daten.</p>}
      {props.days.map((d) => {
        const stamps = props.stamps.filter((s) => berlinDate(s.recorded_at) === d.day);
        const counted = d.worked_minutes + d.credit_minutes;
        const badges = [
          d.absence && <Pill key="a" tone="ok">{SHIFT_TYPE_LABEL[d.absence]}</Pill>,
          d.late_minutes > 0 && <Pill key="l" tone="warn">{d.late_minutes} Min. zu spät</Pill>,
          d.overtime_pending_minutes > 0 && <Pill key="op" tone="warn">{d.overtime_pending_minutes} Min. Ü offen</Pill>,
          d.overtime_approved_minutes > 0 && <Pill key="oa" tone="ok">{d.overtime_approved_minutes} Min. Ü</Pill>,
          d.open_session && d.day !== today && <Pill key="o" tone="bad">Ausstempeln fehlt</Pill>,
        ].filter(Boolean);
        return (
          <Row
            key={d.day}
            className={d.day === today ? "is-mine" : undefined}
            title={fmtDay(d.day)}
            subtitle={
              stamps.length > 0 ? (
                <span className="stamps">
                  {stamps.map((s, i) => (
                    <span key={s.id ?? s.recorded_at}>
                      {i > 0 && " · "}
                      {STAMP_LABEL[s.event_type]} {berlinTime(s.recorded_at)}
                      {SOURCE_HINT[s.source ?? ""] ?? ""}
                      {s.approval_status === "pending" ? " (wartet)" : s.approval_status === "rejected" ? " (abgelehnt)" : ""}
                    </span>
                  ))}
                </span>
              ) : d.planned_minutes > 0 ? `Geplant ${fmtHM(d.planned_minutes)} Std.` : undefined
            }
            trailing={
              <span className="day-hours">
                <strong>{counted ? fmtHM(counted) : "–"}</strong>
                {d.break_minutes > 0 && <span className="stamps">Pause {fmtHM(d.break_minutes)}</span>}
                {badges.length > 0 && <span className="badges">{badges}</span>}
              </span>
            }
          />
        );
      })}
    </Section>
  );
}

export function SummaryCard(props: { title: string; ist: number; soll: number; hint?: string }) {
  const diff = props.ist - props.soll;
  const share = props.soll > 0 ? Math.min(1, props.ist / props.soll) : 0;
  return (
    <div className="stat">
      <span className="stat-label">{props.title}{props.hint ? ` · ${props.hint}` : ""}</span>
      <span className="stat-value">{fmtHM(props.ist)} <small>/ {fmtHM(props.soll)} Std.</small></span>
      <span className={`stat-diff ${diff >= 0 ? "diff-plus" : "diff-minus"}`}>{diff >= 0 ? "+" : ""}{fmtHM(diff)} Std.</span>
      <span className="bar" aria-hidden="true"><span style={{ width: `${Math.round(share * 100)}%` }} /></span>
    </div>
  );
}
