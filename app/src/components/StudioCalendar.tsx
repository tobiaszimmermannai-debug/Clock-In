// Dienstplan aller Studios im Kalender-Stil: Woche (Einträge je Tag) oder Tag (Zeitachse, Spalte je Studio).
// Jede Schicht erscheint in der Farbe ihres Studios, mit Name und Uhrzeit.
import { type CSSProperties, useEffect, useState } from "react";
import { addDays, berlinDate, berlinTime, weekdayShort, dayOfMonth } from "../lib/dates";
import { studioColor } from "../lib/studios";
import { type Location, SHIFT_TYPE_LABEL, studioShort } from "../lib/types";
import { type PlanShift, isHelpShift } from "./WeekPlan";
import { DayStrip, Segmented } from "./ui";

type Mode = "week" | "day";
type Column = { key: string; label: string; color?: string; today?: boolean; items: PlanShift[]; allDay: PlanShift[] };

const minutesOf = (iso: string) => {
  const [h, m] = berlinTime(iso).split(":").map(Number);
  return h * 60 + m;
};
// Ende am Folgetag (Nachtschicht) → bis Mitternacht zeichnen
const endMinutes = (s: PlanShift) => (berlinDate(s.ends_at) !== berlinDate(s.starts_at) ? 24 * 60 : minutesOf(s.ends_at));
const shortName = (s: PlanShift) => (s.user ? `${s.user.first_name} ${s.user.last_name[0] ?? ""}.` : "?");

// Überlappende Schichten nebeneinander (wie im Google Kalender)
function layout(items: PlanShift[]) {
  type Placed = { shift: PlanShift; lane: number; lanes: number };
  const sorted = [...items].sort((a, b) => minutesOf(a.starts_at) - minutesOf(b.starts_at) || endMinutes(b) - endMinutes(a));
  const out: Placed[] = [];
  let cluster: Placed[] = [];
  let laneEnds: number[] = [];
  let clusterEnd = 0;
  const flush = () => {
    for (const c of cluster) c.lanes = laneEnds.length;
    out.push(...cluster);
    cluster = [];
    laneEnds = [];
  };
  for (const shift of sorted) {
    const start = minutesOf(shift.starts_at);
    const end = endMinutes(shift);
    if (cluster.length && start >= clusterEnd) flush();
    let lane = laneEnds.findIndex((e) => e <= start);
    if (lane === -1) lane = laneEnds.push(end) - 1;
    else laneEnds[lane] = end;
    clusterEnd = cluster.length ? Math.max(clusterEnd, end) : end;
    cluster.push({ shift, lane, lanes: 1 });
  }
  flush();
  return out;
}

function useNarrow() {
  const [narrow, setNarrow] = useState(() => window.matchMedia("(max-width: 720px)").matches);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 720px)");
    const onChange = () => setNarrow(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return narrow;
}

function useNowMinutes() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(t);
  }, []);
  return minutesOf(now.toISOString());
}

