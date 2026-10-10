// Dienstplan einer Woche: Laden (Portal und Verwaltung) und Lese-Ansicht je Tag
import type { SupabaseClient } from "@supabase/supabase-js";
import { type CSSProperties, useCallback, useEffect, useState } from "react";
import { addDays, berlinDate, berlinTime, berlinToISO, fmtLongDay } from "../lib/dates";
import { dbMessage } from "../lib/errors";
import { studioColor } from "../lib/studios";
import { SHIFT_TYPE_LABEL, type ShiftType, studioShort } from "../lib/types";
import { Avatar, Pill, Row, Section } from "./ui";

export type PlanShift = {
  id: string;
  user_id: string;
  location_id: string | null;
  shift_type: ShiftType;
  starts_at: string;
  ends_at: string;
  note: string | null;
  is_acquisition?: boolean;
  credit_share?: number;
  user: { first_name: string; last_name: string; home_location_id?: string | null } | null;
  location: { name: string } | null;
};

export function useWeekShifts(db: SupabaseClient, start: string) {
  const [shifts, setShifts] = useState<PlanShift[]>([]);
  const [error, setError] = useState<string>();

  const reload = useCallback(async () => {
    const { data, error } = await db
      .from("shifts")
      .select(
        "id, user_id, location_id, shift_type, starts_at, ends_at, note, is_acquisition, credit_share, user:users!shifts_user_id_fkey(first_name, last_name, home_location_id), location:locations(name)",
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

export const isHelpShift = (s: PlanShift) => s.note?.startsWith("Aushilfsschicht") ?? false;
/** Krank statt geplanter Schicht (mit echten Uhrzeiten) */
export const isSickSwap = (s: PlanShift) => s.shift_type === "sick" && (s.note?.startsWith("Krank statt Schicht") ?? false);
export const shiftTime = (s: PlanShift) =>
  s.shift_type === "work" ? `${berlinTime(s.starts_at)}–${berlinTime(s.ends_at)}` : SHIFT_TYPE_LABEL[s.shift_type];

// Eine Zeile im Dienstplan: Name, Studio/Aushilfe, Uhrzeit bzw. Abwesenheit
export function ShiftRow(props: { shift: PlanShift; mine?: boolean; showStudio?: boolean; onClick?: () => void }) {
  const s = props.shift;
  const name = s.user ? `${s.user.first_name} ${s.user.last_name}` : "?";
  // Akquise: Studio immer zeigen – es sagt, wo die Akquise stattfindet
  const sub = [
    s.is_acquisition && s.location ? `in ${studioShort(s.location.name)}` : "",
    props.showStudio && !s.is_acquisition && s.location ? studioShort(s.location.name) : "",
    isHelpShift(s) ? "Aushilfe" : "",
    isSickSwap(s) ? `${berlinTime(s.starts_at)}–${berlinTime(s.ends_at)} statt Schicht` : "",
    s.shift_type === "vocational_school" && s.note?.startsWith("IST: ") ? s.note.slice(5) : "",
    s.shift_type === "work" && s.note && !isHelpShift(s) ? s.note : "",
  ].filter(Boolean).join(" · ");
  return (
    <Row
      className="has-studio"
      style={{ "--studio": studioColor(s.location_id ?? s.user?.home_location_id) } as CSSProperties}
      leading={<Avatar first={s.user?.first_name ?? "?"} last={s.user?.last_name} color={studioColor(s.user?.home_location_id)} />}
      title={<>{name}{s.is_acquisition && <> <Pill tone="warn">Akquise</Pill></>}{props.mine && <> <Pill tone="accent">Du</Pill></>}</>}
      subtitle={sub || undefined}
      trailing={
        s.shift_type === "work"
          ? <strong className="num">{shiftTime(s)}</strong>
          : <Pill tone={s.shift_type === "sick" ? "bad" : "ok"}>{SHIFT_TYPE_LABEL[s.shift_type]}</Pill>
      }
      chevron={!!props.onClick}
      onClick={props.onClick}
    />
  );
}

// Lese-Ansicht (Handy-Portal): ein Abschnitt je Tag
export function WeekPlan(props: { start: string; shifts: PlanShift[]; studio: string; highlightUserId?: string }) {
  const today = berlinDate();
  const visible = props.shifts.filter((s) => (props.studio ? s.location_id === props.studio : true));
  return (
    <>
      {Array.from({ length: 7 }, (_, i) => addDays(props.start, i)).map((day) => {
        const items = visible.filter((s) => berlinDate(s.starts_at) === day);
        return (
          <Section key={day} title={<>{fmtLongDay(day)}{day === today && " · Heute"}</>}>
            {items.length === 0 && <p className="list-empty">Nichts geplant</p>}
            {items.map((s) => (
              <ShiftRow key={s.id} shift={s} mine={s.user_id === props.highlightUserId} showStudio={!props.studio} />
            ))}
          </Section>
        );
      })}
    </>
  );
}
