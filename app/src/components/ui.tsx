// Bausteine im klassischen App-Stil: Icons, Seitenkopf, gruppierte Listen, Segmente, Bottom-Sheet
import { type CSSProperties, type ReactNode, useEffect } from "react";
import { addDays, berlinDate, dayOfMonth, isoWeek, weekRangeLabel, weekStart, weekdayShort } from "../lib/dates";
import { studioColor } from "../lib/studios";
import { type Location, studioShort } from "../lib/types";

const PATHS = {
  clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
  calendar: <><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M16 3v4M8 3v4M3 10h18" /></>,
  swap: <path d="M7 4 3 8l4 4M3 8h14M17 12l4 4-4 4M21 16H7" />,
  user: <><circle cx="12" cy="8" r="4" /><path d="M4 21c0-3.9 3.6-6 8-6s8 2.1 8 6" /></>,
  users: <><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20c0-3.6 3-5.5 6.5-5.5s6.5 1.9 6.5 5.5M16 4.6a3.5 3.5 0 0 1 0 6.8M18 14.8c2.2.6 3.5 2.4 3.5 5.2" /></>,
  inbox: <><path d="M22 12h-6l-2 3h-4l-2-3H2" /><path d="M5.5 5h13L22 12v6a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-6z" /></>,
  tablet: <><rect x="5" y="2" width="14" height="20" rx="2" /><path d="M11 18h2" /></>,
  phone: <><rect x="7" y="2" width="10" height="20" rx="2" /><path d="M11 18h2" /></>,
  shield: <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />,
  chevronLeft: <path d="m15 18-6-6 6-6" />,
  chevronRight: <path d="m9 18 6-6-6-6" />,
  plus: <path d="M12 5v14M5 12h14" />,
  check: <path d="M5 12.5 10 17 19 7" />,
  x: <path d="M18 6 6 18M6 6l12 12" />,
  logout: <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" />,
  info: <><circle cx="12" cy="12" r="9" /><path d="M12 16v-4M12 8h.01" /></>,
  alert: <><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" /><path d="M12 9v4M12 17h.01" /></>,
  checkCircle: <><circle cx="12" cy="12" r="9" /><path d="m8 12 3 3 5-6" /></>,
  face: <><path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2" /><path d="M8.5 14.5s1.3 1.5 3.5 1.5 3.5-1.5 3.5-1.5M9 9.5h.01M15 9.5h.01" /></>,
  key: <><circle cx="7.5" cy="15.5" r="4.5" /><path d="m10.7 12.3 9.3-9.3M17 6l3 3M14.5 8.5l2 2" /></>,
  login: <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4M10 17l5-5-5-5M15 12H3" />,
  coffee: <path d="M17 8h1a4 4 0 0 1 0 8h-1M3 8h14v9a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4zM6 2v3M10 2v3M14 2v3" />,
  play: <path d="M7 4.5v15l12-7.5z" />,
  building: <path d="M3 21h18M5 21V8l7-5 7 5v13M9 21v-5h6v5" />,
  pencil: <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" />,
  trash: <path d="M3 6h18M8 6V4h8v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />,
  lock: <><rect x="4" y="11" width="16" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></>,
  qr: <><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><path d="M14 14h3v3h-3zM20 14v.01M14 20h.01M17 20h4v-3" /></>,
  wifi: <path d="M5 12.6a11 11 0 0 1 14 0M1.5 9a16 16 0 0 1 21 0M8.5 16.1a6 6 0 0 1 7 0M12 20h.01" />,
} satisfies Record<string, ReactNode>;

export type IconName = keyof typeof PATHS;

export function Icon(props: { name: IconName; size?: number; stroke?: number }) {
  const size = props.size ?? 22;
  return (
    <svg
      className="icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={props.stroke ?? 2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {PATHS[props.name]}
    </svg>
  );
}

export function BrandMark(props: { size?: number }) {
  return <span className="brand-mark"><Icon name="clock" size={props.size ?? 20} stroke={2.4} /></span>;
}

