// Datenbank-Logik ohne UI: Werte lesen, filtern, sortieren, gruppieren
import type { DbSchema, Filter, FilterOp, Member, PageMeta, PropDef, PropType, PropValue, SelectOption, Sort, ViewDef, ViewType } from "../types";
import { formatDate, formatTimestamp, randomColor, shortId, today } from "../util";

export const TYPE_LABELS: Record<PropType, string> = {
  title: "Titel",
  text: "Text",
  number: "Zahl",
  select: "Auswahl",
  multi_select: "Mehrfachauswahl",
  status: "Status",
  date: "Datum",
  person: "Person",
  checkbox: "Kontrollkästchen",
  url: "URL",
  email: "E-Mail",
  phone: "Telefon",
  created_time: "Erstellt am",
  last_edited_time: "Zuletzt bearbeitet",
  created_by: "Erstellt von",
};

export const VIEW_LABELS: Record<ViewType, string> = {
  table: "Tabelle",
  board: "Board",
  list: "Liste",
  calendar: "Kalender",
  gallery: "Galerie",
};

export const READONLY_TYPES: PropType[] = ["created_time", "last_edited_time", "created_by"];

export const STATUS_DEFAULTS = (): SelectOption[] => [
  { id: shortId(), name: "Nicht begonnen", color: "gray", group: "todo" },
  { id: shortId(), name: "In Arbeit", color: "blue", group: "doing" },
  { id: shortId(), name: "Erledigt", color: "green", group: "done" },
];

export function newProperty(type: PropType, name?: string): PropDef {
  const def: PropDef = { id: shortId(), name: name ?? TYPE_LABELS[type], type };
  if (type === "select" || type === "multi_select") def.options = [];
  if (type === "status") def.options = STATUS_DEFAULTS();
  if (type === "number") def.format = "number";
  return def;
}

export function newView(type: ViewType, schema: DbSchema, name?: string): ViewDef {
  const view: ViewDef = { id: shortId(), name: name ?? VIEW_LABELS[type], type, filters: [], sorts: [], hidden: [] };
  if (type === "board") view.groupBy = schema.properties.find((p) => p.type === "status" || p.type === "select")?.id;
  if (type === "calendar") view.dateProp = schema.properties.find((p) => p.type === "date")?.id;
  return view;
}

export function newDatabaseSchema(): DbSchema {
  const title: PropDef = { id: "title", name: "Name", type: "title" };
  const tags = newProperty("multi_select", "Tags");
  const schema: DbSchema = { properties: [title, tags], views: [] };
  schema.views.push(newView("table", schema));
  return schema;
}

/** Wert einer Eigenschaft für eine Zeile (inkl. berechneter Werte) */
export function getValue(row: PageMeta, prop: PropDef): PropValue {
  switch (prop.type) {
    case "title":
      return row.title;
    case "created_time":
      return row.createdAt;
    case "last_edited_time":
      return row.updatedAt;
    case "created_by":
      return row.createdBy;
    default:
      return row.props[prop.id] ?? null;
  }
}

export const optionById = (prop: PropDef, id: unknown) => prop.options?.find((o) => o.id === id);

export function addOption(prop: PropDef, name: string): { prop: PropDef; option: SelectOption } {
  const option: SelectOption = { id: shortId(), name, color: randomColor() };
  if (prop.type === "status") option.group = "todo";
  return { prop: { ...prop, options: [...(prop.options ?? []), option] }, option };
}

/** Textdarstellung (Suche, Sortierung, Export) */
export function displayValue(row: PageMeta, prop: PropDef, members: Member[]): string {
  const v = getValue(row, prop);
  if (v === null || v === undefined || v === "") return "";
  switch (prop.type) {
    case "select":
    case "status":
      return optionById(prop, v)?.name ?? "";
    case "multi_select":
      return (Array.isArray(v) ? v : []).map((id) => optionById(prop, id)?.name ?? "").filter(Boolean).join(", ");
    case "person":
      return (Array.isArray(v) ? v : []).map((id) => members.find((m) => m.id === id)?.name ?? "").filter(Boolean).join(", ");
    case "created_by":
      return members.find((m) => m.id === v)?.name ?? "";
    case "checkbox":
      return v ? "Ja" : "Nein";
    case "date":
      return formatDate(String(v), { relative: false });
    case "created_time":
    case "last_edited_time":
      return formatTimestamp(String(v));
    case "number":
      return formatNumber(Number(v), prop.format);
    default:
      return String(v);
  }
}

