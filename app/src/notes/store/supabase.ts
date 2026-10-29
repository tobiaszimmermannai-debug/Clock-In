// Supabase-Speicher: dieselbe Datenbank wie Clock-In (Tabellen note_pages / note_favorites, Bucket "notes")
import type { RealtimeChannel, SupabaseClient } from "@supabase/supabase-js";
import type { Blocks, Color, Member, NewPage, NotesStore, PageMeta, PagePatch, StoreEvent } from "../types";
import { COLORS } from "../util";

type DbRow = {
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
  content?: Blocks;
};

const META_COLUMNS =
  "id, parent_id, space, owner_id, kind, title, icon, cover, props, schema, options, position, archived_at, created_at, created_by, updated_at, updated_by";

const FILE_PREFIX = "sb-notes://";

const toMeta = (r: DbRow): PageMeta => ({
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
});

function toRow(p: PagePatch): Record<string, unknown> {
  const map: Record<string, string> = {
    parentId: "parent_id",
    space: "space",
    ownerId: "owner_id",
    kind: "kind",
    title: "title",
    icon: "icon",
    cover: "cover",
    props: "props",
    schema: "schema",
    options: "options",
    position: "position",
    archivedAt: "archived_at",
    content: "content",
    plain: "plain",
  };
  const row: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(p)) if (k in map && v !== undefined) row[map[k]] = v;
  return row;
}

const colorFor = (id: string): Color => {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return COLORS[1 + (h % (COLORS.length - 1))];
};

export class SupabaseStore implements NotesStore {
  readonly kind = "supabase" as const;
  private userId?: string;
  private signed = new Map<string, { url: string; until: number }>();

  constructor(private db: SupabaseClient) {}

  private async uid(): Promise<string> {
    if (this.userId) return this.userId;
    const { data } = await this.db.auth.getSession();
    if (!data.session) throw new Error("Nicht angemeldet.");
    this.userId = data.session.user.id;
    return this.userId;
  }

  async me(): Promise<Member> {
    const id = await this.uid();
    const { data } = await this.db.from("users").select("first_name, last_name").eq("auth_user_id", id).maybeSingle();
    const name = data ? `${data.first_name ?? ""} ${data.last_name ?? ""}`.trim() : "Ich";
    return { id, name: name || "Ich", color: colorFor(id) };
  }

  async members(): Promise<Member[]> {
    const { data, error } = await this.db
      .from("users")
      .select("auth_user_id, first_name, last_name")
      .eq("is_active", true)
      .not("auth_user_id", "is", null)
      .order("first_name");
    if (error) throw error;
    return (data ?? []).map((u) => ({
      id: u.auth_user_id as string,
      name: `${u.first_name ?? ""} ${u.last_name ?? ""}`.trim() || "Unbekannt",
      color: colorFor(u.auth_user_id as string),
    }));
  }

  async listPages(): Promise<PageMeta[]> {
    // Seitenweise laden (PostgREST liefert höchstens 1000 Zeilen pro Abfrage)
    const out: PageMeta[] = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await this.db.from("note_pages").select(META_COLUMNS).order("position").range(from, from + 999);
      if (error) throw error;
      out.push(...(data as DbRow[]).map(toMeta));
      if (!data || data.length < 1000) return out;
    }
  }

  async getContent(id: string): Promise<Blocks> {
    const { data, error } = await this.db.from("note_pages").select("content").eq("id", id).maybeSingle();
    if (error) throw error;
    return (data?.content as Blocks | undefined) ?? [];
  }

  async create(page: NewPage): Promise<void> {
    const { createdAt: _c, updatedAt: _u, createdBy: _cb, updatedBy: _ub, ...rest } = page;
    const { error } = await this.db.from("note_pages").insert({ id: page.id, ...toRow(rest) });
    if (error) throw error;
  }

  async update(id: string, patch: PagePatch): Promise<void> {
    const row = toRow(patch);
    if (!Object.keys(row).length) return;
    const { error } = await this.db.from("note_pages").update(row).eq("id", id);
    if (error) throw error;
  }

  async remove(ids: string[]): Promise<void> {
    if (!ids.length) return;
    const { error } = await this.db.from("note_pages").delete().in("id", ids);
    if (error) throw error;
  }

  async search(query: string): Promise<string[]> {
    const q = query.replace(/[%_,()]/g, " ").trim();
    if (!q) return [];
    const { data, error } = await this.db.from("note_pages").select("id").ilike("plain", `%${q}%`).limit(50);
    if (error) throw error;
    return (data ?? []).map((r) => r.id as string);
  }

  async favorites(): Promise<string[]> {
    const { data, error } = await this.db.from("note_favorites").select("page_id").order("created_at");
    if (error) throw error;
    return (data ?? []).map((r) => r.page_id as string);
  }

  async setFavorite(id: string, on: boolean): Promise<void> {
    const userId = await this.uid();
    const { error } = on
      ? await this.db.from("note_favorites").upsert({ user_id: userId, page_id: id })
      : await this.db.from("note_favorites").delete().eq("user_id", userId).eq("page_id", id);
    if (error) throw error;
  }

  async upload(file: File): Promise<string> {
    const userId = await this.uid();
    const clean = file.name.normalize("NFKD").replace(/[^\w.-]+/g, "_").slice(-80) || "datei";
    const path = `${userId}/${crypto.randomUUID()}-${clean}`;
    const { error } = await this.db.storage.from("notes").upload(path, file, { contentType: file.type || undefined });
    if (error) throw error;
    return FILE_PREFIX + path;
  }

  async resolveUrl(url: string): Promise<string> {
    if (!url.startsWith(FILE_PREFIX)) return url;
    const path = url.slice(FILE_PREFIX.length);
    const cached = this.signed.get(path);
    if (cached && cached.until > Date.now()) return cached.url;
    const { data, error } = await this.db.storage.from("notes").createSignedUrl(path, 60 * 60);
    if (error || !data) throw error ?? new Error("Datei nicht gefunden.");
    this.signed.set(path, { url: data.signedUrl, until: Date.now() + 50 * 60 * 1000 });
    return data.signedUrl;
  }

  subscribe(onEvent: (e: StoreEvent) => void): () => void {
    let channel: RealtimeChannel | undefined = this.db
      .channel(`note_pages_${Math.random().toString(36).slice(2)}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "note_pages" }, (payload) => {
        if (payload.eventType === "DELETE") {
          const id = (payload.old as { id?: string }).id;
          if (id) onEvent({ type: "delete", id });
          return;
        }
        const row = payload.new as DbRow;
        onEvent({ type: "upsert", page: toMeta(row), content: row.content });
      })
      .subscribe();
    return () => {
      if (channel) void this.db.removeChannel(channel);
      channel = undefined;
    };
  }
}
