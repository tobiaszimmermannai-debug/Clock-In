// Anzeigen und Bearbeiten von Eigenschaftswerten (Tabelle, Board, Seiten-Eigenschaften)
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useNotes } from "../state";
import type { Member, PageMeta, PropDef, PropType, PropValue, SelectOption, StatusGroup } from "../types";
import { Icon, type IconName } from "../ui/Icon";
import { MenuDivider, MenuItem, MenuLabel, Popover, usePopover } from "../ui/Popover";
import { addDays, COLOR_LABELS, COLORS, formatDate, formatTimestamp, today } from "../util";
import { addOption, formatNumber, getValue, isEmpty, optionById, READONLY_TYPES } from "./logic";

export const TYPE_ICONS: Record<PropType, IconName> = {
  title: "title",
  text: "text",
  number: "hash",
  select: "select",
  multi_select: "tags",
  status: "status",
  date: "calendar",
  person: "person",
  checkbox: "checkbox",
  url: "link",
  email: "mail",
  phone: "phone",
  created_time: "clock",
  last_edited_time: "clock",
  created_by: "person",
};

export function Tag(props: { option: SelectOption; onRemove?: () => void; status?: boolean }) {
  return (
    <span className={`nk-tag is-${props.option.color}${props.status ? " is-status" : ""}`}>
      {props.status && <span className="nk-tag-dot" />}
      {props.option.name}
      {props.onRemove && (
        <button type="button" className="nk-tag-x" onClick={props.onRemove} aria-label="Entfernen">
          <Icon name="close" size={12} />
        </button>
      )}
    </span>
  );
}

export function PersonChip(props: { member?: Member; fallback?: string }) {
  const m = props.member;
  return (
    <span className="nk-person">
      <span className={`nk-avatar is-${m?.color ?? "gray"}`}>{(m?.name ?? props.fallback ?? "?")[0]}</span>
      <span>{m?.name ?? props.fallback ?? "Unbekannt"}</span>
    </span>
  );
}

