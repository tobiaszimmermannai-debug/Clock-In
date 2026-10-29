// Datenbank-Rahmen: Ansichts-Tabs, Filter, Sortierung, Suche, Eigenschaften
import { type ReactNode, useCallback, useMemo, useState } from "react";
import { useNotes } from "../state";
import type { DbSchema, Filter, PageMeta, PropDef, PropType, PropValue, Sort, ViewDef, ViewType } from "../types";
import { Icon, type IconName } from "../ui/Icon";
import { type Anchor, MenuDivider, MenuItem, MenuLabel, Popover, usePopover } from "../ui/Popover";
import { shortId, storageGet, storageSet, untitled } from "../util";
import { TYPE_ICONS } from "./cells";
import {
  defaultsFromView,
  needsValue,
  newDatabaseSchema,
  newProperty,
  newView,
  OP_LABELS,
  opsFor,
  READONLY_TYPES,
  TYPE_LABELS,
  VIEW_LABELS,
  viewRows,
} from "./logic";
import { BoardView, CalendarView, GalleryView, ListView, TableView, type ViewProps } from "./views";

const VIEW_ICONS: Record<ViewType, IconName> = { table: "table", board: "board", list: "list", calendar: "calendar", gallery: "gallery" };
const ADDABLE: PropType[] = ["text", "number", "select", "multi_select", "status", "date", "person", "checkbox", "url", "email", "phone", "created_time", "last_edited_time", "created_by"];

