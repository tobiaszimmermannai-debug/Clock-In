// Dienstplan einer Woche über alle Studios (Handy-Portal lesend, Verwaltung mit Bearbeiten)
import type { SupabaseClient } from "@supabase/supabase-js";
import { useCallback, useEffect, useState } from "react";
import { addDays, berlinDate, berlinTime, berlinToISO, fmtDay } from "../lib/dates";
import { dbMessage } from "../lib/errors";
import { SHIFT_TYPE_LABEL, type ShiftType } from "../lib/types";

export type PlanShift = {
  id: string;
  user_id: string;
  location_id: string | null;
  shift_type: ShiftType;
  starts_at: string;
  ends_at: string;
  note: string | null;
  user: { first_name: string; last_name: string } | null;
  location: { name: string } | null;
};

export function useWeekShifts(db: SupabaseClient, start: string) {
  const [shifts, setShifts] = useState<PlanShift[]>([]);
  const [error, setError] = useState<string>();

  const reload = useCallback(async () => {
    const { data, error } = await db
      .from("shifts")
      .select(
        "id, user_id, location_id, shift_type, starts_at, ends_at, note, user:users!shifts_user_id_fkey(first_name, last_name), location:locations(name)",
      )
      .gte("starts_at", berlinToISO(start))
      .lt("starts_at", berlinToISO(addDays(start, 7)))
      .order("starts_at");
    setError(error ? dbMessage(error) : undefined);
    setShifts((data ?? []) as unknown as PlanShift[]);
  }, [db, start]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { shifts, error, reload };
}

export function WeekPlan(props: {
  start: string;
  shifts: PlanShift[];
  studio: string; // "" = alle
  highlightUserId?: string;
  onSelect?: (shift: PlanShift) => void;
  onAdd?: (day: string) => void;
}) {
  const today = berlinDate();
  const days = Array.from({ length: 7 }, (_, i) => addDays(props.start, i));
  const visible = props.shifts.filter((s) =>
    props.studio ? s.location_id === props.studio : true
  );

  return (
    <div className="plan">
      {days.map((day) => {
        const items = visible.filter((s) => berlinDate(s.starts_at) === day);
        return (
          <section key={day} className={day === today ? "plan-day is-today" : "plan-day"}>
            <header className="plan-day-head">
              <strong>{fmtDay(day)}</strong>
              {props.onAdd && (
                <button type="button" className="btn-small" onClick={() => props.onAdd!(day)}>+ Schicht</button>
              )}
            </header>
            {items.length === 0 && <p className="muted small">Nichts geplant</p>}
            <ul className="plan-list">
              {items.map((s) => {
                const mine = s.user_id === props.highlightUserId;
                const content = (
                  <>
                    <span className="plan-time num">
                      {s.shift_type === "work" ? `${berlinTime(s.starts_at)}–${berlinTime(s.ends_at)}` : SHIFT_TYPE_LABEL[s.shift_type]}
                    </span>
                    <span className="plan-name">
                      {s.user ? `${s.user.first_name} ${s.user.last_name}` : "?"}
                      {mine && " (du)"}
                    </span>
                    <span className="plan-studio muted">
                      {s.location?.name.replace(/^Studio /, "") ?? ""}
                      {s.note?.startsWith("Aushilfsschicht") ? " · Aushilfe" : ""}
                    </span>
                  </>
                );
                const cls = `plan-item type-${s.shift_type}${mine ? " is-mine" : ""}`;
                return (
                  <li key={s.id}>
                    {props.onSelect ? (
                      <button type="button" className={cls} onClick={() => props.onSelect!(s)}>{content}</button>
                    ) : (
                      <div className={cls}>{content}</div>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