export function formatNumber(n: number, format: PropDef["format"]): string {
  if (!Number.isFinite(n)) return "";
  if (format === "euro") return n.toLocaleString("de-DE", { style: "currency", currency: "EUR" });
  if (format === "percent") return `${n.toLocaleString("de-DE")} %`;
  return n.toLocaleString("de-DE");
}

export const isEmpty = (v: PropValue) => v === null || v === undefined || v === "" || (Array.isArray(v) && v.length === 0);

export function opsFor(type: PropType): FilterOp[] {
  switch (type) {
    case "number":
      return ["is", "is_not", "gt", "lt", "empty", "not_empty"];
    case "select":
    case "status":
      return ["is", "is_not", "empty", "not_empty"];
    case "multi_select":
    case "person":
    case "created_by":
      return ["contains", "not_contains", "empty", "not_empty"];
    case "checkbox":
      return ["is"];
    case "date":
    case "created_time":
    case "last_edited_time":
      return ["is", "before", "after", "empty", "not_empty"];
    default:
      return ["contains", "not_contains", "is", "is_not", "empty", "not_empty"];
  }
}

export const OP_LABELS: Record<FilterOp, string> = {
  contains: "enthält",
  not_contains: "enthält nicht",
  is: "ist",
  is_not: "ist nicht",
  empty: "ist leer",
  not_empty: "ist nicht leer",
  gt: "größer als",
  lt: "kleiner als",
  before: "ist vor",
  after: "ist nach",
};

export const needsValue = (op: FilterOp) => op !== "empty" && op !== "not_empty";

/** Filterwert auflösen: "me" → eigene ID, "today" → heutiges Datum */
const resolve = (value: string | undefined, meId: string) =>
  value === "me" ? meId : value === "today" ? today() : (value ?? "");

export function matchesFilter(row: PageMeta, f: Filter, schema: DbSchema, meId: string): boolean {
  const prop = schema.properties.find((p) => p.id === f.prop);
  if (!prop) return true;
  const v = getValue(row, prop);
  if (f.op === "empty") return isEmpty(v);
  if (f.op === "not_empty") return !isEmpty(v);
  const target = resolve(f.value, meId);
  if (!needsValue(f.op) || f.value === undefined || f.value === "") return true;

  switch (prop.type) {
    case "checkbox":
      return Boolean(v) === (target === "true");
    case "number": {
      const n = Number(v);
      const t = Number(target);
      if (f.op === "gt") return !isEmpty(v) && n > t;
      if (f.op === "lt") return !isEmpty(v) && n < t;
      return f.op === "is" ? !isEmpty(v) && n === t : isEmpty(v) || n !== t;
    }
    case "select":
    case "status":
      return f.op === "is" ? v === target : v !== target;
    case "multi_select":
    case "person": {
      const list = Array.isArray(v) ? v : [];
      return f.op === "contains" ? list.includes(target) : !list.includes(target);
    }
    case "created_by":
      return f.op === "contains" ? v === target : v !== target;
    case "date":
    case "created_time":
    case "last_edited_time": {
      if (isEmpty(v)) return false;
      const day = String(v).slice(0, 10);
      const ref = prop.type === "date" ? day : new Date(String(v)).toISOString().slice(0, 10);
      if (f.op === "is") return ref === target;
      if (f.op === "before") return ref < target;
      if (f.op === "after") return ref > target;
      return true;
    }
    default: {
      const s = String(v ?? "").toLowerCase();
      const t = target.toLowerCase();
      if (f.op === "contains") return s.includes(t);
      if (f.op === "not_contains") return !s.includes(t);
      if (f.op === "is") return s === t;
      if (f.op === "is_not") return s !== t;
      return true;
    }
  }
}

function sortKey(row: PageMeta, prop: PropDef, members: Member[]): string | number {
  const v = getValue(row, prop);
  if (prop.type === "number") return isEmpty(v) ? Number.POSITIVE_INFINITY : Number(v);
  if (prop.type === "checkbox") return v ? 1 : 0;
  if (prop.type === "select" || prop.type === "status") {
    const i = prop.options?.findIndex((o) => o.id === v) ?? -1;
    return i < 0 ? Number.POSITIVE_INFINITY : i;
  }
  if (prop.type === "date" || prop.type === "created_time" || prop.type === "last_edited_time") return isEmpty(v) ? "￿" : String(v);
  return displayValue(row, prop, members).toLowerCase() || "￿";
}

