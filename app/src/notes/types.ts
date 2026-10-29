// Datenmodell: Seiten bilden einen Baum; Datenbanken sind Seiten, deren Kinder die Zeilen sind.

export type Space = "private" | "team";
export type PageKind = "page" | "database";

export type Color = "default" | "gray" | "brown" | "orange" | "yellow" | "green" | "blue" | "purple" | "pink" | "red";

export type PropType =
  | "title"
  | "text"
  | "number"
  | "select"
  | "multi_select"
  | "status"
  | "date"
  | "person"
  | "checkbox"
  | "url"
  | "email"
  | "phone"
  | "created_time"
  | "last_edited_time"
  | "created_by"
  | "formula"
  | "relation"
  | "rollup";

export type StatusGroup = "todo" | "doing" | "done";

export type SelectOption = { id: string; name: string; color: Color; group?: StatusGroup };

export type RollupFn =
  | "show"
  | "count"
  | "count_values"
  | "count_unique"
  | "empty"
  | "not_empty"
  | "sum"
  | "average"
  | "min"
  | "max"
  | "range"
  | "earliest"
  | "latest"
  | "checked"
  | "unchecked"
  | "percent_checked";

export type PropDef = {
  id: string;
  name: string;
  type: PropType;
  options?: SelectOption[];
  format?: "number" | "euro" | "percent";
  /** Formel, z. B. prop("Preis") * prop("Menge") */
  formula?: string;
  /** Verknüpfung: Ziel-Datenbank und (bei gegenseitiger Verknüpfung) die Gegen-Eigenschaft dort */
  relation?: { dbId: string; backPropId?: string };
  /** Rollup: Werte der verknüpften Einträge zusammenfassen */
  rollup?: { relationPropId: string; targetPropId: string; fn: RollupFn };
};

export type ViewType = "table" | "board" | "list" | "calendar" | "gallery";

export type FilterOp =
  | "contains"
  | "not_contains"
  | "is"
  | "is_not"
  | "empty"
  | "not_empty"
  | "gt"
  | "lt"
  | "before"
  | "after";

export type Filter = { id: string; prop: string; op: FilterOp; value?: string };
export type Sort = { prop: string; dir: "asc" | "desc" };

export type ViewDef = {
  id: string;
  name: string;
  type: ViewType;
  filters: Filter[];
  sorts: Sort[];
  /** Ausgeblendete Eigenschaften (Titel ist immer sichtbar) */
  hidden: string[];
  /** Spaltenbreiten in der Tabelle */
  widths?: Record<string, number>;
  /** Board: Gruppierung nach Auswahl/Status/Person */
  groupBy?: string;
  /** Kalender: Datums-Eigenschaft */
  dateProp?: string;
};

export type DbSchema = { properties: PropDef[]; views: ViewDef[] };

export type PropValue = string | number | boolean | string[] | null;

export type PageOptions = {
  fullWidth?: boolean;
  smallText?: boolean;
  font?: "default" | "serif" | "mono";
  locked?: boolean;
};

export type PageMeta = {
  id: string;
  parentId: string | null;
  space: Space;
  ownerId: string;
  kind: PageKind;
  title: string;
  icon: string | null;
  cover: string | null;
  props: Record<string, PropValue>;
  schema: DbSchema | null;
  options: PageOptions;
  position: number;
  archivedAt: string | null;
  createdAt: string;
  createdBy: string | null;
  updatedAt: string;
  updatedBy: string | null;
};

/** BlockNote-Dokument (JSON) */
export type Blocks = unknown[];

export type PagePatch = Partial<Omit<PageMeta, "id" | "createdAt" | "createdBy">> & {
  content?: Blocks;
  plain?: string;
  /** Yjs-Dokument (Base64) – Grundlage für gemeinsames Bearbeiten und Kommentare */
  ydoc?: string | null;
};

export type NewPage = PageMeta & { content: Blocks; plain: string };

export type Member = { id: string; name: string; color: Color };

export type StoreEvent =
  | { type: "upsert"; page: PageMeta; content?: Blocks; ydoc?: string | null }
  | { type: "delete"; id: string };

/** Nachrichten zwischen Editoren derselben Seite (Yjs-Änderungen, Cursor/Anwesenheit) */
export type CollabMessage =
  | { type: "update"; data: string }
  | { type: "awareness"; data: string }
  | { type: "hello"; from: string; sv: string }
  | { type: "sync"; to: string; data: string; sv?: string };

export type CollabChannel = { send(message: CollabMessage): void; close(): void };

export type Version = { id: string; pageId: string; createdAt: string; createdBy: string | null; title: string; content?: Blocks };

/** Speicher-Schnittstelle: lokal (Browser) oder Supabase (gemeinsam mit Clock-In) */
export interface NotesStore {
  readonly kind: "local" | "supabase";
  me(): Promise<Member>;
  members(): Promise<Member[]>;
  listPages(): Promise<PageMeta[]>;
  getContent(id: string): Promise<Blocks>;
  /** Inhalt und Yjs-Dokument einer Seite */
  getDoc(id: string): Promise<{ content: Blocks; ydoc: string | null }>;
  /** Kanal für Live-Bearbeitung einer Seite */
  collab(pageId: string, onMessage: (message: CollabMessage) => void): CollabChannel;
  listVersions(pageId: string): Promise<Version[]>;
  getVersion(id: string): Promise<Version | null>;
  saveVersion(version: { pageId: string; title: string; content: Blocks }): Promise<void>;
  create(page: NewPage): Promise<void>;
  update(id: string, patch: PagePatch): Promise<void>;
  remove(ids: string[]): Promise<void>;
  /** IDs der Seiten, deren Inhalt den Suchbegriff enthält */
  search(query: string): Promise<string[]>;
  favorites(): Promise<string[]>;
  setFavorite(id: string, on: boolean): Promise<void>;
  /** Datei hochladen → im Dokument gespeicherte Adresse */
  upload(file: File): Promise<string>;
  /** Gespeicherte Adresse → anzeigbare Adresse (z. B. signierte URL) */
  resolveUrl(url: string): Promise<string>;
  subscribe(onEvent: (event: StoreEvent) => void): () => void;
}