export function PageHeader(props: { title: ReactNode; subtitle?: ReactNode; back?: () => void; actions?: ReactNode }) {
  return (
    <header className="page-head">
      <div className="page-head-text">
        {props.back && (
          <button type="button" className="btn btn-plain back" onClick={props.back}>
            <Icon name="chevronLeft" size={20} /> Zurück
          </button>
        )}
        <h1>{props.title}</h1>
        {props.subtitle && <p className="muted">{props.subtitle}</p>}
      </div>
      {props.actions && <div className="row">{props.actions}</div>}
    </header>
  );
}

// Gruppierte Liste mit Überschrift (wie in Einstellungs-Apps)
export function Section(props: { title?: ReactNode; aside?: ReactNode; footer?: ReactNode; children: ReactNode; plain?: boolean }) {
  return (
    <section className="group">
      {(props.title || props.aside) && (
        <h2 className="group-title"><span>{props.title}</span>{props.aside}</h2>
      )}
      {props.plain ? props.children : <div className="list">{props.children}</div>}
      {props.footer && <p className="group-foot">{props.footer}</p>}
    </section>
  );
}

export function Row(props: {
  title: ReactNode;
  subtitle?: ReactNode;
  leading?: ReactNode;
  trailing?: ReactNode;
  chevron?: boolean;
  onClick?: () => void;
  className?: string;
  style?: CSSProperties;
}) {
  const cls = ["list-row", props.leading ? "has-leading" : "", props.className ?? ""].join(" ").trim();
  const inner = (
    <>
      {props.leading}
      <span className="list-row-main">
        <span className="list-row-title">{props.title}</span>
        {props.subtitle && <span className="list-row-sub">{props.subtitle}</span>}
      </span>
      {(props.trailing || props.chevron) && (
        <span className="list-row-trail">
          {props.trailing}
          {props.chevron && <span className="chevron"><Icon name="chevronRight" size={18} /></span>}
        </span>
      )}
    </>
  );
  return props.onClick ? (
    <button type="button" className={cls} style={props.style} onClick={props.onClick}>{inner}</button>
  ) : (
    <div className={cls} style={props.style}>{inner}</div>
  );
}

const AVATAR_COLORS = ["#1f5fd6", "#0e9384", "#c4320a", "#7a5af8", "#dd2590", "#3e8a1e", "#b54708", "#155eef"];

// color: Farbe des Heimatstudios; ohne Studio eine feste Farbe aus dem Namen
export function Avatar(props: { first: string; last?: string; color?: string }) {
  const initials = `${props.first[0] ?? ""}${props.last?.[0] ?? ""}`.toUpperCase();
  let hash = 0;
  for (const ch of props.first + (props.last ?? "")) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return (
    <span className="avatar" style={{ background: props.color ?? AVATAR_COLORS[hash % AVATAR_COLORS.length] }} aria-hidden="true">
      {initials}
    </span>
  );
}

export function LeadingIcon(props: { name: IconName }) {
  return <span className="leading-icon"><Icon name={props.name} size={20} /></span>;
}

