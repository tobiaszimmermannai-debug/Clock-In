// Dienstplan einer Woche: Laden (Portal und Verwaltung) und Lese-Ansicht je Tag.
// Ganztägige Abwesenheiten (Krank, Urlaub, Schule, Frei) an aufeinanderfolgenden Tagen werden zu Blöcken
// zusammengefasst (wie ein mehrtägiger Termin im Google Kalender); dafür werden die Wochen davor/danach mitgeladen.
import type { SupabaseClient } from "@supabase/supabase-js";
import { type CSSProperties, useCallback, useEffect, useMemo, useState } from "react";
import { addDays, berlinDate, berlinTime, berlinToISO, fmtLongDay, groupDays, rangeLabel } from "../lib/dates";
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
  is_herold?: boolean;
  credit_by_time?: boolean; // Schule/Prüfung als Teil des Tages (zählt mit der Dauer)
  credit_share?: number;
  user: { first_name: string; last_name: string; home_location_id?: string | null } | null;
  location: { name: string } | null;
};

// Mehrtägiger Block (Krank/Urlaub/Schule/Frei) – Wochenenden dazwischen zählen als durchgehend
export type AbsenceBlock = { key: string; from: string; to: string };
type AbsenceStub = Pick<PlanShift, "id" | "user_id" | "shift_type" | "starts_at" | "note" | "credit_by_time">;
const BLOCK_WEEKS = 6;