export function DatabaseView(props: { dbId: string; inline?: boolean }) {
  const notes = useNotes();
  const db = notes.pages.get(props.dbId);
  const schema = db?.schema ?? null;
  const [viewId, setViewId] = useState<string | null>(() => storageGet<string | null>(`aun-view-${props.dbId}`, null));
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const viewMenu = usePopover();
  const addView = usePopover();
  const filterMenu = usePopover();
  const sortMenu = usePopover();
  const propsMenu = usePopover();
  const [editFilter, setEditFilter] = useState<{ filter: Filter; anchor: Anchor } | null>(null);
  const [menuView, setMenuView] = useState<ViewDef | null>(null);
  const [editRow, setEditRow] = useState<string | null>(null);

  const { updatePage } = notes;
  const updateSchema = useCallback(
    (fn: (s: DbSchema) => DbSchema) => {
      const cur = notes.pages.get(props.dbId)?.schema ?? newDatabaseSchema();
      updatePage(props.dbId, { schema: fn(cur) });
    },
    [notes.pages, props.dbId, updatePage],
  );

  const view = schema?.views.find((v) => v.id === viewId) ?? schema?.views[0];
  const allRows = useMemo(() => (db ? notes.childrenOf(db.id) : []), [db, notes]);
  const rows = useMemo(
    () => (schema && view ? viewRows(allRows, view, schema, { meId: notes.me.id, members: notes.members, query }) : []),
    [allRows, schema, view, notes.me.id, notes.members, query],
  );

  if (!db) return null;
  if (!schema || !view) {
    return (
      <div className="nk-empty-view">
        <button type="button" className="nk-btn" onClick={() => updatePage(db.id, { schema: newDatabaseSchema() }, { delay: 0 })}>
          Datenbank einrichten
        </button>
      </div>
    );
  }

  const locked = Boolean(db.options.locked);
  const selectView = (id: string) => {
    setViewId(id);
    storageSet(`aun-view-${props.dbId}`, id);
  };
  const updateView = (patch: Partial<ViewDef>) =>
    updateSchema((s) => ({ ...s, views: s.views.map((v) => (v.id === view.id ? { ...v, ...patch } : v)) }));

  const visible = schema.properties.filter((p) => p.type === "title" || !view.hidden.includes(p.id));

  const addRow = async (values: Record<string, PropValue> = {}, opts: { open?: boolean; position?: number } = {}) => {
    const page = await notes
      .createPage({ parentId: db.id, props: { ...defaultsFromView(view, schema, notes.me.id), ...values }, position: opts.position })
      .catch(() => undefined);
    if (page && opts.open !== false && view.type !== "table") notes.openPeek(page.id);
    // Tabelle: Titel der neuen Zeile direkt bearbeiten
    if (page && view.type === "table") setEditRow(page.id);
    return page;
  };

  const viewProps: ViewProps = {
    db,
    schema,
    view,
    rows,
    visible,
    locked,
    addRow,
    updateView,
    updateSchema,
    openRow: (id) => notes.openPeek(id),
    editRow,
    clearEditRow: () => setEditRow(null),
  };

  const addFilter = (prop: PropDef, anchor: Anchor) => {
    const filter: Filter = { id: shortId(), prop: prop.id, op: opsFor(prop.type)[0], value: prop.type === "checkbox" ? "true" : "" };
    updateView({ filters: [...view.filters, filter] });
    filterMenu.close();
    setEditFilter({ filter, anchor });
  };

  return (
    <div className={`nk-db${props.inline ? " is-inline" : ""}`} data-db={db.id}>
      {props.inline && (
        <div className="nk-db-title">
          <button type="button" className="nk-db-title-btn" onClick={() => notes.navigate(db.id)}>
            {db.icon && <span>{db.icon}</span>}
            <span className={db.title ? "" : "nk-placeholder"}>{untitled(db)}</span>
            <Icon name="arrowRight" size={14} className="nk-faint" />
          </button>
        </div>
      )}
      <div className="nk-db-bar">
        <div className="nk-tabs" role="tablist">
          {schema.views.map((v) => (
            <button
              key={v.id}
              type="button"
              role="tab"
              aria-selected={v.id === view.id}
              className="nk-tab"
              onClick={(e) => {
                if (v.id === view.id && !locked) {
                  setMenuView(v);
                  viewMenu.open(e.currentTarget);
                } else selectView(v.id);
              }}
            >
              <Icon name={VIEW_ICONS[v.type]} />
              {v.name}
            </button>
          ))}
          {!locked && (
            <button type="button" className="nk-icon-btn" aria-label="Ansicht hinzufügen" onClick={(e) => addView.open(e.currentTarget)}>
              <Icon name="plus" />
            </button>
          )}
        </div>
        <div className="nk-db-tools">
          <button type="button" className={`nk-btn is-ghost${view.filters.length ? " is-on" : ""}`} onClick={(e) => filterMenu.open(e.currentTarget)}>
            <Icon name="filter" /> <span className="nk-hide-sm">Filter</span>
          </button>
          <button type="button" className={`nk-btn is-ghost${view.sorts.length ? " is-on" : ""}`} onClick={(e) => sortMenu.open(e.currentTarget)}>
            <Icon name="sort" /> <span className="nk-hide-sm">Sortieren</span>
          </button>
          {searching ? (
            <input
              autoFocus
              className="nk-input nk-db-search"
              placeholder="Suchen …"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onBlur={() => !query && setSearching(false)}
              onKeyDown={(e) => e.key === "Escape" && (setQuery(""), setSearching(false))}
            />
          ) : (
            <button type="button" className="nk-icon-btn" aria-label="Suchen" onClick={() => setSearching(true)}>
              <Icon name="search" />
            </button>
          )}
          <button type="button" className="nk-icon-btn" aria-label="Eigenschaften" onClick={(e) => propsMenu.open(e.currentTarget)}>
            <Icon name="more" />
          </button>
          {!locked && (
            <button type="button" className="nk-btn is-primary" onClick={() => void addRow({}, { open: true })}>
              Neu
            </button>
          )}
        </div>
      </div>

      {(view.filters.length > 0 || view.sorts.length > 0) && (
        <div className="nk-chips">
          {view.sorts.map((s) => {
            const prop = schema.properties.find((p) => p.id === s.prop);
            return (
              <button key={s.prop} type="button" className="nk-chip" onClick={(e) => sortMenu.open(e.currentTarget)}>
                <Icon name={s.dir === "asc" ? "arrowUp" : "arrowDown"} size={12} /> {prop?.name ?? "?"}
              </button>
            );
          })}
          {view.filters.map((f) => (
            <button key={f.id} type="button" className="nk-chip is-filter" onClick={(e) => setEditFilter({ filter: f, anchor: e.currentTarget })}>
              {filterLabel(f, schema, notes.members)}
            </button>
          ))}
        </div>
      )}

      <div className="nk-db-body">
        {view.type === "table" && <TableView {...viewProps} />}
        {view.type === "board" && <BoardView {...viewProps} />}
        {view.type === "list" && <ListView {...viewProps} />}
        {view.type === "calendar" && <CalendarView {...viewProps} />}
        {view.type === "gallery" && <GalleryView {...viewProps} />}
      </div>

      {addView.anchor && (
        <Popover anchor={addView.anchor} onClose={addView.close} width={220}>
          <MenuLabel>Ansicht hinzufügen</MenuLabel>
          {(Object.keys(VIEW_LABELS) as ViewType[]).map((t) => (
            <MenuItem
              key={t}
              icon={VIEW_ICONS[t]}
              label={VIEW_LABELS[t]}
              onClick={() => {
                const v = newView(t, schema);
                updateSchema((s) => ({ ...s, views: [...s.views, v] }));
                selectView(v.id);
                addView.close();
              }}
            />
          ))}
        </Popover>
      )}

      {viewMenu.anchor && menuView && (
        <ViewMenu
          anchor={viewMenu.anchor}
          onClose={viewMenu.close}
          view={menuView}
          schema={schema}
          updateSchema={updateSchema}
          onSelect={selectView}
        />
      )}

      {filterMenu.anchor && (
        <Popover anchor={filterMenu.anchor} onClose={filterMenu.close} width={240}>
          <MenuLabel>Filtern nach</MenuLabel>
          {schema.properties.map((p) => (
            <MenuItem key={p.id} icon={TYPE_ICONS[p.type]} label={p.name} onClick={(e?: unknown) => addFilter(p, filterMenu.anchor ?? (e as Anchor))} />
          ))}
          {view.filters.length > 0 && (
            <>
              <MenuDivider />
              <MenuItem icon="trash" label="Alle Filter entfernen" danger onClick={() => (updateView({ filters: [] }), filterMenu.close())} />
            </>
          )}
        </Popover>
      )}

      {editFilter && (
        <FilterEditor
          anchor={editFilter.anchor}
          filter={view.filters.find((f) => f.id === editFilter.filter.id) ?? editFilter.filter}
          schema={schema}
          onClose={() => setEditFilter(null)}
          onChange={(f) => updateView({ filters: view.filters.map((x) => (x.id === f.id ? f : x)) })}
          onRemove={() => {
            updateView({ filters: view.filters.filter((x) => x.id !== editFilter.filter.id) });
            setEditFilter(null);
          }}
        />
      )}

      {sortMenu.anchor && <SortEditor anchor={sortMenu.anchor} onClose={sortMenu.close} schema={schema} sorts={view.sorts} onChange={(sorts) => updateView({ sorts })} />}

      {propsMenu.anchor && (
        <Popover anchor={propsMenu.anchor} onClose={propsMenu.close} placement="bottom-end" width={260}>
          <MenuLabel>Eigenschaften in dieser Ansicht</MenuLabel>
          {schema.properties.map((p) => {
            const shown = p.type === "title" || !view.hidden.includes(p.id);
            return (
              <MenuItem
                key={p.id}
                icon={TYPE_ICONS[p.type]}
                label={p.name}
                hint={p.type === "title" ? undefined : <Icon name={shown ? "eye" : "eyeOff"} />}
                disabled={p.type === "title"}
                onClick={() => updateView({ hidden: shown ? [...view.hidden, p.id] : view.hidden.filter((h) => h !== p.id) })}
              />
            );
          })}
          {!locked && (
            <>
              <MenuDivider />
              <MenuItem
                icon="plus"
                label="Neue Eigenschaft"
                onClick={() => {
                  const p = newProperty("text");
                  updateSchema((s) => ({ ...s, properties: [...s.properties, p] }));
                }}
              />
            </>
          )}
        </Popover>
      )}
    </div>
  );
}

