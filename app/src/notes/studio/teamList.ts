// Team-Aufgabenliste je Studio: dort landen Aufgaben, die am Studio-PC, im Dashboard oder beim Anpinnen
// schnell angelegt werden – sichtbar für alle im Studio (auch am PC, der nie private Listen zeigt).
// Feste ID je Studio: mehrere Geräte legen die Liste nie doppelt an.
import { stableId } from "../gamification/recur";
import type { CreateOptions } from "../state";
import { newView } from "../database/logic";
import type { DbSchema, Member, PageMeta, PropValue, Studio } from "../types";
import { today } from "../util";

export const TEAM_LIST_ROLE = "team_tasks";

export const teamListId = (studioId: string) => stableId("team-list", studioId);

type Notes = {
  pages: Map<string, PageMeta>;
  isLive: (id: string) => boolean;
  locations: Studio[];
  createPage: (opts: CreateOptions) => Promise<PageMeta>;
};

/** Liste des Studios finden oder anlegen */
export async function ensureTeamList(notes: Notes, studioId: string): Promise<PageMeta> {
  const id = teamListId(studioId);
  const found = notes.pages.get(id);
  if (found && notes.isLive(id)) return found;
  const name = notes.locations.find((l) => l.id === studioId)?.name ?? "Studio";
  return notes.createPage({ id, space: "team", kind: "database", title: `Aufgaben ${name}`, icon: "✅", schema: teamListSchema(), ifMissing: true });
}

/** Feste Spalten-IDs: legen zwei Geräte die Liste gleichzeitig an, passt trotzdem alles zusammen */
export function teamListSchema(): DbSchema {
  const schema: DbSchema = {
    role: TEAM_LIST_ROLE,
    properties: [
      { id: "title", name: "Aufgabe", type: "title" },
      {
        id: "status",
        name: "Status",
        type: "status",
        options: [
          { id: "todo", name: "Nicht begonnen", color: "gray", group: "todo" },
          { id: "doing", name: "In Arbeit", color: "blue", group: "doing" },
          { id: "done", name: "Erledigt", color: "green", group: "done" },
        ],
      },
      { id: "who", name: "Zuständig", type: "person" },
      { id: "due", name: "Fällig", type: "date" },
    ],
    views: [],
  };
  const board = { ...newView("board", schema, "Board"), id: "board", groupBy: "status" };
  const mine = { ...newView("table", schema, "Meine Aufgaben"), id: "mine", filters: [{ id: "f-me", prop: "who", op: "contains" as const, value: "me" }], sorts: [{ prop: "due", dir: "asc" as const }] };
  schema.views = [{ ...newView("table", schema, "Alle Aufgaben"), id: "all" }, board, mine];
  return schema;
}

/** Eigenschaften einer neuen Aufgabe: Person zuständig, offen, heute fällig */
export function newTaskProps(schema: DbSchema, member: Member, day = today()): Record<string, PropValue> {
  const props: Record<string, PropValue> = {};
  const person = schema.properties.find((p) => p.type === "person");
  const status = schema.properties.find((p) => p.type === "status");
  const due = schema.properties.find((p) => p.type === "date");
  if (person) props[person.id] = [member.id];
  const todo = status?.options?.find((o) => (o.group ?? "todo") === "todo");
  if (status && todo) props[status.id] = todo.id;
  if (due) props[due.id] = day;
  return props;
}

/** Aufgabe für eine Person in der Team-Liste ihres Studios anlegen */
export async function createTaskFor(notes: Notes, member: Member, title: string, fallbackStudio?: string | null): Promise<PageMeta | null> {
  const studioId = member.studioId ?? fallbackStudio ?? notes.locations[0]?.id;
  if (!studioId || !title.trim()) return null;
  const list = await ensureTeamList(notes, studioId);
  if (!list.schema) return null;
  return notes.createPage({ parentId: list.id, title: title.trim(), props: newTaskProps(list.schema, member) });
}
