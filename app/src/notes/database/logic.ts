// Datenbank-Logik ohne UI: Werte lesen und berechnen (Formel, Verknüpfung, Rollup), filtern, sortieren, gruppieren
import type { DbSchema, Filter, FilterOp, Member, PageMeta, PropDef, PropType, PropValue, RollupFn, SelectOption, Sort, ViewDef, ViewType } from "../types";
import { formatDate, formatTimestamp, randomColor, shortId, today, untitled } from "../util";
import { dateToIso, evaluateFormula, type FValue, isEmptyValue, toText } from "./formula";

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
  formula: "Formel",
  relation: "Verknüpfung",
  rollup: "Rollup",
};

export const VIEW_LABELS: Record<ViewType, string> = {
  table: "Tabelle",
  board: "Board",
  list: "Liste",
  calendar: "Kalender",
  gallery: "Galerie",
};

export const READONLY_TYPES: PropType[] = ["created_time", "last_edited_time", "created_by", "formula", "rollup"];
export const COMPUTED_TYPES: PropType[] = ["formula", "rollup"];

export const ROLLUP_LABELS: Record<RollupFn, string> = {
  show: "Originalwerte anzeigen",
  count: "Anzahl Einträge",
  count_values: "Anzahl Werte",
  count_unique: "Anzahl eindeutiger Werte",
  empty: "Anzahl leer",
  not_empty: "Anzahl nicht leer",
  sum: "Summe",
  average: "Durchschnitt",
  min: "Minimum",
  max: "Maximum",
  range: "Spanne",
  earliest: "Frühestes Datum",
  latest: "Spätestes Datum",
  checked: "Anzahl angehakt",
  unchecked: "Anzahl nicht angehakt",
  percent_checked: "Prozent angehakt",
};

/** Sinnvolle Rollup-Funktionen je Typ der Ziel-Eigenschaft */
export function rollupFnsFor(type: PropType | undefined): RollupFn[] {
  const base: RollupFn[] = ["show", "count", "count_values", "count_unique", "empty", "not_empty"];
  if (type === "number" || type === "formula" || type === "rollup") return [...base, "sum", "average", "min", "max", "range"];
  if (type === "date" || type === "created_time" || type === "last_edited_time") return [...base, "earliest", "latest", "range"];
  if (type === "checkbox") return [...base, "checked", "unchecked", "percent_checked"];
  return base;
}

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
  if (type === "formula") def.formula = "";
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

// ---------------- Werte ----------------

/** Kontext für berechnete Werte: alle Seiten (für Verknüpfungen) und Personen */
export type ValueCtx = { pages: Map<string, PageMeta>; members: Member[]; depth?: number };

const MAX_DEPTH = 6;
const schemaOf = (row: PageMeta, ctx: ValueCtx) => (row.parentId ? ctx.pages.get(row.parentId)?.schema : undefined) ?? undefined;
const deeper = (ctx: ValueCtx): ValueCtx => ({ ...ctx, depth: (ctx.depth ?? 0) + 1 });

/** Verknüpfte, nicht gelöschte Einträge */
export function relatedRows(row: PageMeta, prop: PropDef, ctx: ValueCtx): PageMeta[] {
  const ids = row.props[prop.id];
  if (!Array.isArray(ids)) return [];
  return ids.map((id) => ctx.pages.get(id)).filter((p): p is PageMeta => Boolean(p && !p.archivedAt));
}

function toDateObj(v: string): Date {
  const m = v.match(/^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/);
  return m ? new Date(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 0), +(m[5] ?? 0)) : new Date(v);
}