export function Segmented<T extends string>(props: {
  options: { id: T; label: string; color?: string }[];
  value: T;
  onChange: (id: T) => void;
  label: string;
}) {
  return (
    <div className="segmented" role="group" aria-label={props.label}>
      {props.options.map((o) => (
        <button key={o.id} type="button" aria-pressed={props.value === o.id} onClick={() => props.onChange(o.id)}>
          {o.color && <span className="dot" style={{ background: o.color }} aria-hidden="true" />}
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function StudioFilter(props: { locations: Location[]; value: string; onChange: (id: string) => void; all?: boolean }) {
  const options = [
    ...(props.all === false ? [] : [{ id: "", label: "Alle" }]),
    ...props.locations.map((l) => ({ id: l.id, label: studioShort(l.name), color: studioColor(l.id) })),
  ];
  return <Segmented label="Studio" options={options} value={props.value} onChange={props.onChange} />;
}

export function WeekNav(props: { start: string; onChange: (start: string) => void }) {
  const current = weekStart(berlinDate());
  return (
    <div className="weeknav">
      <button type="button" className="icon-btn" aria-label="Vorige Woche" onClick={() => props.onChange(addDays(props.start, -7))}>
        <Icon name="chevronLeft" size={20} />
      </button>
      <div className="weeknav-label num">
        <strong>KW {isoWeek(props.start)}</strong>
        <span>{weekRangeLabel(props.start)}</span>
      </div>
      <button type="button" className="icon-btn" aria-label="Nächste Woche" onClick={() => props.onChange(addDays(props.start, 7))}>
        <Icon name="chevronRight" size={20} />
      </button>
      {props.start !== current && (
        <button type="button" className="btn btn-outline btn-sm weeknav-today" onClick={() => props.onChange(current)}>Heute</button>
      )}
    </div>
  );
}

// Mo–So als Tasten; Punkte zeigen die Anzahl der Einträge
export function DayStrip(props: { start: string; value: string; onChange: (day: string) => void; counts: Record<string, number> }) {
  const today = berlinDate();
  return (
    <div className="daystrip" role="group" aria-label="Tag">
      {Array.from({ length: 7 }, (_, i) => addDays(props.start, i)).map((day) => {
        const n = props.counts[day] ?? 0;
        return (
          <button
            key={day}
            type="button"
            className={day === today ? "day-btn is-today" : "day-btn"}
            aria-pressed={props.value === day}
            aria-label={`${weekdayShort(day)} ${dayOfMonth(day)}.`}
            onClick={() => props.onChange(day)}
          >
            <span className="dow">{weekdayShort(day)}</span>
            <span className="dnum">{dayOfMonth(day)}</span>
            <span className="dots">
              {n > 3 ? <small>{n}</small> : Array.from({ length: n }, (_, k) => <i key={k} />)}
            </span>
          </button>
        );
      })}
    </div>
  );
}

export function Pill(props: { tone?: "ok" | "warn" | "bad" | "muted" | "accent"; children: ReactNode }) {
  return <span className={`pill pill-${props.tone ?? "muted"}`}>{props.children}</span>;
}

const NOTICE_ICON = { info: "info", ok: "checkCircle", warn: "alert", error: "alert" } as const;

export function Notice(props: { tone?: keyof typeof NOTICE_ICON; children: ReactNode }) {
  const tone = props.tone ?? "info";
  return (
    <div className={`notice notice-${tone}`} role={tone === "error" ? "alert" : "status"}>
      <Icon name={NOTICE_ICON[tone]} size={18} />
      <div>{props.children}</div>
    </div>
  );
}

export function Empty(props: { icon: IconName; title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <LeadingIcon name={props.icon} />
      <strong>{props.title}</strong>
      {props.children && <span className="small">{props.children}</span>}
    </div>
  );
}

export function Field(props: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="field">
      <span className="field-label">{props.label}</span>
      {props.children}
      {props.hint && <span className="field-hint">{props.hint}</span>}
    </label>
  );
}

// Bottom-Sheet (Handy) bzw. Dialog (Desktop) für Eingaben
export function Sheet(props: {
  title: ReactNode;
  subtitle?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const { onClose } = props;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
    };
  }, [onClose]);

  return (
    <div className="sheet-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sheet" role="dialog" aria-modal="true" aria-label={typeof props.title === "string" ? props.title : undefined}>
        <div className="sheet-head">
          <button type="button" className="btn btn-plain" onClick={onClose}>Abbrechen</button>
          <h2>{props.title}{props.subtitle && <span className="sub">{props.subtitle}</span>}</h2>
          <span />
        </div>
        <div className="sheet-body">{props.children}</div>
        {props.footer && <div className="sheet-foot">{props.footer}</div>}
      </div>
    </div>
  );
}
