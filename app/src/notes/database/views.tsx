// Datenbank-Ansichten: Tabelle, Board, Liste, Kalender, Galerie
import { type DragEvent, useEffect, useState } from "react";
import { useNotes } from "../state";
import type { DbSchema, PageMeta, PropDef, PropValue, ViewDef } from "../types";
import { coverCss } from "../ui/EmojiPicker";
import { Icon } from "../ui/Icon";
import { usePopover } from "../ui/Popover";
import { addDays, between, isoDay, MONTHS, today, untitled } from "../util";
import { PropertyMenu, AddPropertyMenu } from "./DatabaseView";
import { InlineInput, Tag, ValueCell, ValueView, TYPE_ICONS } from "./cells";
import { getValue, groupRows, isEmpty, valueForGroup } from "./logic";

export type ViewProps = {
  db: PageMeta;
  schema: DbSchema;
  view: ViewDef;
  rows: PageMeta[];
  visible: PropDef[];
  locked: boolean;
  addRow: (props?: Record<string, PropValue>, opts?: { open?: boolean; position?: number }) => Promise<PageMeta | undefined>;
  updateView: (patch: Partial<ViewDef>) => void;
  updateSchema: (fn: (s: DbSchema) => DbSchema) => void;
  openRow: (id: string) => void;
  /** Neu angelegte Zeile, deren Titel direkt bearbeitet wird */
  editRow: string | null;
  clearEditRow: () => void;
};

function RowTitle(props: { row: PageMeta; onOpen: () => void; editable: boolean; autoEdit: boolean; onEdited: () => void }) {
  const notes = useNotes();
  const [editing, setEditing] = useState(props.autoEdit);
  const { row } = props;
  // Die Zeile erscheint schon vor dem Speichern – Bearbeiten startet, sobald sie als neu markiert ist
  useEffect(() => {
    if (props.autoEdit) setEditing(true);
  }, [props.autoEdit]);
  if (editing) {
    return (
      <div className="nk-cell is-title is-editing">
        <InlineInput
          initial={row.title}
          onDone={(t) => {
            setEditing(false);
            props.onEdited();
            notes.updatePage(row.id, { title: t });
          }}
        />
      </div>
    );
  }
  return (
    <div className="nk-cell is-title" onClick={() => (props.editable ? setEditing(true) : props.onOpen())}>
      {row.icon && <span className="nk-row-icon">{row.icon}</span>}
      <span className={row.title ? "nk-title-text" : "nk-title-text nk-placeholder"}>{row.title || "Ohne Titel"}</span>
      <button
        type="button"
        className="nk-open-btn"
        onClick={(e) => {
          e.stopPropagation();
          props.onOpen();
        }}
      >
        <Icon name="expand" size={12} /> Öffnen
      </button>
    </div>
  );
}

// ---------------- Tabelle ----------------