/** Wert als Formel-Wert (Zahl, Text, Datum, Liste …) – Grundlage für Formeln, Rollups und Anzeige berechneter Werte */
export function richValue(row: PageMeta, prop: PropDef, ctx: ValueCtx): FValue {
  if ((ctx.depth ?? 0) > MAX_DEPTH) return null;
  const raw = row.props[prop.id] ?? null;
  switch (prop.type) {
    case "title":
      return row.title;
    case "number":
      return raw === null || raw === "" ? null : Number(raw);
    case "checkbox":
      return Boolean(raw);
    case "date":
      return raw ? toDateObj(String(raw)) : null;
    case "created_time":
      return new Date(row.createdAt);
    case "last_edited_time":
      return new Date(row.updatedAt);
    case "created_by":
      return ctx.members.find((m) => m.id === row.createdBy)?.name ?? null;
    case "select":
    case "status":
      return optionById(prop, raw)?.name ?? null;
    case "multi_select":
      return (Array.isArray(raw) ? raw : []).map((id) => optionById(prop, id)?.name ?? "").filter(Boolean);
    case "person":
      return (Array.isArray(raw) ? raw : []).map((id) => ctx.members.find((m) => m.id === id)?.name ?? "").filter(Boolean);
    case "relation":
      return relatedRows(row, prop, ctx).map((r) => untitled(r));
    case "formula":
      return formulaResult(row, prop, ctx).value;
    case "rollup":
      return rollupValue(row, prop, ctx);
    default:
      return raw === null ? null : String(raw);
  }
}

export function formulaResult(row: PageMeta, prop: PropDef, ctx: ValueCtx): { value: FValue; error?: string } {
  if ((ctx.depth ?? 0) > MAX_DEPTH) return { value: null, error: "Formel verweist im Kreis auf sich selbst." };
  const schema = schemaOf(row, ctx);
  const inner = deeper(ctx);
  return evaluateFormula(prop.formula ?? "", {
    prop: (name) => {
      if (name.toLowerCase() === "titel" || name.toLowerCase() === "title") return row.title;
      const target = schema?.properties.find((p) => p.name.toLowerCase() === name.toLowerCase());
      if (!target) throw new Error(`Eigenschaft „${name}“ gibt es nicht.`);
      return richValue(row, target, inner);
    },
  });
}

export function rollupValue(row: PageMeta, prop: PropDef, ctx: ValueCtx): FValue {
  const cfg = prop.rollup;
  const schema = schemaOf(row, ctx);
  const rel = schema?.properties.find((p) => p.id === cfg?.relationPropId && p.type === "relation");
  if (!cfg || !rel?.relation) return null;
  const target = ctx.pages.get(rel.relation.dbId)?.schema?.properties.find((p) => p.id === cfg.targetPropId);
  const rows = relatedRows(row, rel, ctx);
  if (!target) return cfg.fn === "count" ? rows.length : null;
  const inner = deeper(ctx);
  const perRow = rows.map((r) => richValue(r, target, inner));
  const values = perRow.flatMap((v) => (Array.isArray(v) ? v : [v]));
  const present = values.filter((v) => !isEmptyValue(v) && v !== false);
  const nums = values.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  const dates = values.filter((v): v is Date => v instanceof Date).map((d) => d.getTime());
  switch (cfg.fn) {
    case "show":
      return values.filter((v) => !isEmptyValue(v)).map((v) => (v instanceof Date ? v : typeof v === "boolean" ? (v ? "✓" : "–") : v));
    case "count":
      return rows.length;
    case "count_values":
      return present.length;
    case "count_unique":
      return new Set(present.map(toText)).size;
    case "empty":
      return perRow.filter((v) => isEmptyValue(v)).length;
    case "not_empty":
      return perRow.filter((v) => !isEmptyValue(v)).length;
    case "sum":
      return nums.reduce((s, x) => s + x, 0);
    case "average":
      return nums.length ? nums.reduce((s, x) => s + x, 0) / nums.length : null;
    case "min":
      return nums.length ? Math.min(...nums) : null;
    case "max":
      return nums.length ? Math.max(...nums) : null;
    case "range":
      if (dates.length) return Math.round((Math.max(...dates) - Math.min(...dates)) / 864e5);
      return nums.length ? Math.max(...nums) - Math.min(...nums) : null;
    case "earliest":
      return dates.length ? new Date(Math.min(...dates)) : null;
    case "latest":
      return dates.length ? new Date(Math.max(...dates)) : null;
    case "checked":
      return values.filter((v) => v === true).length;
    case "unchecked":
      return values.filter((v) => v === false).length;
    case "percent_checked":
      return values.length ? Math.round((values.filter((v) => v === true).length / values.length) * 100) : null;
  }
}