/** Nur Anzeige (Karten, Liste, Galerie) */
export function ValueView(props: { row: PageMeta; prop: PropDef; members: Member[] }): ReactNode {
  const { row, prop, members } = props;
  const v = getValue(row, prop);
  if (isEmpty(v) && prop.type !== "checkbox") return null;
  switch (prop.type) {
    case "title":
      return <span>{String(v)}</span>;
    case "select":
    case "status": {
      const o = optionById(prop, v);
      return o ? <Tag option={o} status={prop.type === "status"} /> : null;
    }
    case "multi_select":
      return (
        <span className="nk-tags">
          {(v as string[]).map((id) => {
            const o = optionById(prop, id);
            return o ? <Tag key={id} option={o} /> : null;
          })}
        </span>
      );
    case "person":
      return (
        <span className="nk-tags">
          {(v as string[]).map((id) => (
            <PersonChip key={id} member={members.find((m) => m.id === id)} />
          ))}
        </span>
      );
    case "created_by":
      return <PersonChip member={members.find((m) => m.id === v)} />;
    case "checkbox":
      return <span className={`nk-check${v ? " is-on" : ""}`}>{v ? <Icon name="check" size={12} /> : null}</span>;
    case "date":
      return <span className={dateTone(String(v))}>{formatDate(String(v))}</span>;
    case "created_time":
    case "last_edited_time":
      return <span>{formatTimestamp(String(v))}</span>;
    case "number":
      return <span className="nk-num">{formatNumber(Number(v), prop.format)}</span>;
    case "url":
      return (
        <a className="nk-link" href={String(v)} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>
          {String(v).replace(/^https?:\/\//, "")}
        </a>
      );
    case "email":
      return (
        <a className="nk-link" href={`mailto:${String(v)}`} onClick={(e) => e.stopPropagation()}>
          {String(v)}
        </a>
      );
    case "phone":
      return (
        <a className="nk-link" href={`tel:${String(v)}`} onClick={(e) => e.stopPropagation()}>
          {String(v)}
        </a>
      );
    default:
      return <span className="nk-text-value">{String(v)}</span>;
  }
}

function dateTone(value: string) {
  const day = value.slice(0, 10);
  if (day < today()) return "nk-date is-past";
  if (day === today()) return "nk-date is-today";
  return "nk-date";
}

/** Bearbeitbare Zelle: Klick öffnet den passenden Editor */
export function ValueCell(props: {
  db: PageMeta;
  row: PageMeta;
  prop: PropDef;
  placeholder?: string;
  className?: string;
}) {
  const notes = useNotes();
  const { db, row, prop } = props;
  const pop = usePopover();
  const [editing, setEditing] = useState(false);
  const readonly = READONLY_TYPES.includes(prop.type) || notes.pages.get(db.id)?.options.locked;

  const set = (value: PropValue) => {
    if (prop.type === "title") notes.updatePage(row.id, { title: String(value ?? "") });
    else notes.updatePage(row.id, { props: { ...row.props, [prop.id]: value } });
  };
  const setProp = (next: PropDef) => {
    const schema = notes.pages.get(db.id)?.schema;
    if (!schema) return;
    notes.updatePage(db.id, { schema: { ...schema, properties: schema.properties.map((p) => (p.id === next.id ? next : p)) } });
  };

  const value = getValue(row, prop);
  const empty = isEmpty(value) && prop.type !== "checkbox";
  const cls = `nk-cell${props.className ? ` ${props.className}` : ""}${readonly ? " is-readonly" : ""}`;

  if (prop.type === "checkbox") {
    return (
      <div className={cls}>
        <button type="button" className={`nk-check${value ? " is-on" : ""}`} disabled={Boolean(readonly)} onClick={() => set(!value)} aria-label={prop.name}>
          {value ? <Icon name="check" size={12} /> : null}
        </button>
      </div>
    );
  }

  if (["text", "title", "number", "url", "email", "phone"].includes(prop.type) && editing && !readonly) {
    return (
      <div className={`${cls} is-editing`}>
        <InlineInput
          initial={value === null ? "" : String(value)}
          type={prop.type === "number" ? "number" : prop.type === "email" ? "email" : prop.type === "url" ? "url" : "text"}
          multiline={prop.type === "text"}
          onDone={(text) => {
            setEditing(false);
            if (prop.type === "number") set(text.trim() === "" ? null : Number(text.replace(",", ".")));
            else set(text.trim() === "" && prop.type !== "title" ? null : text);
          }}
        />
      </div>
    );
  }

  return (
    <div
      className={cls}
      role="button"
      tabIndex={0}
      onClick={(e) => {
        if (readonly) return;
        if (["text", "title", "number", "url", "email", "phone"].includes(prop.type)) setEditing(true);
        else pop.open(e.currentTarget);
      }}
      onKeyDown={(e) => e.key === "Enter" && (e.currentTarget as HTMLElement).click()}
    >
      {empty ? <span className="nk-placeholder">{props.placeholder ?? ""}</span> : <ValueView row={row} prop={prop} members={notes.members} />}
      {pop.anchor && (prop.type === "select" || prop.type === "status" || prop.type === "multi_select") && (
        <OptionPicker anchor={pop.anchor} onClose={pop.close} prop={prop} value={value} onChange={set} onPropChange={setProp} />
      )}
      {pop.anchor && prop.type === "person" && (
        <PersonPicker anchor={pop.anchor} onClose={pop.close} members={notes.members} value={(value as string[] | null) ?? []} onChange={set} />
      )}
      {pop.anchor && prop.type === "date" && <DatePicker anchor={pop.anchor} onClose={pop.close} value={(value as string | null) ?? null} onChange={set} />}
    </div>
  );
}

export function InlineInput(props: {
  initial: string;
  onDone: (value: string) => void;
  type?: string;
  multiline?: boolean;
  placeholder?: string;
  className?: string;
}) {
  const [text, setText] = useState(props.initial);
  const done = useRef(false);
  const finish = (value: string) => {
    if (done.current) return;
    done.current = true;
    props.onDone(value);
  };
  const common = {
    autoFocus: true,
    className: `nk-inline-input ${props.className ?? ""}`,
    value: text,
    placeholder: props.placeholder,
    onBlur: () => finish(text),
    onKeyDown: (e: React.KeyboardEvent) => {
      e.stopPropagation();
      if (e.key === "Escape") finish(props.initial);
      if (e.key === "Enter" && !(props.multiline && e.shiftKey)) {
        e.preventDefault();
        finish(text);
      }
    },
  };
  if (props.multiline) {
    return <textarea {...common} rows={Math.min(8, Math.max(1, text.split("\n").length))} onChange={(e) => setText(e.target.value)} />;
  }
  return <input {...common} type={props.type ?? "text"} onChange={(e) => setText(e.target.value)} onFocus={(e) => e.currentTarget.select()} />;
}

export function OptionPicker(props: {
  anchor: HTMLElement | DOMRect | { x: number; y: number };
  onClose: () => void;
  prop: PropDef;
  value: PropValue;
  onChange: (v: PropValue) => void;
  onPropChange: (p: PropDef) => void;
}) {
  const { prop } = props;
  const multi = prop.type === "multi_select";
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<{ option: SelectOption; anchor: HTMLElement } | null>(null);
  const selected = multi ? ((props.value as string[] | null) ?? []) : props.value ? [String(props.value)] : [];
  const q = query.trim().toLowerCase();
  const options = (prop.options ?? []).filter((o) => o.name.toLowerCase().includes(q));
  const exact = (prop.options ?? []).some((o) => o.name.toLowerCase() === q);

  const toggle = (id: string) => {
    if (multi) props.onChange(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);
    else {
      props.onChange(selected[0] === id ? null : id);
      props.onClose();
    }
  };
  const create = () => {
    if (!query.trim()) return;
    const { prop: next, option } = addOption(prop, query.trim());
    props.onPropChange(next);
    if (multi) props.onChange([...selected, option.id]);
    else {
      props.onChange(option.id);
      props.onClose();
    }
    setQuery("");
  };

  const groups: { key: StatusGroup | "all"; label: string }[] =
    prop.type === "status"
      ? [
          { key: "todo", label: "Zu erledigen" },
          { key: "doing", label: "In Arbeit" },
          { key: "done", label: "Abgeschlossen" },
        ]
      : [{ key: "all", label: multi ? "Optionen wählen oder erstellen" : "Option wählen oder erstellen" }];

  return (
    <Popover anchor={props.anchor} onClose={props.onClose} width={280}>
      <div className="nk-picker-head">
        {selected.map((id) => {
          const o = optionById(prop, id);
          return o ? <Tag key={id} option={o} status={prop.type === "status"} onRemove={() => toggle(id)} /> : null;
        })}
        <input
          autoFocus
          className="nk-picker-input"
          value={query}
          placeholder={selected.length ? "" : "Suchen oder neu anlegen …"}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") {
              e.preventDefault();
              if (options[0] && (exact || prop.type === "status")) toggle(options[0].id);
              else create();
            }
            if (e.key === "Backspace" && !query && selected.length && multi) toggle(selected[selected.length - 1]);
          }}
        />
      </div>
      <div className="nk-menu-scroll">
        {groups.map((g) => (
          <div key={g.key}>
            <MenuLabel>{g.label}</MenuLabel>
            {options
              .filter((o) => g.key === "all" || (o.group ?? "todo") === g.key)
              .map((o) => (
                <div key={o.id} className="nk-option-row">
                  <button type="button" className="nk-menu-item" onClick={() => toggle(o.id)}>
                    <Icon name="drag" className="nk-faint" />
                    <Tag option={o} status={prop.type === "status"} />
                    {selected.includes(o.id) && <Icon name="check" className="nk-menu-check" />}
                  </button>
                  <button type="button" className="nk-icon-btn" aria-label="Option bearbeiten" onClick={(e) => setEditing({ option: o, anchor: e.currentTarget })}>
                    <Icon name="more" />
                  </button>
                </div>
              ))}
          </div>
        ))}
        {q && !exact && prop.type !== "status" && (
          <MenuItem icon="plus" label={<>Erstellen: <b>{query.trim()}</b></>} onClick={create} />
        )}
        {q && !exact && prop.type === "status" && (
          <MenuItem icon="plus" label={<>Status anlegen: <b>{query.trim()}</b></>} onClick={create} />
        )}
      </div>
      {editing && (
        <OptionEditor
          anchor={editing.anchor}
          option={editing.option}
          status={prop.type === "status"}
          onClose={() => setEditing(null)}
          onChange={(o) => props.onPropChange({ ...prop, options: prop.options?.map((x) => (x.id === o.id ? o : x)) })}
          onDelete={() => {
            props.onPropChange({ ...prop, options: prop.options?.filter((x) => x.id !== editing.option.id) });
            if (selected.includes(editing.option.id)) props.onChange(multi ? selected.filter((x) => x !== editing.option.id) : null);
            setEditing(null);
          }}
        />
      )}
    </Popover>
  );
}