export function TableView(p: ViewProps) {
  const notes = useNotes();
  const head = usePopover();
  const add = usePopover();
  const [menuProp, setMenuProp] = useState<PropDef | null>(null);
  const [drag, setDrag] = useState<string | null>(null);
  const widths = p.view.widths ?? {};
  const width = (prop: PropDef) => widths[prop.id] ?? (prop.type === "title" ? 280 : prop.type === "checkbox" ? 90 : 180);

  const startResize = (prop: PropDef, e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const start = width(prop);
    const el = (e.currentTarget as HTMLElement).parentElement!;
    let w = start;
    const onMove = (ev: PointerEvent) => {
      w = Math.max(80, start + ev.clientX - startX);
      el.style.width = `${w}px`;
      el.closest(".nk-table")?.querySelectorAll<HTMLElement>(`[data-col="${prop.id}"]`).forEach((c) => (c.style.width = `${w}px`));
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      p.updateView({ widths: { ...widths, [prop.id]: w } });
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const manual = p.view.sorts.length === 0;
  const dropRow = (targetId: string, e: DragEvent) => {
    e.preventDefault();
    if (!drag || drag === targetId) return;
    const list = p.rows.filter((r) => r.id !== drag);
    const i = list.findIndex((r) => r.id === targetId);
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const before = e.clientY < rect.top + rect.height / 2;
    const prev = before ? list[i - 1] : list[i];
    const next = before ? list[i] : list[i + 1];
    notes.updatePage(drag, { position: between(prev?.position, next?.position) }, { delay: 0 });
    setDrag(null);
  };

  return (
    <div className="nk-table-wrap">
      <div className="nk-table" role="table">
        <div className="nk-tr nk-thead" role="row">
          {p.visible.map((prop) => (
            <div
              key={prop.id}
              className="nk-th"
              data-col={prop.id}
              style={{ width: width(prop) }}
              role="columnheader"
              onClick={(e) => {
                if (p.locked) return;
                setMenuProp(prop);
                head.open(e.currentTarget);
              }}
            >
              <Icon name={TYPE_ICONS[prop.type]} className="nk-faint" />
              <span className="nk-th-name">{prop.name}</span>
              <span className="nk-resize" onPointerDown={(e) => startResize(prop, e)} onClick={(e) => e.stopPropagation()} />
            </div>
          ))}
          {!p.locked && (
            <button type="button" className="nk-th nk-th-add" aria-label="Eigenschaft hinzufügen" onClick={(e) => add.open(e.currentTarget)}>
              <Icon name="plus" />
            </button>
          )}
        </div>
        {p.rows.map((row) => (
          <div
            key={row.id}
            className={`nk-tr${drag === row.id ? " is-dragging" : ""}`}
            role="row"
            onDragOver={(e) => manual && drag && e.preventDefault()}
            onDrop={(e) => manual && dropRow(row.id, e)}
          >
            {manual && !p.locked && (
              <span className="nk-row-handle" draggable onDragStart={() => setDrag(row.id)} onDragEnd={() => setDrag(null)} title="Ziehen zum Sortieren">
                <Icon name="drag" />
              </span>
            )}
            {p.visible.map((prop) => (
              <div key={prop.id} className="nk-td" data-col={prop.id} style={{ width: width(prop) }} role="cell">
                {prop.type === "title" ? (
                  <RowTitle
                    row={row}
                    onOpen={() => p.openRow(row.id)}
                    editable={!p.locked}
                    autoEdit={p.editRow === row.id}
                    onEdited={p.clearEditRow}
                  />
                ) : (
                  <ValueCell db={p.db} row={row} prop={prop} />
                )}
              </div>
            ))}
          </div>
        ))}
        {!p.locked && (
          <button type="button" className="nk-add-row" onClick={() => void p.addRow()}>
            <Icon name="plus" /> Neu
          </button>
        )}
        <div className="nk-table-foot">
          <span className="nk-muted">Anzahl</span> {p.rows.length}
        </div>
      </div>
      {head.anchor && menuProp && (
        <PropertyMenu
          anchor={head.anchor}
          onClose={head.close}
          db={p.db}
          prop={menuProp}
          view={p.view}
          updateView={p.updateView}
          updateSchema={p.updateSchema}
        />
      )}
      {add.anchor && (
        <AddPropertyMenu
          anchor={add.anchor}
          onClose={add.close}
          updateSchema={p.updateSchema}
          view={p.view}
          updateView={p.updateView}
          onNeedsSetup={(prop) => {
            const anchor = add.anchor;
            setMenuProp(prop);
            if (anchor) setTimeout(() => head.open(anchor));
          }}
        />
      )}
    </div>
  );
}

// ---------------- Board ----------------

export function BoardView(p: ViewProps) {
  const notes = useNotes();
  const prop = p.schema.properties.find((x) => x.id === p.view.groupBy);
  const groups = groupRows(p.rows, prop, notes.members);
  const [drag, setDrag] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const cardProps = p.visible.filter((x) => x.type !== "title" && x.id !== prop?.id);

  const drop = (key: string, beforeId: string | null) => {
    if (!drag) return;
    const row = p.rows.find((r) => r.id === drag);
    setDrag(null);
    setOver(null);
    if (!row) return;
    const target = groups.find((g) => g.key === key)?.rows.filter((r) => r.id !== row.id) ?? [];
    const i = beforeId ? target.findIndex((r) => r.id === beforeId) : target.length;
    const position = between(target[i - 1]?.position, target[i]?.position);
    if (!prop) return notes.updatePage(row.id, { position }, { delay: 0 });
    const value = valueForGroup(prop, key, getValue(row, prop));
    notes.updatePage(row.id, { position, props: { ...row.props, [prop.id]: value } }, { delay: 0 });
  };

  if (!prop) {
    return (
      <div className="nk-empty-view">
        <p>Für das Board wird eine Eigenschaft vom Typ Status, Auswahl, Person oder Kontrollkästchen benötigt.</p>
        {!p.locked && (
          <button
            type="button"
            className="nk-btn"
            onClick={() => {
              const status = p.schema.properties.find((x) => x.type === "status" || x.type === "select");
              if (status) p.updateView({ groupBy: status.id });
            }}
          >
            Gruppierung wählen
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="nk-board">
      {groups.map((g) => (
        <div
          key={g.key}
          className={`nk-board-col${over === g.key ? " is-over" : ""}`}
          onDragOver={(e) => {
            if (!drag) return;
            e.preventDefault();
            setOver(g.key);
          }}
          onDragLeave={() => setOver((o) => (o === g.key ? null : o))}
          onDrop={(e) => {
            e.preventDefault();
            drop(g.key, null);
          }}
        >
          <div className="nk-board-head">
            {g.option ? <Tag option={g.option} status={prop.type === "status"} /> : <span className="nk-board-label">{g.label}</span>}
            <span className="nk-muted">{g.rows.length}</span>
            {!p.locked && (
              <button
                type="button"
                className="nk-icon-btn"
                aria-label="Neu in dieser Spalte"
                onClick={() => void p.addRow({ [prop.id]: valueForGroup(prop, g.key, null) }, { open: true })}
              >
                <Icon name="plus" />
              </button>
            )}
          </div>
          <div className="nk-board-cards">
            {g.rows.map((row) => (
              <div
                key={row.id}
                className={`nk-card${drag === row.id ? " is-dragging" : ""}`}
                draggable={!p.locked}
                onDragStart={(e) => {
                  e.dataTransfer.effectAllowed = "move";
                  setDrag(row.id);
                }}
                onDragEnd={() => (setDrag(null), setOver(null))}
                onDragOver={(e) => drag && e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  drop(g.key, row.id);
                }}
                onClick={() => p.openRow(row.id)}
              >
                {row.cover && <div className="nk-card-cover" style={coverStyle(row.cover, notes)} />}
                <div className="nk-card-title">
                  {row.icon && <span>{row.icon} </span>}
                  {untitled(row)}
                </div>
                {cardProps.map((x) => {
                  const v = getValue(row, x);
                  if (isEmpty(v) || (x.type === "checkbox" && !v)) return null;
                  return (
                    <div key={x.id} className="nk-card-prop">
                      <ValueView row={row} prop={x} />
                    </div>
                  );
                })}
              </div>
            ))}
            {!p.locked && (
              <button type="button" className="nk-add-row is-card" onClick={() => void p.addRow({ [prop.id]: valueForGroup(prop, g.key, null) }, { open: true })}>
                <Icon name="plus" /> Neu
              </button>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function coverStyle(cover: string, notes: ReturnType<typeof useNotes>) {
  const css = coverCss(cover);
  if (css) return { background: css };
  if (notes.store.kind === "local" || /^https?:|^data:/.test(cover)) return { backgroundImage: `url("${cover}")` };
  return {};
}

// ---------------- Liste ----------------

export function ListView(p: ViewProps) {
  const extra = p.visible.filter((x) => x.type !== "title");
  return (
    <div className="nk-list">
      {p.rows.map((row) => (
        <button key={row.id} type="button" className="nk-list-row" onClick={() => p.openRow(row.id)}>
          <span className="nk-row-icon">{row.icon ?? <Icon name="page" />}</span>
          <span className="nk-list-title">{untitled(row)}</span>
          <span className="nk-list-props">
            {extra.map((x) => (
              <span key={x.id}>
                <ValueView row={row} prop={x} />
              </span>
            ))}
          </span>
        </button>
      ))}
      {!p.locked && (
        <button type="button" className="nk-add-row" onClick={() => void p.addRow({}, { open: true })}>
          <Icon name="plus" /> Neu
        </button>
      )}
    </div>
  );
}

// ---------------- Kalender ----------------

export function CalendarView(p: ViewProps) {
  const notes = useNotes();
  const prop = p.schema.properties.find((x) => x.id === p.view.dateProp && (x.type === "date" || x.type === "created_time" || x.type === "last_edited_time"));
  const [month, setMonth] = useState(() => today().slice(0, 7));
  const [drag, setDrag] = useState<string | null>(null);
  const [y, m] = month.split("-").map(Number);
  const first = new Date(y, m - 1, 1);
  const offset = (first.getDay() + 6) % 7; // Woche beginnt Montag
  const start = isoDay(new Date(y, m - 1, 1 - offset));
  const days = Array.from({ length: 42 }, (_, i) => addDays(start, i));
  const shift = (n: number) => setMonth(isoDay(new Date(y, m - 1 + n, 1)).slice(0, 7));

  if (!prop) {
    const dateProp = p.schema.properties.find((x) => x.type === "date");
    return (
      <div className="nk-empty-view">
        <p>Der Kalender braucht eine Datums-Eigenschaft.</p>
        {!p.locked && (
          <button
            type="button"
            className="nk-btn"
            onClick={() => {
              if (dateProp) return p.updateView({ dateProp: dateProp.id });
              const id = Math.random().toString(36).slice(2, 10);
              p.updateSchema((s) => ({ ...s, properties: [...s.properties, { id, name: "Datum", type: "date" }] }));
              p.updateView({ dateProp: id });
            }}
          >
            {dateProp ? `„${dateProp.name}“ verwenden` : "Datums-Eigenschaft anlegen"}
          </button>
        )}
      </div>
    );
  }

  const byDay = new Map<string, PageMeta[]>();
  for (const r of p.rows) {
    const v = getValue(r, prop);
    if (isEmpty(v)) continue;
    const d = prop.type === "date" ? String(v).slice(0, 10) : isoDay(new Date(String(v)));
    byDay.set(d, [...(byDay.get(d) ?? []), r]);
  }

  return (
    <div className="nk-calendar">
      <div className="nk-cal-head">
        <b>
          {MONTHS[m - 1]} {y}
        </b>
        <span className="nk-spacer" />
        <button type="button" className="nk-icon-btn" aria-label="Voriger Monat" onClick={() => shift(-1)}>
          <Icon name="chevronLeft" />
        </button>
        <button type="button" className="nk-btn is-ghost" onClick={() => setMonth(today().slice(0, 7))}>
          Heute
        </button>
        <button type="button" className="nk-icon-btn" aria-label="Nächster Monat" onClick={() => shift(1)}>
          <Icon name="chevronRight" />
        </button>
      </div>
      <div className="nk-cal-grid">
        {["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"].map((d) => (
          <div key={d} className="nk-cal-dow">
            {d}
          </div>
        ))}
        {days.map((d) => (
          <div
            key={d}
            className={`nk-cal-day${d.slice(0, 7) !== month ? " is-other" : ""}${d === today() ? " is-today" : ""}`}
            onDragOver={(e) => drag && prop.type === "date" && e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              const row = p.rows.find((r) => r.id === drag);
              setDrag(null);
              if (!row || prop.type !== "date") return;
              const time = String(row.props[prop.id] ?? "").split("T")[1];
              notes.updatePage(row.id, { props: { ...row.props, [prop.id]: time ? `${d}T${time}` : d } }, { delay: 0 });
            }}
          >
            <div className="nk-cal-num">
              <span>{Number(d.slice(8))}</span>
              {!p.locked && prop.type === "date" && (
                <button type="button" className="nk-icon-btn nk-cal-add" aria-label="Neu an diesem Tag" onClick={() => void p.addRow({ [prop.id]: d }, { open: true })}>
                  <Icon name="plus" size={14} />
                </button>
              )}
            </div>
            {(byDay.get(d) ?? []).map((r) => (
              <button
                key={r.id}
                type="button"
                className="nk-cal-item"
                draggable={!p.locked}
                onDragStart={() => setDrag(r.id)}
                onClick={() => p.openRow(r.id)}
              >
                {r.icon && <span>{r.icon} </span>}
                {untitled(r)}
              </button>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------- Galerie ----------------

export function GalleryView(p: ViewProps) {
  const notes = useNotes();
  const extra = p.visible.filter((x) => x.type !== "title");
  return (
    <div className="nk-gallery">
      {p.rows.map((row) => (
        <button key={row.id} type="button" className="nk-gallery-card" onClick={() => p.openRow(row.id)}>
          <div className="nk-gallery-cover" style={row.cover ? coverStyle(row.cover, notes) : undefined}>
            {!row.cover && <span className="nk-gallery-icon">{row.icon ?? "📄"}</span>}
          </div>
          <div className="nk-gallery-body">
            <div className="nk-card-title">{untitled(row)}</div>
            {extra.map((x) => (
              <div key={x.id} className="nk-card-prop">
                <ValueView row={row} prop={x} />
              </div>
            ))}
          </div>
        </button>
      ))}
      {!p.locked && (
        <button type="button" className="nk-gallery-card is-new" onClick={() => void p.addRow({}, { open: true })}>
          <Icon name="plus" /> Neu
        </button>
      )}
    </div>
  );
}
