// Tagesübersicht (Portal und Verwaltung): Stempelzeiten, gezählte Zeit, Pause, Hinweise
import { berlinDate, berlinTime, fmtDay, fmtHM } from "../lib/dates";
import { SHIFT_TYPE_LABEL, type ShiftType } from "../lib/types";
import { Pill } from "./ui";

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
    <div className="table-wrap">
      <table className="table daytable">
        <thead>
          <tr><th>Tag</th><th>Gezählt</th><th>Hinweise</th></tr>
        </thead>
        <tbody>
          {props.days.map((d) => {
            const stamps = props.stamps.filter((s) => berlinDate(s.recorded_at) === d.day);
            const counted = d.worked_minutes + d.credit_minutes;
            return (
              <tr key={d.day}>
                <td>
                  <strong>{fmtDay(d.day)}</strong>
                  {stamps.length > 0 && (
                    <div className="stamps">
                      {stamps.map((s, i) => (
                        <span key={s.id ?? s.recorded_at}>
                          {i > 0 && " · "}
                          {STAMP_LABEL[s.event_type]} {berlinTime(s.recorded_at)}
                          {SOURCE_HINT[s.source ?? ""] ?? ""}
                          {s.approval_status === "pending" ? " (wartet)" : s.approval_status === "rejected" ? " (abgelehnt)" : ""}
                        </span>
                      ))}
                    </div>
                  )}
                </td>
                <td className="num">
                  {counted ? fmtHM(counted) : "–"}
                  {d.break_minutes > 0 && <div className="stamps">Pause {fmtHM(d.break_minutes)}</div>}
                </td>
                <td>
                  <div className="badges">
                    {d.absence && <Pill tone="ok">{SHIFT_TYPE_LABEL[d.absence]}</Pill>}
                    {d.late_minutes > 0 && <Pill tone="warn">{d.late_minutes} Min. zu spät</Pill>}
                    {d.overtime_pending_minutes > 0 && <Pill tone="warn">{d.overtime_pending_minutes} Min. Ü offen</Pill>}
                    {d.overtime_approved_minutes > 0 && <Pill tone="ok">{d.overtime_approved_minutes} Min. Ü</Pill>}
                    {d.open_session && d.day !== today && <Pill tone="bad">Ausstempeln fehlt</Pill>}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function SummaryCard(props: { title: string; ist: number; soll: number; hint?: string }) {
  const diff = props.ist - props.soll;
  return (
    <div className="card">
      <span className="muted small">{props.title}{props.hint ? ` · ${props.hint}` : ""}</span>
      <span className="big">{fmtHM(props.ist)} <span className="muted small">/ {fmtHM(props.soll)} Std.</span></span>
      <span className={diff >= 0 ? "diff-plus" : "diff-minus"}>{diff >= 0 ? "+" : ""}{fmtHM(diff)} Std.</span>
    </div>
  );
}