function filterLabel(f: Filter, schema: DbSchema, members: { id: string; name: string }[]): ReactNode {
  const prop = schema.properties.find((p) => p.id === f.prop);
  if (!prop) return "?";
  let value = f.value ?? "";
  if (value === "me") value = "Ich";
  else if (value === "today") value = "heute";
  else if (prop.type === "select" || prop.type === "status" || prop.type === "multi_select") value = prop.options?.find((o) => o.id === value)?.name ?? value;
  else if (prop.type === "person") value = members.find((m) => m.id === value)?.name ?? value;
  else if (prop.type === "checkbox") value = value === "true" ? "aktiviert" : "deaktiviert";
  return (
    <>
      <b>{prop.name}</b> {OP_LABELS[f.op]}
      {needsValue(f.op) && value ? `: ${value}` : ""}
    </>
  );
}

function FilterEditor(props: {
  anchor: Anchor;
  filter: Filter;
  schema: DbSchema;
  onClose: () => void;
  onChange: (f: Filter) => void;
  onRemove: () => void;
}) {
  const notes = useNotes();
  const { filter: f } = props;
  const prop = props.schema.properties.find((p) => p.id === f.prop);
  if (!prop) return null;
  const set = (patch: Partial<Filter>) => props.onChange({ ...f, ...patch });
  let input: ReactNode = null;
  if (needsValue(f.op)) {
    if (prop.type === "select" || prop.type === "status" || prop.type === "multi_select") {
      input = (
        <select className="nk-input" value={f.value ?? ""} onChange={(e) => set({ value: e.target.value })}>
          <option value="">– wählen –</option>
          {prop.options?.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
            </option>
          ))}
        </select>
      );
    } else if (prop.type === "person" || prop.type === "created_by") {
      input = (
        <select className="nk-input" value={f.value ?? ""} onChange={(e) => set({ value: e.target.value })}>
          <option value="">– wählen –</option>
          <option value="me">Ich</option>
          {notes.members.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </select>
      );
    } else if (prop.type === "checkbox") {
      input = (
        <select className="nk-input" value={f.value ?? "true"} onChange={(e) => set({ value: e.target.value })}>
          <option value="true">aktiviert</option>
          <option value="false">deaktiviert</option>
        </select>
      );
    } else if (prop.type === "date" || prop.type === "created_time" || prop.type === "last_edited_time") {
      input = (
        <div className="nk-row-gap">
          <input type="date" className="nk-input" value={f.value === "today" ? "" : (f.value ?? "")} onChange={(e) => set({ value: e.target.value })} />
          <button type="button" className={`nk-btn is-ghost${f.value === "today" ? " is-on" : ""}`} onClick={() => set({ value: "today" })}>
            Heute
          </button>
        </div>
      );
    } else {
      input = (
        <input
          autoFocus
          className="nk-input"
          type={prop.type === "number" ? "number" : "text"}
          placeholder="Wert eingeben …"
          value={f.value ?? ""}
          onChange={(e) => set({ value: e.target.value })}
        />
      );
    }
  }
  return (
    <Popover anchor={props.anchor} onClose={props.onClose} width={300}>
      <div className="nk-pad nk-filter-editor">
        <div className="nk-row-gap">
          <span className="nk-muted">{prop.name}</span>
          <select className="nk-input is-compact" value={f.op} onChange={(e) => set({ op: e.target.value as Filter["op"] })}>
            {opsFor(prop.type).map((op) => (
              <option key={op} value={op}>
                {OP_LABELS[op]}
              </option>
            ))}
          </select>
          <span className="nk-spacer" />
          <button type="button" className="nk-icon-btn" aria-label="Filter entfernen" onClick={props.onRemove}>
            <Icon name="trash" />
          </button>
        </div>
        {input}
      </div>
    </Popover>
  );
}

