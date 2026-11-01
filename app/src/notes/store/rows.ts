// Zeilen aus der Datenbank in App-Typen umwandeln – gemeinsam für den Browser-Speicher und die
// Server-Funktion "aufgaben" (keine weiteren Abhängigkeiten, damit der Server-Bundle klein bleibt).
import type { Color, Member, PageMeta } from "../types";
import { COLORS } from "../util";

export type DbRow = {
  id: string;
  parent_id: string | null;
  space: PageMeta["space"];
  owner_id: string;
  kind: PageMeta["kind"];
  title: string;
  icon: string | null;
  cover: string | null;
  props: PageMeta["props"] | null;
  schema: PageMeta["schema"];
  options: PageMeta["options"] | null;
  position: number;
  archived_at: string | null;
  created_at: string;
  created_by: string | null;
  updated_at: string;
  updated_by: string | null;
  deleted_at: string | null;
  deleted_by: string | null;
};

export const META_COLUMNS =
  "id, parent_id, space, owner_id, kind, title, icon, cover, props, schema, options, position, archived_at, created_at, created_by, updated_at, updated_by, deleted_at, deleted_by";

export const toMeta = (r: DbRow): PageMeta => ({
  id: r.id,
  parentId: r.parent_id,
  space: r.space,
  ownerId: r.owner_id,
  kind: r.kind,
  title: r.title ?? "",
  icon: r.icon,
  cover: r.cover,
  props: r.props ?? {},
  schema: r.schema,
  options: r.options ?? {},
  position: r.position,
  archivedAt: r.archived_at,
  createdAt: r.created_at,
  createdBy: r.created_by,
  updatedAt: r.updated_at,
  updatedBy: r.updated_by,
  deletedAt: r.deleted_at ?? null,
  deletedBy: r.deleted_by ?? null,
});

export const colorFor = (id: string): Color => {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return COLORS[1 + (h % (COLORS.length - 1))];
};

export type UserRow = { auth_user_id: string; first_name: string | null; last_name: string | null; role: string | null; home_location_id: string | null };

export const memberFromUser = (u: UserRow): Member => ({
  id: u.auth_user_id,
  name: `${u.first_name ?? ""} ${u.last_name ?? ""}`.trim() || "Unbekannt",
  color: colorFor(u.auth_user_id),
  role: u.role ?? undefined,
  studioId: u.home_location_id ?? null,
});