export function useWeekShifts(db: SupabaseClient, start: string) {
  const [shifts, setShifts] = useState<PlanShift[]>([]);
  const [around, setAround] = useState<AbsenceStub[]>([]);
  const [error, setError] = useState<string>();

  const reload = useCallback(async () => {
    const [week, absences] = await Promise.all([
      db
        .from("shifts")
        .select(
          // * statt Spaltenliste: neue Spalten (z. B. is_herold) brechen die Ansicht nicht, falls das SQL noch fehlt
          "*, user:users!shifts_user_id_fkey(first_name, last_name, home_location_id), location:locations(name)",
        )
        .gte("starts_at", berlinToISO(start))
        .lt("starts_at", berlinToISO(addDays(start, 7)))
        .order("starts_at"),
      // Abwesenheiten rund um die Woche – nur für den Zeitraum der Blöcke („20.–31. Okt.“)
      db
        .from("shifts")
        .select("*")
        .neq("shift_type", "work")
        .gte("starts_at", berlinToISO(addDays(start, -7 * BLOCK_WEEKS)))
        .lt("starts_at", berlinToISO(addDays(start, 7 * (BLOCK_WEEKS + 1))))
        .order("starts_at"),
    ]);
    setError(week.error ? dbMessage(week.error) : undefined);
    setShifts((week.data ?? []) as unknown as PlanShift[]);
    setAround((absences.data ?? []) as AbsenceStub[]);
  }, [db, start]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Eintrag → Block (gleiche Person, gleiche Art, bei Schule gleicher Kurs, aufeinanderfolgende Tage)
  const blocks = useMemo(() => {
    const groups = new Map<string, AbsenceStub[]>();
    for (const s of [...around, ...shifts]) {
      if (!isAllDay(s)) continue;
      const key = `${s.user_id}|${s.shift_type}|${courseOf(s)}`;
      const list = groups.get(key) ?? [];
      if (!list.some((x) => x.id === s.id)) list.push(s);
      groups.set(key, list);
    }
    const byId = new Map<string, AbsenceBlock>();
    for (const [key, list] of groups) {
      for (const g of groupDays(list, (s) => berlinDate(s.starts_at))) {
        const block = { key: `${key}|${g.from}`, from: g.from, to: g.to };
        for (const s of g.items) byId.set(s.id, block);
      }
    }
    return byId;
  }, [around, shifts]);
  const blockOf = useCallback((id: string) => blocks.get(id), [blocks]);

  return { shifts, error, reload, blockOf };
}

/** Ganztägige Abwesenheit (Krank, Urlaub, Schule, Frei) – nicht: Schule/Prüfung als Teil des Tages */
export const isAllDay = (s: Pick<PlanShift, "shift_type" | "credit_by_time">) => s.shift_type !== "work" && !s.credit_by_time;
// Kurs-Titel aus dem IST-Import („IST: Rückentraining A-Lizenz“)
const courseOf = (s: Pick<PlanShift, "shift_type" | "note">) =>
  s.shift_type === "vocational_school" && s.note?.startsWith("IST: ") ? s.note.slice(5) : "";
/** Ausgeschriebener Titel wie im Google Kalender: „Mia Lang · Schule: Rückentraining A-Lizenz“ */
export const absenceTitle = (s: PlanShift) =>
  `${s.user ? `${s.user.first_name} ${s.user.last_name}` : "?"} · ${SHIFT_TYPE_LABEL[s.shift_type]}${courseOf(s) ? `: ${courseOf(s)}` : ""}`;
/** Zeitraum des Blocks, nur wenn mehr als ein Tag */
export const blockRange = (b: AbsenceBlock | undefined) => (b && b.from !== b.to ? rangeLabel(b.from, b.to) : undefined);

export const isHelpShift = (s: PlanShift) => s.note?.startsWith("Aushilfsschicht") ?? false;
/** Krank statt geplanter Schicht (mit echten Uhrzeiten) */
export const isSickSwap = (s: PlanShift) => s.shift_type === "sick" && (s.note?.startsWith("Krank statt Schicht") ?? false);
export const shiftTime = (s: PlanShift) =>
  s.shift_type === "work" ? `${berlinTime(s.starts_at)}–${berlinTime(s.ends_at)}` : SHIFT_TYPE_LABEL[s.shift_type];

// Eine Zeile im Dienstplan: Name, Studio/Aushilfe, Uhrzeit bzw. Abwesenheit
export function ShiftRow(props: { shift: PlanShift; mine?: boolean; showStudio?: boolean; range?: string; onClick?: () => void }) {
  const s = props.shift;
  const name = s.user ? `${s.user.first_name} ${s.user.last_name}` : "?";
  // Akquise/Herold: Studio immer zeigen – es sagt, wo sie stattfinden
  const marked = s.is_acquisition || s.is_herold;
  const sub = [
    marked && s.location ? `in ${studioShort(s.location.name)}` : "",
    props.showStudio && !marked && s.location ? studioShort(s.location.name) : "",
    isHelpShift(s) ? "Aushilfe" : "",
    isSickSwap(s) ? `${berlinTime(s.starts_at)}–${berlinTime(s.ends_at)} statt Schicht` : "",
    s.shift_type === "vocational_school" && s.note?.startsWith("IST: ") ? s.note.slice(5) : "",
    props.range ?? "",
    s.credit_by_time ? `${berlinTime(s.starts_at)}–${berlinTime(s.ends_at)}${s.note ? ` ${s.note}` : ""}` : "",
    s.shift_type === "work" && s.note && !isHelpShift(s) ? s.note : "",
  ].filter(Boolean).join(" · ");
  return (
    <Row
      className="has-studio"
      style={{ "--studio": studioColor(s.location_id ?? s.user?.home_location_id) } as CSSProperties}
      leading={<Avatar first={s.user?.first_name ?? "?"} last={s.user?.last_name} color={studioColor(s.user?.home_location_id)} />}
      title={<>{name}{s.is_acquisition && <> <Pill tone="warn">Akquise</Pill></>}{s.is_herold && <> <Pill tone="warn">Herold</Pill></>}{props.mine && <> <Pill tone="accent">Du</Pill></>}</>}
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
export function WeekPlan(props: {
  start: string; shifts: PlanShift[]; studio: string; highlightUserId?: string; blockOf?: (id: string) => AbsenceBlock | undefined;
}) {
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
              <ShiftRow key={s.id} shift={s} mine={s.user_id === props.highlightUserId} showStudio={!props.studio}
                range={blockRange(props.blockOf?.(s.id))} />
            ))}
          </Section>
        );
      })}
    </>
  );
}
