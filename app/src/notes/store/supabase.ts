// Supabase-Speicher: dieselbe Datenbank wie Clock-In
// note_pages (Metadaten, live an alle) · note_docs (Inhalt + Yjs-Stand) · note_doc_updates (Änderungsschritte)
// note_favorites · note_versions · Bucket "notes" (Dateien unter <Seiten-ID>/…)
import type { RealtimeChannel, SupabaseClient } from "@supabase/supabase-js";
import { mergeUpdates } from "yjs";
import type { Blocks, CollabMessage, Color, DocState, Member, NewPage, NotesStore, PageMeta, PagePatch, StoreEvent, Version } from "../types";
import { COLORS, fromBase64, plainText, toBase64 } from "../util";

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
};

const MAX_VERSIONS = 100;
/** Höchstens so oft "zuletzt bearbeitet" an der Seite aktualisieren, während jemand tippt */
const TOUCH_INTERVAL = 30_000;

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
  private touched = new Map<string, number>();

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
    const { data, error } = await this.db.from("note_docs").select("content").eq("page_id", id).maybeSingle();
    if (error) throw error;
    return (data?.content as Blocks | undefined) ?? [];
  }

  async getDoc(id: string): Promise<DocState> {
    const [doc, steps] = await Promise.all([
      this.db.from("note_docs").select("content, ydoc").eq("page_id", id).maybeSingle(),
      this.db.from("note_doc_updates").select("id, data").eq("page_id", id).order("id"),
    ]);
    if (doc.error) throw doc.error;
    if (steps.error) throw steps.error;
    const rows = (steps.data ?? []) as { id: number; data: string }[];
    const stored = (doc.data?.ydoc as string | null | undefined) ?? null;
    const parts = [...(stored ? [stored] : []), ...rows.map((r) => r.data)];
    return {
      content: (doc.data?.content as Blocks | undefined) ?? [],
      ydoc: parts.length > 1 ? toBase64(mergeUpdates(parts.map(fromBase64))) : (parts[0] ?? null),
      updateIds: rows.map((r) => r.id),
    };
  }

  async appendDocUpdate(pageId: string, data: string): Promise<number | null> {
    const { data: row, error } = await this.db.from("note_doc_updates").insert({ page_id: pageId, data }).select("id").single();
    if (error) throw error;
    void this.touch(pageId);
    return (row?.id as number | undefined) ?? null;
  }

  async pullDocUpdates(pageId: string, afterId: number): Promise<{ id: number; data: string }[]> {
    const { data, error } = await this.db
      .from("note_doc_updates")
      .select("id, data")
      .eq("page_id", pageId)
      .gt("id", afterId)
      .order("id")
      .limit(500);
    if (error) throw error;
    return (data ?? []) as { id: number; data: string }[];
  }

  async compactDoc(pageId: string, build: (stored: string | null) => { ydoc: string; content: Blocks }, includedIds: number[]): Promise<Blocks> {
    // Optimistisch: nur schreiben, wenn rev unverändert ist – sonst neu lesen, einmischen, nochmal
    for (let attempt = 0; attempt < 5; attempt++) {
      const { data: cur, error } = await this.db.from("note_docs").select("ydoc, rev").eq("page_id", pageId).maybeSingle();
      if (error) throw error;
      const { ydoc, content } = build((cur?.ydoc as string | null | undefined) ?? null);
      const fields = { ydoc, content, plain: plainText(content) };
      if (!cur) {
        const { error: e } = await this.db.from("note_docs").insert({ page_id: pageId, ...fields, rev: 1 });
        if (e?.code === "23505") continue;
        if (e) throw e;
      } else {
        const { data: done, error: e } = await this.db
          .from("note_docs")
          .update({ ...fields, rev: (cur.rev as number) + 1 })
          .eq("page_id", pageId)
          .eq("rev", cur.rev)
          .select("page_id");
        if (e) throw e;
        if (!done?.length) continue;
      }
      for (let i = 0; i < includedIds.length; i += 500) {
        await this.db.from("note_doc_updates").delete().in("id", includedIds.slice(i, i + 500));
      }
      return content;
    }
    throw new Error("Speichern kollidierte mehrmals mit anderen – wird gleich erneut versucht.");
  }

  /** "Zuletzt bearbeitet" an der Seite setzen (gedrosselt; die Seite wird live an alle verteilt) */
  private async touch(pageId: string, force = false) {
    const now = Date.now();
    if (!force && now - (this.touched.get(pageId) ?? 0) < TOUCH_INTERVAL) return;
    this.touched.set(pageId, now);
    const { error } = await this.db.from("note_pages").update({ updated_by: await this.uid() }).eq("id", pageId);
    if (error) this.touched.delete(pageId);
  }

  collab(pageId: string, onMessage: (m: CollabMessage) => void) {
    // Privater Kanal: Zugriff prüft die Datenbank (Policy auf realtime.messages)
    const channel = this.db.channel(`note:${pageId}`, { config: { private: true, broadcast: { self: false } } });
    channel.on("broadcast", { event: "y" }, ({ payload }) => onMessage(payload as CollabMessage));
    let closed = false;
    void this.db.realtime.setAuth().then(() => !closed && channel.subscribe());
    return {
      send: (message: CollabMessage) => {
        if (!closed) void channel.send({ type: "broadcast", event: "y", payload: message });
      },
      close: () => {
        closed = true;
        void this.db.removeChannel(channel);
      },
    };
  }

  async listVersions(pageId: string): Promise<Version[]> {
    const { data, error } = await this.db
      .from("note_versions")
      .select("id, page_id, created_at, created_by, title")
      .eq("page_id", pageId)
      .order("created_at", { ascending: false })
      .limit(MAX_VERSIONS);
    if (error) throw error;
    return (data ?? []).map((v) => ({ id: v.id, pageId: v.page_id, createdAt: v.created_at, createdBy: v.created_by, title: v.title ?? "" }));
  }

  async getVersion(id: string): Promise<Version | null> {
    const { data, error } = await this.db.from("note_versions").select("id, page_id, created_at, created_by, title, content").eq("id", id).maybeSingle();
    if (error) throw error;
    if (!data) return null;
    return { id: data.id, pageId: data.page_id, createdAt: data.created_at, createdBy: data.created_by, title: data.title ?? "", content: (data.content as Blocks) ?? [] };
  }

  async saveVersion(v: { pageId: string; title: string; content: Blocks }): Promise<void> {
    const { error } = await this.db.from("note_versions").insert({ page_id: v.pageId, title: v.title, content: v.content });
    if (error) throw error;
    // Ältere Stände über dem Limit entfernen
    const { data } = await this.db
      .from("note_versions")
      .select("id")
      .eq("page_id", v.pageId)
      .order("created_at", { ascending: false })
      .range(MAX_VERSIONS, MAX_VERSIONS + 50);
    if (data?.length) await this.db.from("note_versions").delete().in("id", data.map((r) => r.id as string));
  }

  async create(page: NewPage): Promise<void> {
    const { createdAt: _c, updatedAt: _u, createdBy: _cb, updatedBy: _ub, content, plain, ...rest } = page;
    const { error } = await this.db.from("note_pages").insert({ id: page.id, ...toRow(rest) });
    if (error) throw error;
    // Inhalts-Datensatz legt ein Trigger an; nur befüllen, wenn es schon Inhalt gibt (Vorlagen, Kopien, Import)
    if (content.length) {
      const { error: e } = await this.db.from("note_docs").upsert({ page_id: page.id, content, plain });
      if (e) throw e;
    }
  }

  async update(id: string, patch: PagePatch): Promise<void> {
    const { content, plain, ydoc, ...metaPatch } = patch;
    const row = toRow(metaPatch);
    if (Object.keys(row).length) {
      const { error } = await this.db.from("note_pages").update(row).eq("id", id);
      if (error) throw error;
    }
    if (content === undefined && plain === undefined && ydoc === undefined) return;
    const doc: Record<string, unknown> = { page_id: id };
    if (content !== undefined) doc.content = content;
    if (plain !== undefined) doc.plain = plain;
    if (ydoc !== undefined) doc.ydoc = ydoc;
    const { error } = await this.db.from("note_docs").upsert(doc);
    if (error) throw error;
    // Live-Stand verworfen (z. B. Version ohne offenen Editor wiederhergestellt): alte Schritte gehören nicht mehr dazu
    if (ydoc === null) await this.db.from("note_doc_updates").delete().eq("page_id", id);
    if (!Object.keys(row).length) await this.touch(id, true);
  }

  async remove(ids: string[]): Promise<void> {
    if (!ids.length) return;
    const { error } = await this.db.from("note_pages").delete().in("id", ids);
    if (error) throw error;
  }

  async search(query: string): Promise<string[]> {
    const q = query.replace(/[%_,()]/g, " ").trim();
    if (!q) return [];
    const { data, error } = await this.db.from("note_docs").select("page_id").ilike("plain", `%${q}%`).limit(50);
    if (error) throw error;
    return (data ?? []).map((r) => r.page_id as string);
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

  async upload(file: File, pageId: string): Promise<string> {
    // Ablage pro Seite: wer die Seite sehen darf, darf die Datei sehen (Policy in der Datenbank)
    const clean = file.name.normalize("NFKD").replace(/[^\w.-]+/g, "_").slice(-80) || "datei";
    const path = `${pageId}/${crypto.randomUUID()}-${clean}`;
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
        onEvent({ type: "upsert", page: toMeta(payload.new as DbRow) });
      })
      .subscribe();
    return () => {
      if (channel) void this.db.removeChannel(channel);
      channel = undefined;
    };
  }
}