export function StudioCalendar(props: {
  start: string;
  shifts: PlanShift[];
  locations: Location[];
  highlightUserId?: string;
  canEdit?: (shift: PlanShift) => boolean;
  onSelect?: (shift: PlanShift) => void;
}) {
  const narrow = useNarrow();
  const today = berlinDate();
  const [mode, setMode] = useState<Mode>(narrow ? "day" : "week");
  const [day, setDay] = useState(today);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const nowMin = useNowMinutes();

  // Wochenwechsel: Tag auf heute bzw. Montag setzen
  useEffect(() => {
    setDay((d) => (d >= props.start && d < addDays(props.start, 7) ? d : today >= props.start && today < addDays(props.start, 7) ? today : props.start));
  }, [props.start, today]);

  const visibleStudios = props.locations.filter((l) => !hidden.has(l.id));
  const days = Array.from({ length: 7 }, (_, i) => addDays(props.start, i));
  const order = (id: string | null) => {
    const i = props.locations.findIndex((l) => l.id === id);
    return i === -1 ? 99 : i;
  };
  const editable = (s: PlanShift) => !!props.onSelect && (props.canEdit?.(s) ?? true);
  const homeOf = (s: PlanShift) => s.user?.home_location_id ?? null;
  const isVisible = (s: PlanShift) => !hidden.has((s.location_id ?? homeOf(s)) || "");
  const onDay = (d: string) => props.shifts.filter((s) => berlinDate(s.starts_at) === d && isVisible(s));

  const columns: Column[] = visibleStudios.map((l) => ({
    key: l.id,
    label: studioShort(l.name),
    color: studioColor(l.id),
    today: day === today,
    items: onDay(day).filter((s) => s.shift_type === "work" && s.location_id === l.id),
    allDay: onDay(day).filter((s) => s.shift_type !== "work" && homeOf(s) === l.id),
  }));

  // Sichtbarer Zeitraum: mindestens 7–21 Uhr, sonst passend zu den Schichten
  const all = columns.flatMap((c) => c.items);
  const from = Math.min(7, ...all.map((s) => Math.floor(minutesOf(s.starts_at) / 60)));
  const to = Math.max(21, ...all.map((s) => Math.ceil(endMinutes(s) / 60)));
  const hourPx = 56;
  const height = (to - from) * hourPx;
  const y = (min: number) => ((min - from * 60) / 60) * hourPx;
  const hasAllDay = columns.some((c) => c.allDay.length > 0);

  return (
    <div className="stack">
      <div className="cal-toolbar">
        <Segmented<Mode>
          label="Ansicht"
          value={mode}
          onChange={setMode}
          options={[{ id: "week", label: "Woche" }, { id: "day", label: "Tag" }]}
        />
        <div className="cal-legend" role="group" aria-label="Studios ein- und ausblenden">
          {props.locations.map((l) => (
            <button
              key={l.id}
              type="button"
              aria-pressed={!hidden.has(l.id)}
              style={{ "--studio": studioColor(l.id) } as CSSProperties}
              onClick={() =>
                setHidden((h) => {
                  const next = new Set(h);
                  if (next.has(l.id)) next.delete(l.id);
                  else next.add(l.id);
                  return next;
                })}
            >
              <span className="box" aria-hidden="true" />
              {studioShort(l.name)}
            </button>
          ))}
        </div>
      </div>
      {mode === "day" && (
        <DayStrip start={props.start} value={day} onChange={setDay}
          counts={Object.fromEntries(days.map((d) => [d, onDay(d).filter((s) => s.shift_type === "work").length]))} />
      )}

      {mode === "week" ? (
        <div className="cal cal-week">
          <div className="cal-weekgrid">
            {days.map((d) => (
              <div key={d} className={d === today ? "cal-colhead is-today" : "cal-colhead"}>
                <span>{weekdayShort(d)}</span>
                <strong>{dayOfMonth(d)}</strong>
              </div>
            ))}
            {days.map((d) => {
              const list = onDay(d);
              const work = list
                .filter((s) => s.shift_type === "work")
                .sort((a, b) => order(a.location_id) - order(b.location_id) || a.starts_at.localeCompare(b.starts_at));
              const absent = list.filter((s) => s.shift_type !== "work");
              return (
                <div key={d} className={d === today ? "cal-daycell is-today" : "cal-daycell"}>
                  {absent.map((s) => (
                    <button key={s.id} type="button" className="cal-chip"
                      style={{ "--studio": studioColor(homeOf(s)) } as CSSProperties}
                      disabled={!editable(s)} onClick={() => props.onSelect?.(s)}>
                      {shortName(s)} · {SHIFT_TYPE_LABEL[s.shift_type]}
                    </button>
                  ))}
                  {work.map((s) => (
                    <button key={s.id} type="button"
                      className={s.user_id === props.highlightUserId ? "cal-pill is-mine" : "cal-pill"}
                      style={{ "--studio": studioColor(s.location_id) } as CSSProperties}
                      disabled={!editable(s)}
                      title={`${s.user?.first_name} ${s.user?.last_name} · ${studioShort(s.location?.name ?? "")}`}
                      onClick={() => props.onSelect?.(s)}>
                      <span className="num">{berlinTime(s.starts_at)}–{berlinTime(s.ends_at)}</span>
                      <strong>{shortName(s)}</strong>
                      {isHelpShift(s) && <span>Aushilfe</span>}
                    </button>
                  ))}
                  {list.length === 0 && <span className="cal-empty">–</span>}
                </div>
              );
            })}
          </div>
        </div>
      ) : (
        <div className="cal cal-day">
          <div className="cal-grid" style={{ "--cols": columns.length } as CSSProperties}>
            <div className="cal-corner" />
            {columns.map((c) => (
              <div key={c.key} className="cal-colhead"
                style={c.color ? ({ "--studio": c.color } as CSSProperties) : undefined}>
                {c.color && <span className="box" aria-hidden="true" />}
                <span>{c.label}</span>
                </div>
            ))}

            {hasAllDay && (
              <>
                <div className="cal-gutter-label">ganztags</div>
                {columns.map((c) => (
                  <div key={c.key} className="cal-allday">
                    {c.allDay.map((s) => (
                      <button key={s.id} type="button" className="cal-chip"
                        style={{ "--studio": studioColor(homeOf(s)) } as CSSProperties}
                        disabled={!editable(s)}
                        onClick={() => props.onSelect?.(s)}>
                        {shortName(s)} · {SHIFT_TYPE_LABEL[s.shift_type]}
                      </button>
                    ))}
                  </div>
                ))}
              </>
            )}

            <div className="cal-hours" style={{ height }}>
              {Array.from({ length: to - from }, (_, i) => (
                <span key={i} style={{ top: i * hourPx }}>{String(from + i).padStart(2, "0")}:00</span>
              ))}
            </div>
            {columns.map((c) => (
              <div key={c.key} className="cal-col" style={{ height, "--hour": `${hourPx}px` } as CSSProperties}>
                {layout(c.items).map(({ shift: s, lane, lanes }) => {
                  const top = y(minutesOf(s.starts_at));
                  const h = Math.max(y(endMinutes(s)) - top, 20);
                  const mine = s.user_id === props.highlightUserId;
                    return (
                    <button
                      key={s.id}
                      type="button"
                      className={`cal-event${mine ? " is-mine" : ""}${h < 40 ? " is-short" : ""}`}
                      style={{
                        top, height: h,
                        left: `calc(${(lane / lanes) * 100}% + 2px)`,
                        width: `calc(${100 / lanes}% - 4px)`,
                        "--studio": studioColor(s.location_id),
                      } as CSSProperties}
                      disabled={!editable(s)}
                      title={`${s.user?.first_name} ${s.user?.last_name} · ${berlinTime(s.starts_at)}–${berlinTime(s.ends_at)} · ${studioShort(s.location?.name ?? "")}`}
                      onClick={() => props.onSelect?.(s)}
                    >
                      <strong>{shortName(s)}</strong>
                      <span className="num">{berlinTime(s.starts_at)}–{berlinTime(s.ends_at)}</span>
                      {isHelpShift(s) && <span>Aushilfe</span>}
                    </button>
                  );
                })}
                {c.today && nowMin >= from * 60 && nowMin <= to * 60 && (
                  <div className="cal-now" style={{ top: y(nowMin) }} aria-hidden="true" />
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
