// Aufgaben über alle Datenbanken: wer ist zuständig, was ist offen/überfällig, "erledigt" setzen
import { getValue, isDone } from "../database/logic";
import type { DbSchema, PageMeta, PropValue } from "../types";
import { today } from "../util";

export type TaskItem = { row: PageMeta; db: PageMeta; due: string | null; done: boolean; overdue: boolean };

/** Alle Einträge aller Datenbanken (nur lebende); filter grenzt die Datenbanken ein */
export function allTasks(pages: Map<string, PageMeta>, isLive: (id: string) => boolean, filter: (db: PageMeta) => boolean = () => true): TaskItem[] {
  const day = today();
  const dbs = new Map<string, PageMeta>();
  for (const p of pages.values()) if (p.kind === "database" && p.schema && isLive(p.id) && filter(p)) dbs.set(p.id, p);
  const out: TaskItem[] = [];
  for (const row of pages.values()) {
    const db = row.parentId ? dbs.get(row.parentId) : undefined;
    if (!db || row.archivedAt || row.deletedAt) continue;
    const dateProp = db.schema!.properties.find((p) => p.type === "date");
    const due = dateProp ? ((row.props[dateProp.id] as string | null) ?? null) : null;
    const done = isDone(row, db.schema!);
    out.push({ row, db, due, done, overdue: !done && Boolean(due) && due!.slice(0, 10) < day });
  }
  return out;
}

export function assigneesOf(row: PageMeta, schema: DbSchema): string[] {
  return schema.properties
    .filter((p) => p.type === "person")
    .flatMap((p) => {
      const v = getValue(row, p);
      return Array.isArray(v) ? v : [];
    });
}

/** Aufgaben einer Person: ihr zugewiesen – oder ohne Zuständige in ihrer eigenen privaten Liste */
export function tasksOf(items: TaskItem[], userId: string): TaskItem[] {
  return items.filter(({ row, db }) => {
    const who = assigneesOf(row, db.schema!);
    return who.includes(userId) || (!who.length && db.space === "private" && db.ownerId === userId);
  });
}

/** Offen zuerst nach Fälligkeit (überfällig oben), ohne Datum zuletzt */
export const byDue = (a: TaskItem, b: TaskItem) => (a.due ?? "￿").localeCompare(b.due ?? "￿") || a.row.position - b.row.position;

/** Eigenschaften, die einen Eintrag erledigt (bzw. wieder offen) machen; null = Datenbank kennt kein "erledigt" */
export function doneProps(row: PageMeta, schema: DbSchema, done: boolean): Record<string, PropValue> | null {
  const status = schema.properties.find((p) => p.type === "status");
  if (status) {
    const option = status.options?.find((o) => (o.group ?? "todo") === (done ? "done" : "todo"));
    return option ? { ...row.props, [status.id]: option.id } : null;
  }
  const check = schema.properties.find((p) => p.type === "checkbox");
  return check ? { ...row.props, [check.id]: done } : null;
}