/** Berechneter Wert als speicherbarer Wert (Zahl, Text, Wahr/Falsch, ISO-Datum, Liste) */
function computedToProp(v: FValue): PropValue {
  if (v === null) return null;
  if (v instanceof Date) return dateToIso(v);
  if (Array.isArray(v)) return v.map(toText).filter(Boolean);
  return v;
}

/** Wert einer Eigenschaft für eine Zeile (inkl. berechneter Werte, wenn ctx vorhanden) */
export function getValue(row: PageMeta, prop: PropDef, ctx?: ValueCtx): PropValue {
  switch (prop.type) {
    case "title":
      return row.title;
    case "created_time":
      return row.createdAt;
    case "last_edited_time":
      return row.updatedAt;
    case "created_by":
      return row.createdBy;
    case "formula":
    case "rollup":
      return ctx ? computedToProp(richValue(row, prop, ctx)) : null;
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
export function displayValue(row: PageMeta, prop: PropDef, ctx: ValueCtx): string {
  if (prop.type === "formula" || prop.type === "rollup" || prop.type === "relation") {
    const v = richValue(row, prop, ctx);
    if (typeof v === "number" && prop.format) return formatNumber(v, prop.format);
    return toText(v);
  }
  const v = getValue(row, prop, ctx);
  if (v === null || v === undefined || v === "") return "";
  switch (prop.type) {
    case "select":
    case "status":
      return optionById(prop, v)?.name ?? "";
    case "multi_select":
      return (Array.isArray(v) ? v : []).map((id) => optionById(prop, id)?.name ?? "").filter(Boolean).join(", ");
    case "person":
      return (Array.isArray(v) ? v : []).map((id) => ctx.members.find((m) => m.id === id)?.name ?? "").filter(Boolean).join(", ");
    case "created_by":
      return ctx.members.find((m) => m.id === v)?.name ?? "";
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
  return n.toLocaleString("de-DE", { maximumFractionDigits: 10 });
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
    case "relation":
      return ["contains", "not_contains", "empty", "not_empty"];
    case "checkbox":
      return ["is"];
    case "date":
    case "created_time":
    case "last_edited_time":
      return ["is", "before", "after", "empty", "not_empty"];
    case "formula":
    case "rollup":
      return ["contains", "not_contains", "is", "is_not", "gt", "lt", "empty", "not_empty"];
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

export function matchesFilter(row: PageMeta, f: Filter, schema: DbSchema, meId: string, ctx?: ValueCtx): boolean {
  const prop = schema.properties.find((p) => p.id === f.prop);
  if (!prop) return true;
  const v = getValue(row, prop, ctx);
  if (f.op === "empty") return isEmpty(v) || v === false;
  if (f.op === "not_empty") return !isEmpty(v) && v !== false;
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
    case "person":
    case "relation": {
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
      // Text und berechnete Werte (Formel, Rollup): Zahlen numerisch vergleichen, sonst als Text
      const text = Array.isArray(v) ? v.join(", ") : typeof v === "boolean" ? (v ? "true" : "false") : String(v ?? "");
      const numeric = typeof v === "number" || (text !== "" && !Number.isNaN(Number(text)));
      if (f.op === "gt" || f.op === "lt") {
        if (!numeric || isEmpty(v)) return false;
        return f.op === "gt" ? Number(text) > Number(target.replace(",", ".")) : Number(text) < Number(target.replace(",", "."));
      }
      if (numeric && (f.op === "is" || f.op === "is_not") && !Number.isNaN(Number(target.replace(",", ".")))) {
        const same = Number(text) === Number(target.replace(",", "."));
        return f.op === "is" ? same : !same;
      }
      const s = text.toLowerCase();
      const t = target.toLowerCase();
      if (f.op === "contains") return s.includes(t);
      if (f.op === "not_contains") return !s.includes(t);
      if (f.op === "is") return s === t;
      if (f.op === "is_not") return s !== t;
      return true;
    }
  }
}

function sortKey(row: PageMeta, prop: PropDef, ctx: ValueCtx): string | number {
  if (prop.type === "formula" || prop.type === "rollup") {
    const v = richValue(row, prop, ctx);
    if (typeof v === "number") return v;
    if (v instanceof Date) return v.getTime();
    if (typeof v === "boolean") return v ? 1 : 0;
    return toText(v).toLowerCase() || "￿";
  }
  const v = getValue(row, prop, ctx);
  if (prop.type === "number") return isEmpty(v) ? Number.POSITIVE_INFINITY : Number(v);
  if (prop.type === "checkbox") return v ? 1 : 0;
  if (prop.type === "select" || prop.type === "status") {
    const i = prop.options?.findIndex((o) => o.id === v) ?? -1;
    return i < 0 ? Number.POSITIVE_INFINITY : i;
  }
  if (prop.type === "date" || prop.type === "created_time" || prop.type === "last_edited_time") return isEmpty(v) ? "￿" : String(v);
  return displayValue(row, prop, ctx).toLowerCase() || "￿";
}

export function sortRows(rows: PageMeta[], sorts: Sort[], schema: DbSchema, ctx: ValueCtx): PageMeta[] {
  const active = sorts
    .map((s) => ({ s, prop: schema.properties.find((p) => p.id === s.prop) }))
    .filter((x): x is { s: Sort; prop: PropDef } => Boolean(x.prop));
  // Schlüssel einmal je Zeile berechnen (Formeln/Rollups sind teurer)
  const keys = new Map(rows.map((r) => [r.id, active.map(({ prop }) => sortKey(r, prop, ctx))]));
  return [...rows].sort((a, b) => {
    const ka = keys.get(a.id)!;
    const kb = keys.get(b.id)!;
    for (let i = 0; i < active.length; i++) {
      if (ka[i] === kb[i]) continue;
      const x = ka[i];
      const y = kb[i];
      const cmp = typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y), "de");
      return active[i].s.dir === "asc" ? cmp : -cmp;
    }
    return a.position - b.position || a.createdAt.localeCompare(b.createdAt);
  });
}

/** Zeilen einer Ansicht: Filter + Sortierung + Schnellsuche */
export function viewRows(rows: PageMeta[], view: ViewDef, schema: DbSchema, ctx: ValueCtx & { meId: string; query?: string }): PageMeta[] {
  const q = ctx.query?.trim().toLowerCase();
  const filtered = rows.filter(
    (r) =>
      view.filters.every((f) => matchesFilter(r, f, schema, ctx.meId, ctx)) &&
      (!q || schema.properties.some((p) => displayValue(r, p, ctx).toLowerCase().includes(q))),
  );
  return sortRows(filtered, view.sorts, schema, ctx);
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
    if (f.op === "contains" && (prop.type === "multi_select" || prop.type === "person" || prop.type === "relation")) out[prop.id] = [v];
  }
  const status = schema.properties.find((p) => p.type === "status");
  if (status && out[status.id] === undefined) out[status.id] = status.options?.find((o) => o.group === "todo")?.id ?? null;
  return out;
}

/** Verknüpfung setzen und bei gegenseitiger Verknüpfung die Gegenseite mitpflegen */
export function relationUpdates(
  row: PageMeta,
  prop: PropDef,
  next: string[],
  pages: Map<string, PageMeta>,
): { id: string; props: Record<string, PropValue> }[] {
  const prev = Array.isArray(row.props[prop.id]) ? (row.props[prop.id] as string[]) : [];
  const out = [{ id: row.id, props: { ...row.props, [prop.id]: next } }];
  const back = prop.relation?.backPropId;
  if (!back) return out;
  const touched = [...next.filter((id) => !prev.includes(id)), ...prev.filter((id) => !next.includes(id))];
  for (const id of touched) {
    const target = id === row.id ? { ...row, props: out[0].props } : pages.get(id);
    if (!target) continue;
    const list = Array.isArray(target.props[back]) ? (target.props[back] as string[]) : [];
    const wanted = next.includes(id);
    const updated = wanted ? (list.includes(row.id) ? list : [...list, row.id]) : list.filter((x) => x !== row.id);
    if (id === row.id) out[0] = { id, props: { ...out[0].props, [back]: updated } };
    else out.push({ id, props: { ...target.props, [back]: updated } });
  }
  return out;
}