function OptionEditor(props: {
  anchor: HTMLElement;
  option: SelectOption;
  status: boolean;
  onClose: () => void;
  onChange: (o: SelectOption) => void;
  onDelete: () => void;
}) {
  const [name, setName] = useState(props.option.name);
  const o = props.option;
  return (
    <Popover anchor={props.anchor} onClose={props.onClose} placement="right-start" width={220}>
      <div className="nk-pad">
        <input
          autoFocus
          className="nk-input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => name.trim() && name !== o.name && props.onChange({ ...o, name: name.trim() })}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          }}
        />
      </div>
      <MenuItem icon="trash" label="Löschen" danger onClick={props.onDelete} />
      {props.status && (
        <>
          <MenuDivider />
          <MenuLabel>Gruppe</MenuLabel>
          {(["todo", "doing", "done"] as StatusGroup[]).map((g) => (
            <MenuItem
              key={g}
              label={{ todo: "Zu erledigen", doing: "In Arbeit", done: "Abgeschlossen" }[g]}
              active={(o.group ?? "todo") === g}
              onClick={() => props.onChange({ ...o, group: g })}
            />
          ))}
        </>
      )}
      <MenuDivider />
      <MenuLabel>Farbe</MenuLabel>
      {COLORS.map((c) => (
        <MenuItem key={c} icon={<span className={`nk-swatch is-${c}`} />} label={COLOR_LABELS[c]} active={o.color === c} onClick={() => props.onChange({ ...o, color: c })} />
      ))}
    </Popover>
  );
}