function SortEditor(props: { anchor: Anchor; onClose: () => void; schema: DbSchema; sorts: Sort[]; onChange: (s: Sort[]) => void }) {
  const unused = props.schema.properties.filter((p) => !props.sorts.some((s) => s.prop === p.id));
  return (
    <Popover anchor={props.anchor} onClose={props.onClose} width={320}>
      <div className="nk-pad nk-sort-editor">
        {props.sorts.map((s, i) => (
          <div key={s.prop} className="nk-row-gap">
            <select
              className="nk-input"
              value={s.prop}
              onChange={(e) => props.onChange(props.sorts.map((x, j) => (j === i ? { ...x, prop: e.target.value } : x)))}
            >
              {props.schema.properties
                .filter((p) => p.id === s.prop || unused.includes(p))
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
            </select>
            <select
              className="nk-input is-compact"
              value={s.dir}
              onChange={(e) => props.onChange(props.sorts.map((x, j) => (j === i ? { ...x, dir: e.target.value as Sort["dir"] } : x)))}
            >
              <option value="asc">Aufsteigend</option>
              <option value="desc">Absteigend</option>
            </select>
            <button type="button" className="nk-icon-btn" aria-label="Sortierung entfernen" onClick={() => props.onChange(props.sorts.filter((_, j) => j !== i))}>
              <Icon name="close" />
            </button>
          </div>
        ))}
        {!props.sorts.length && <div className="nk-muted">Noch keine Sortierung – Einträge stehen in manueller Reihenfolge.</div>}
      </div>
      {unused.length > 0 && (
        <MenuItem icon="plus" label="Sortierung hinzufügen" onClick={() => props.onChange([...props.sorts, { prop: unused[0].id, dir: "asc" }])} />
      )}
      {props.sorts.length > 0 && <MenuItem icon="trash" label="Sortierung entfernen" danger onClick={() => props.onChange([])} />}
    </Popover>
  );
}

function ViewMenu(props: {
  anchor: Anchor;
  onClose: () => void;
  view: ViewDef;
  schema: DbSchema;
  updateSchema: (fn: (s: DbSchema) => DbSchema) => void;
  onSelect: (id: string) => void;
}) {
  const { view, schema } = props;
  const [name, setName] = useState(view.name);
  const set = (patch: Partial<ViewDef>) => props.updateSchema((s) => ({ ...s, views: s.views.map((v) => (v.id === view.id ? { ...v, ...patch } : v)) }));
  const groupable = schema.properties.filter((p) => ["status", "select", "person", "checkbox", "multi_select"].includes(p.type));
  const dates = schema.properties.filter((p) => ["date", "created_time", "last_edited_time"].includes(p.type));
  return (
    <Popover anchor={props.anchor} onClose={props.onClose} width={260}>
      <div className="nk-pad">
        <input
          autoFocus
          className="nk-input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => name.trim() && set({ name: name.trim() })}
          onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
        />
      </div>
      <MenuLabel>Layout</MenuLabel>
      {(Object.keys(VIEW_LABELS) as ViewType[]).map((t) => (
        <MenuItem
          key={t}
          icon={VIEW_ICONS[t]}
          label={VIEW_LABELS[t]}
          active={view.type === t}
          onClick={() => {
            const fresh = newView(t, schema);
            set({ type: t, groupBy: view.groupBy ?? fresh.groupBy, dateProp: view.dateProp ?? fresh.dateProp });
          }}
        />
      ))}
      {view.type === "board" && groupable.length > 0 && (
        <>
          <MenuDivider />
          <MenuLabel>Gruppieren nach</MenuLabel>
          {groupable.map((p) => (
            <MenuItem key={p.id} icon={TYPE_ICONS[p.type]} label={p.name} active={view.groupBy === p.id} onClick={() => set({ groupBy: p.id })} />
          ))}
        </>
      )}
      {view.type === "calendar" && dates.length > 0 && (
        <>
          <MenuDivider />
          <MenuLabel>Kalender nach</MenuLabel>
          {dates.map((p) => (
            <MenuItem key={p.id} icon="calendar" label={p.name} active={view.dateProp === p.id} onClick={() => set({ dateProp: p.id })} />
          ))}
        </>
      )}
      <MenuDivider />
      <MenuItem
        icon="duplicate"
        label="Ansicht duplizieren"
        onClick={() => {
          const copy = { ...view, id: shortId(), name: `${view.name} (Kopie)` };
          props.updateSchema((s) => ({ ...s, views: [...s.views, copy] }));
          props.onSelect(copy.id);
          props.onClose();
        }}
      />
      <MenuItem
        icon="trash"
        label="Ansicht löschen"
        danger
        disabled={schema.views.length < 2}
        onClick={() => {
          props.updateSchema((s) => ({ ...s, views: s.views.filter((v) => v.id !== view.id) }));
          props.onClose();
        }}
      />
    </Popover>
  );
}

/** Menü einer Spalte/Eigenschaft: umbenennen, Typ, sortieren, filtern, ausblenden, löschen */
export function PropertyMenu(props: {
  anchor: Anchor;
  onClose: () => void;
  db: PageMeta;
  prop: PropDef;
  view?: ViewDef;
  updateView?: (patch: Partial<ViewDef>) => void;
  updateSchema: (fn: (s: DbSchema) => DbSchema) => void;
}) {
  const { prop, view } = props;
  const [name, setName] = useState(prop.name);
  const types = usePopover();
  const setProp = (patch: Partial<PropDef>) =>
    props.updateSchema((s) => ({ ...s, properties: s.properties.map((p) => (p.id === prop.id ? { ...p, ...patch } : p)) }));
  const insert = (offset: 0 | 1) => {
    const np = newProperty("text");
    props.updateSchema((s) => {
      const i = s.properties.findIndex((p) => p.id === prop.id);
      const list = [...s.properties];
      list.splice(i + offset, 0, np);
      return { ...s, properties: list };
    });
    props.onClose();
  };
  return (
    <Popover anchor={props.anchor} onClose={props.onClose} width={250}>
      <div className="nk-pad">
        <input
          autoFocus
          className="nk-input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => name.trim() && name !== prop.name && setProp({ name: name.trim() })}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          }}
        />
      </div>
      {prop.type !== "title" && (
        <MenuItem icon={TYPE_ICONS[prop.type]} label="Typ" hint={TYPE_LABELS[prop.type]} chevron onClick={() => types.open(props.anchor instanceof HTMLElement ? props.anchor : { x: 0, y: 0 })} />
      )}
      {prop.type === "number" && (
        <>
          <MenuLabel>Zahlenformat</MenuLabel>
          {(["number", "euro", "percent"] as const).map((f) => (
            <MenuItem key={f} label={{ number: "Zahl", euro: "Euro", percent: "Prozent" }[f]} active={(prop.format ?? "number") === f} onClick={() => setProp({ format: f })} />
          ))}
        </>
      )}
      {view && props.updateView && (
        <>
          <MenuDivider />
          <MenuItem icon="arrowUp" label="Aufsteigend sortieren" onClick={() => (props.updateView!({ sorts: [{ prop: prop.id, dir: "asc" }] }), props.onClose())} />
          <MenuItem icon="arrowDown" label="Absteigend sortieren" onClick={() => (props.updateView!({ sorts: [{ prop: prop.id, dir: "desc" }] }), props.onClose())} />
          {prop.type !== "title" && (
            <MenuItem icon="eyeOff" label="In Ansicht ausblenden" onClick={() => (props.updateView!({ hidden: [...view.hidden, prop.id] }), props.onClose())} />
          )}
          <MenuItem icon="chevronLeft" label="Links einfügen" onClick={() => insert(0)} />
          <MenuItem icon="chevronRight" label="Rechts einfügen" onClick={() => insert(1)} />
        </>
      )}
      {prop.type !== "title" && (
        <>
          <MenuDivider />
          <MenuItem
            icon="duplicate"
            label="Eigenschaft duplizieren"
            onClick={() => {
              const copy = { ...prop, id: shortId(), name: `${prop.name} (Kopie)` };
              props.updateSchema((s) => {
                const i = s.properties.findIndex((p) => p.id === prop.id);
                const list = [...s.properties];
                list.splice(i + 1, 0, copy);
                return { ...s, properties: list };
              });
              props.onClose();
            }}
          />
          <MenuItem
            icon="trash"
            label="Eigenschaft löschen"
            danger
            onClick={() => {
              props.updateSchema((s) => ({
                ...s,
                properties: s.properties.filter((p) => p.id !== prop.id),
                views: s.views.map((v) => ({
                  ...v,
                  filters: v.filters.filter((f) => f.prop !== prop.id),
                  sorts: v.sorts.filter((x) => x.prop !== prop.id),
                  groupBy: v.groupBy === prop.id ? undefined : v.groupBy,
                  dateProp: v.dateProp === prop.id ? undefined : v.dateProp,
                })),
              }));
              props.onClose();
            }}
          />
        </>
      )}
      {types.anchor && (
        <Popover anchor={types.anchor} onClose={types.close} placement="right-start" width={220}>
          <MenuLabel>Typ ändern</MenuLabel>
          {ADDABLE.map((t) => (
            <MenuItem
              key={t}
              icon={TYPE_ICONS[t]}
              label={TYPE_LABELS[t]}
              active={prop.type === t}
              onClick={() => {
                const fresh = newProperty(t, prop.name);
                const keepOptions = ["select", "multi_select", "status"].includes(t) && prop.options?.length;
                setProp({ type: t, options: keepOptions ? prop.options : fresh.options, format: fresh.format });
                types.close();
              }}
            />
          ))}
        </Popover>
      )}
    </Popover>
  );
}

export function AddPropertyMenu(props: {
  anchor: Anchor;
  onClose: () => void;
  updateSchema: (fn: (s: DbSchema) => DbSchema) => void;
  view?: ViewDef;
  updateView?: (patch: Partial<ViewDef>) => void;
}) {
  const [query, setQuery] = useState("");
  const list = ADDABLE.filter((t) => TYPE_LABELS[t].toLowerCase().includes(query.toLowerCase()));
  return (
    <Popover anchor={props.anchor} onClose={props.onClose} placement="bottom-end" width={240}>
      <div className="nk-pad">
        <input autoFocus className="nk-input" placeholder="Typ suchen …" value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
      </div>
      <MenuLabel>Neue Eigenschaft</MenuLabel>
      <div className="nk-menu-scroll">
        {list.map((t) => (
          <MenuItem
            key={t}
            icon={TYPE_ICONS[t]}
            label={TYPE_LABELS[t]}
            hint={READONLY_TYPES.includes(t) ? "automatisch" : undefined}
            onClick={() => {
              const p = newProperty(t);
              props.updateSchema((s) => ({ ...s, properties: [...s.properties, p] }));
              if (props.view && props.updateView && props.view.hidden.includes(p.id)) props.updateView({ hidden: props.view.hidden.filter((h) => h !== p.id) });
              props.onClose();
            }}
          />
        ))}
      </div>
    </Popover>
  );
}
