// Wochen- & Monatsaufgaben – Datenbank, Rechte und Anlegen (geteilt von Übersicht und Studio-Dashboard).
// Wochenaufgaben: Studioleitung und Studio-PC fürs eigene Studio (ohne Freigabe), Tobias & Dominik für alle.
// Monatsaufgaben: nur Tobias & Dominik (Geschäftsführung).
import { newView, STATUS_DEFAULTS } from "../database/logic";
import { PHOTO_KEY, REPEAT_KEY, stableId } from "../gamification/recur";
import type { CreateOptions } from "../state";
import type { Access, Color, DbSchema, Member, PageMeta, PagePatch, PropDef, Studio } from "../types";
import { COLORS } from "../util";
import type { Rhythm } from "./period";

export const STUDIO_DB_ROLE = "studio_tasks";
/** Feste ID für eine neu angelegte Datenbank: legen PC und Leitung gleichzeitig an, gibt es trotzdem nur eine */
export const STUDIO_DB_ID = stableId("studio-tasks", "db");

// Feste Eigenschafts-IDs, damit die Übersicht die Spalten findet
export const STUDIO_PROPS = { studio: "studio", rhythm: "rhythm", period: "period", status: "status", assignee: "assignee", due: "due", group: "group" } as const;
const P = STUDIO_PROPS;

export const RHYTHM_OWNER: Record<Rhythm, string> = { week: "Studioleitung", month: "Tobias & Dominik" };

type Notes = {
  pages: Map<string, PageMeta>;
  isLive: (id: string) => boolean;
  locations: Studio[];
  createPage: (opts: CreateOptions) => Promise<PageMeta>;
  updatePage: (id: string, patch: PagePatch, opts?: { delay?: number }) => void;
};

/** Für welche Studios darf ich Aufgaben dieses Rhythmus anlegen? */
export function creatableStudios(access: Access, me: Pick<Member, "studioId">, locations: Studio[], rhythm: Rhythm): string[] {
  if (access.admin) return locations.map((l) => l.id);
  if (rhythm === "month") return [];
  if (access.studio) return access.studioLocationId ? [access.studioLocationId] : [];
  if (access.oversee && me.studioId) return [me.studioId];
  return [];
}

function studioOptions(locations: Studio[]) {
  return locations.map((l, i) => ({ id: l.id, name: l.name, color: COLORS[1 + (i % (COLORS.length - 1))] as Color }));
}

export function studioSchema(locations: Studio[]): DbSchema {
  const props: PropDef[] = [
    { id: "title", name: "Aufgabe", type: "title" },
    { id: P.studio, name: "Studio", type: "select", options: studioOptions(locations) },
    {
      id: P.rhythm,
      name: "Rhythmus",
      type: "select",
      options: [
        { id: "week", name: "Woche", color: "blue" },
        { id: "month", name: "Monat", color: "purple" },
      ],
    },
    { id: P.period, name: "Zeitraum", type: "text" },
    { id: P.status, name: "Status", type: "status", options: STATUS_DEFAULTS() },
    { id: P.assignee, name: "Zuständig", type: "person" },
    { id: P.due, name: "Fällig", type: "date" },
    { id: P.group, name: "Verteilung", type: "text" },
  ];
  const schema: DbSchema = { properties: props, views: [], role: STUDIO_DB_ROLE };
  const all = { ...newView("table", schema, "Alle"), id: "all" };
  all.hidden = [P.group];
  all.sorts = [{ prop: P.due, dir: "asc" }];
  const byStudio = { ...newView("board", schema, "Nach Studio"), id: "by-studio" };
  byStudio.groupBy = P.studio;
  byStudio.hidden = [P.group, P.period];
  const byStatus = { ...newView("board", schema, "Nach Status"), id: "by-status" };
  byStatus.groupBy = P.status;
  byStatus.hidden = [P.group, P.period];
  schema.views = [all, byStudio, byStatus];
  return schema;
}

export function findStudioDb(pages: Map<string, PageMeta>, isLive: (id: string) => boolean): PageMeta | undefined {
  return [...pages.values()].find((p) => p.kind === "database" && p.schema?.role === STUDIO_DB_ROLE && isLive(p.id));
}

/** Datenbank finden (neue Studios als Auswahl ergänzen) oder anlegen */
export async function ensureStudioDb(notes: Notes): Promise<PageMeta> {
  const found = findStudioDb(notes.pages, notes.isLive);
  if (found?.schema) {
    const studioProp = found.schema.properties.find((p) => p.id === P.studio);
    const missing = studioOptions(notes.locations).filter((o) => !studioProp?.options?.some((x) => x.id === o.id));
    if (studioProp && missing.length) {
      notes.updatePage(found.id, {
        schema: { ...found.schema, properties: found.schema.properties.map((p) => (p.id === P.studio ? { ...p, options: [...(p.options ?? []), ...missing] } : p)) },
      });
    }
    return found;
  }
  return notes.createPage({
    id: STUDIO_DB_ID,
    space: "team",
    kind: "database",
    title: "Wochen- & Monatsaufgaben",
    icon: "🗓️",
    schema: studioSchema(notes.locations),
    ifMissing: true,
  });
}

export type StudioRow = {
  title: string;
  studio: string;
  rhythm: Rhythm;
  period: string;
  group: string;
  due: string;
  content?: unknown[];
  repeat?: boolean;
  photo?: boolean;
};

export function studioRowProps(schema: DbSchema | null | undefined, v: StudioRow) {
  const todo = schema?.properties.find((p) => p.id === P.status)?.options?.find((o) => (o.group ?? "todo") === "todo");
  return {
    [P.studio]: v.studio,
    [P.rhythm]: v.rhythm,
    [P.period]: v.period,
    [P.status]: todo?.id ?? null,
    [P.due]: v.due,
    [P.group]: v.group,
    ...(v.repeat ? { [REPEAT_KEY]: "period" } : {}),
    ...(v.photo ? { [PHOTO_KEY]: true } : {}),
  };
}

export function createStudioRow(notes: Pick<Notes, "createPage">, target: PageMeta, v: StudioRow) {
  return notes.createPage({ parentId: target.id, title: v.title, props: studioRowProps(target.schema, v), content: v.content });
}