export function PersonPicker(props: {
  anchor: HTMLElement | DOMRect | { x: number; y: number };
  onClose: () => void;
  members: Member[];
  value: string[];
  onChange: (v: string[]) => void;
}) {
  const [query, setQuery] = useState("");
  const list = props.members.filter((m) => m.name.toLowerCase().includes(query.toLowerCase()));
  return (
    <Popover anchor={props.anchor} onClose={props.onClose} width={260}>
      <div className="nk-pad">
        <input autoFocus className="nk-input" placeholder="Person suchen …" value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
      </div>
      <div className="nk-menu-scroll">
        {list.map((m) => (
          <MenuItem
            key={m.id}
            icon={<span className={`nk-avatar is-${m.color}`}>{m.name[0]}</span>}
            label={m.name}
            active={props.value.includes(m.id)}
            onClick={() => props.onChange(props.value.includes(m.id) ? props.value.filter((x) => x !== m.id) : [...props.value, m.id])}
          />
        ))}
        {!list.length && <div className="nk-empty-hint">Keine Person gefunden</div>}
      </div>
    </Popover>
  );
}

export function DatePicker(props: {
  anchor: HTMLElement | DOMRect | { x: number; y: number };
  onClose: () => void;
  value: string | null;
  onChange: (v: string | null) => void;
}) {
  const [day, time] = (props.value ?? "").split("T");
  const [withTime, setWithTime] = useState(Boolean(time));
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => ref.current?.focus(), []);
  const emit = (d: string, t: string | undefined) => props.onChange(d ? (withTime && t ? `${d}T${t}` : d) : null);
  return (
    <Popover anchor={props.anchor} onClose={props.onClose} width={260}>
      <div className="nk-pad nk-date-picker">
        <input ref={ref} type="date" className="nk-input" value={day ?? ""} onChange={(e) => emit(e.target.value, time)} onKeyDown={(e) => e.stopPropagation()} />
        {withTime && (
          <input type="time" className="nk-input" value={time?.slice(0, 5) ?? "09:00"} onChange={(e) => emit(day || today(), e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
        )}
      </div>
      <MenuItem icon="calendar" label="Heute" onClick={() => emit(today(), time)} />
      <MenuItem icon="calendar" label="Morgen" onClick={() => emit(addDays(today(), 1), time)} />
      <MenuItem icon="calendar" label="In einer Woche" onClick={() => emit(addDays(today(), 7), time)} />
      <MenuDivider />
      <MenuItem
        icon="clock"
        label="Uhrzeit"
        active={withTime}
        onClick={() => {
          setWithTime(!withTime);
          if (day) props.onChange(!withTime ? `${day}T09:00` : day);
        }}
      />
      <MenuItem icon="trash" label="Datum entfernen" onClick={() => (props.onChange(null), props.onClose())} />
    </Popover>
  );
}