export function sortRows(rows: PageMeta[], sorts: Sort[], schema: DbSchema, members: Member[]): PageMeta[] {
  const active = sorts
    .map((s) => ({ s, prop: schema.properties.find((p) => p.id === s.prop) }))
    .filter((x): x is { s: Sort; prop: PropDef } => Boolean(x.prop));
  return [...rows].sort((a, b) => {
    for (const { s, prop } of active) {
      const ka = sortKey(a, prop, members);
      const kb = sortKey(b, prop, members);
      if (ka === kb) continue;
      const cmp = typeof ka === "number" && typeof kb === "number" ? ka - kb : String(ka).localeCompare(String(kb), "de");
      return s.dir === "asc" ? cmp : -cmp;
    }
    return a.position - b.position || a.createdAt.localeCompare(b.createdAt);
  });
}

/** Zeilen einer Ansicht: Filter + Sortierung + Schnellsuche */
export function viewRows(
  rows: PageMeta[],
  view: ViewDef,
  schema: DbSchema,
  ctx: { meId: string; members: Member[]; query?: string },
): PageMeta[] {
  const q = ctx.query?.trim().toLowerCase();
  const filtered = rows.filter(
    (r) =>
      view.filters.every((f) => matchesFilter(r, f, schema, ctx.meId)) &&
      (!q || schema.properties.some((p) => displayValue(r, p, ctx.members).toLowerCase().includes(q))),
  );
  return sortRows(filtered, view.sorts, schema, ctx.members);
}

export type Group = { key: string; label: string; option?: SelectOption; member?: Member; rows: PageMeta[] };

/** Board-Spalten: eine pro Option/Person, plus "Ohne …" */
export function groupRows(rows: PageMeta[], prop: PropDef | undefined, members: Member[]): Group[] {
  if (!prop) return [{ key: "all", label: "Alle", rows }];
  const groups: Group[] = [];
  const empty: Group = { key: "", label: `Ohne ${prop.name}`, rows: [] };
  if (prop.type === "person") {
    for (const m of members) groups.push({ key: m.id, label: m.name, member: m, rows: [] });
  } else if (prop.type === "checkbox") {
    groups.push({ key: "true", label: "Erledigt", rows: [] }, { key: "false", label: "Offen", rows: [] });
  } else {
    for (const o of prop.options ?? []) groups.push({ key: o.id, label: o.name, option: o, rows: [] });
  }
  for (const r of rows) {
    const v = getValue(r, prop);
    if (prop.type === "checkbox") {
      groups[v ? 0 : 1].rows.push(r);
      continue;
    }
    const keys = Array.isArray(v) ? v : isEmpty(v) ? [] : [String(v)];
    const hits = groups.filter((g) => keys.includes(g.key));
    if (hits.length) hits.forEach((g) => g.rows.push(r));
    else empty.rows.push(r);
  }
  const visible = prop.type === "person" ? groups.filter((g) => g.rows.length) : groups;
  return prop.type === "checkbox" ? visible : [empty, ...visible];
}

/** Wert setzen, wenn eine Karte in eine andere Board-Spalte gezogen wird */
export function valueForGroup(prop: PropDef, key: string, current: PropValue): PropValue {
  if (prop.type === "checkbox") return key === "true";
  if (prop.type === "multi_select" || prop.type === "person") {
    if (!key) return [];
    const list = Array.isArray(current) ? current : [];
    return list.includes(key) ? list : [key];
  }
  return key || null;
}

/** Status-Gruppe "erledigt"? (für "Meine Aufgaben") */
export function isDone(row: PageMeta, schema: DbSchema): boolean {
  const status = schema.properties.find((p) => p.type === "status");
  if (status) return optionById(status, row.props[status.id])?.group === "done";
  const check = schema.properties.find((p) => p.type === "checkbox");
  return check ? Boolean(row.props[check.id]) : false;
}

/** Werte, die neue Zeilen aus einer gefilterten Ansicht erben (z. B. Board-Spalte, "Zuständig ist ich") */
export function defaultsFromView(view: ViewDef, schema: DbSchema, meId: string): Record<string, PropValue> {
  const out: Record<string, PropValue> = {};
  for (const f of view.filters) {
    const prop = schema.properties.find((p) => p.id === f.prop);
    if (!prop || !f.value) continue;
    const v = resolve(f.value, meId);
    if ((f.op === "is" && (prop.type === "select" || prop.type === "status")) || (f.op === "is" && prop.type === "date")) out[prop.id] = v;
    if (f.op === "is" && prop.type === "checkbox") out[prop.id] = v === "true";
    if (f.op === "contains" && (prop.type === "multi_select" || prop.type === "person")) out[prop.id] = [v];
  }
  const status = schema.properties.find((p) => p.type === "status");
  if (status && out[status.id] === undefined) out[status.id] = status.options?.find((o) => o.group === "todo")?.id ?? null;
  return out;
}
