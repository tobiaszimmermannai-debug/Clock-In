// Supabase-Speicher: dieselbe Datenbank wie Clock-In
// note_pages (Metadaten, live an alle) · note_docs (Inhalt + Yjs-Stand) · note_doc_updates (Änderungsschritte)
// note_favorites · note_versions · Bucket "notes" (Dateien unter <Seiten-ID>/…)
import type { RealtimeChannel, SupabaseClient } from "@supabase/supabase-js";
import { mergeUpdates } from "yjs";
import type { Access, BlitziProfile, Blocks, CollabMessage, Completion, DocState, Member, NewPage, NotesStore, PageMeta, PagePatch, ShiftReport, StoreEvent, Studio, Version } from "../types";
import { fromBase64, plainText, toBase64 } from "../util";
import { colorFor, type DbRow, memberFromUser, META_COLUMNS, toMeta, type UserRow } from "./rows";

const MAX_VERSIONS = 100;
/** Höchstens so oft "zuletzt bearbeitet" an der Seite aktualisieren, während jemand tippt */
const TOUCH_INTERVAL = 30_000;

const FILE_PREFIX = "sb-notes://";

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
    deletedAt: "deleted_at",
    deletedBy: "deleted_by",
  };
  const row: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(p)) if (k in map && v !== undefined) row[map[k]] = v;
  return row;
}

const toProfile = (r: { user_id: string; nickname: string | null; prestige: number; items: string[] | null; reset_day: string | null }): BlitziProfile => ({
  userId: r.user_id,
  nickname: r.nickname,
  prestige: r.prestige ?? 0,
  items: r.items ?? [],
  resetDay: r.reset_day ? String(r.reset_day).slice(0, 10) : null,
});

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
    const { data } = await this.db.from("users").select("first_name, last_name, role").eq("auth_user_id", id).maybeSingle();
    if (!data) {
      // Studio-PC: Gerätekonto statt Person
      const access = await this.access();
      if (access.studio) return { id, name: access.studioName || "Studio-PC", color: "gray", device: true };
    }
    const name = data ? `${data.first_name ?? ""} ${data.last_name ?? ""}`.trim() : "Ich";
    return { id, name: name || "Ich", color: colorFor(id), role: (data?.role as string | undefined) ?? undefined };
  }

  private accessCache?: Promise<Access>;

  access(): Promise<Access> {
    this.accessCache ??= (async () => {
      const { data, error } = await this.db.rpc("note_access");
      // Ältere Datenbank ohne die Funktion: keine Sonderrechte
      if (error || !data) return { oversee: false, admin: false, studio: false };
      const a = data as { oversee?: boolean; admin?: boolean; studio?: boolean; studio_name?: string | null; studio_location?: string | null; locked?: boolean };
      return {
        oversee: Boolean(a.oversee),
        admin: Boolean(a.admin),
        studio: Boolean(a.studio),
        studioName: a.studio_name ?? undefined,
        studioLocationId: a.studio_location ?? null,
        locked: Boolean(a.locked),
      };
    })();
    return this.accessCache;
  }

  async locations(): Promise<Studio[]> {
    const { data, error } = await this.db.from("locations").select("id, name").eq("is_active", true).order("name");
    if (error) return [];
    return (data ?? []) as Studio[];
  }

  async completions(sinceIso: string): Promise<Completion[]> {
    // Seitenweise: PostgREST liefert höchstens 1000 Zeilen je Abfrage – sonst fehlten die neuesten
    const out: Completion[] = [];
    for (let from = 0; from < 50_000; from += 1000) {
      const { data, error } = await this.db
        .from("note_task_events")
        .select("page_id, user_id, points, done_at")
        .gte("done_at", sinceIso)
        .order("done_at")
        .order("id")
        .range(from, from + 999);
      if (error) throw error;
      out.push(...(data ?? []).map((r) => ({ pageId: r.page_id, userId: r.user_id, points: r.points, doneAt: r.done_at })));
      if (!data || data.length < 1000) break;
    }
    // Feierabend-Punkte (Ausstempel-Statistik abgegeben) – ältere Datenbank ohne Funktion: keine
    const bonus = await this.db.rpc("note_bonus_points", { p_since: sinceIso });
    if (!bonus.error) {
      for (const r of (bonus.data ?? []) as { user_id: string; done_at: string; ref: string }[]) {
        out.push({ pageId: `feierabend:${r.ref}`, userId: r.user_id, points: 1, doneAt: r.done_at, bonus: true });
      }
    }
    return out;
  }

  async blitziProfiles(): Promise<BlitziProfile[]> {
    const { data, error } = await this.db.from("blitzi_profiles").select("user_id, nickname, prestige, items, reset_day");
    if (error) return [];
    return ((data ?? []) as { user_id: string; nickname: string | null; prestige: number; items: string[] | null; reset_day: string | null }[]).map(toProfile);
  }

  async prestige(userId: string, item: string, nickname?: string): Promise<BlitziProfile> {
    const { data, error } = await this.db.rpc("blitzi_prestige", { p_user: userId, p_item: item, p_nickname: nickname ?? null });
    if (error) throw new Error(error.message);
    return toProfile(data as { user_id: string; nickname: string | null; prestige: number; items: string[] | null; reset_day: string | null });
  }

  async hereToday(): Promise<Record<string, string>> {
    const { data, error } = await this.db.rpc("note_here_today");
    if (error) return {};
    const out: Record<string, string> = {};
    for (const r of (data ?? []) as { user_id: string; location_id: string }[]) out[r.user_id] = r.location_id;
    return out;
  }

  async shiftReports(sinceIso?: string): Promise<ShiftReport[]> {
    const out: ShiftReport[] = [];
    for (let from = 0; from < 100_000; from += 1000) {
      let q = this.db
        .from("shift_reports")
        .select("*, user:users!shift_reports_user_id_fkey(first_name, last_name, auth_user_id, home_location_id)")
        .order("created_at")
        .order("id")
        .range(from, from + 999);
      if (sinceIso) q = q.gte("created_at", sinceIso);
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      for (const r of (data ?? []) as Record<string, unknown>[]) {
        const u = r.user as { first_name: string; last_name: string; auth_user_id: string | null; home_location_id: string | null } | null;
        const values: Record<string, number> = {};
        for (const [k, v] of Object.entries(r)) if (typeof v === "number") values[k] = v;
        out.push({
          id: String(r.id),
          userId: String(r.user_id),
          authUserId: u?.auth_user_id ?? null,
          name: u ? `${u.first_name} ${u.last_name}`.trim() : "?",
          studioId: u?.home_location_id ?? null,
          createdAt: String(r.created_at),
          values,
        });
      }
      if (!data || data.length < 1000) break;
    }
    return out;
  }

  async setCompletion(pageId: string, userIds: string[], points: number, done: boolean): Promise<void> {
    if (!done) {
      const { error } = await this.db.from("note_task_events").delete().eq("page_id", pageId);
      if (error) throw error;
      return;
    }
    if (!userIds.length) return;
    const { error } = await this.db
      .from("note_task_events")
      .upsert(userIds.map((user_id) => ({ page_id: pageId, user_id, points })), { onConflict: "page_id,user_id", ignoreDuplicates: true });
    if (error) throw error;
  }

  async dayPlan(day: string): Promise<{ planned: string[]; absent: string[] } | null> {
    const { data, error } = await this.db.rpc("note_day_plan", { p_day: day });
    if (error) return null; // ältere Datenbank
    const rows = (data ?? []) as { user_id: string; planned: boolean; absent: boolean }[];
    return { planned: rows.filter((r) => r.planned).map((r) => r.user_id), absent: rows.filter((r) => r.absent).map((r) => r.user_id) };
  }

  async unlocked(): Promise<string[] | null> {
    const { data, error } = await this.db.rpc("note_unlocked");
    if (error) return null; // ältere Datenbank: keine Sperre
    return ((data ?? []) as { user_id: string; unlocked: boolean }[]).filter((r) => r.unlocked).map((r) => r.user_id);
  }

  async decideFocus(pageId: string, userId: string, ok: boolean): Promise<string> {
    const { data, error } = await this.db.rpc("note_focus_decide", { p_page: pageId, p_user: userId, p_ok: ok });
    if (error) throw error;
    return String(data);
  }

  async workDays(sinceIso: string): Promise<Record<string, string[]> | null> {
    const since = sinceIso.slice(0, 10);
    const team = await this.db.rpc("note_team_work_days", { p_since: since });
    if (!team.error) {
      const out: Record<string, string[]> = {};
      for (const r of (team.data ?? []) as { user_id: string; day: string }[]) (out[r.user_id] ??= []).push(String(r.day).slice(0, 10));
      return out;
    }
    // Ältere Datenbank: nur die eigenen Tage
    const { data, error } = await this.db.rpc("note_work_days", { p_since: since });
    if (error) return null;
    return { [await this.uid()]: ((data ?? []) as string[]).map((d) => String(d).slice(0, 10)) };
  }

  async members(): Promise<Member[]> {
    const { data, error } = await this.db
      .from("users")
      .select("auth_user_id, first_name, last_name, role, home_location_id")
      .eq("is_active", true)
      .not("auth_user_id", "is", null)
      .order("first_name");
    if (error) throw error;
    return (data ?? []).map((u) => memberFromUser(u as UserRow));
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
    const { error } = await this.db.rpc("note_soft_delete", { p_ids: ids });
    if (error) throw error;
  }

  async purge(ids: string[]): Promise<void> {
    if (!ids.length) return;
    const { error } = await this.db.from("note_pages").delete().in("id", ids);
    if (error) throw error;
  }

  async restoreDeleted(ids: string[]): Promise<void> {
    if (!ids.length) return;
    const { error } = await this.db.from("note_pages").update({ deleted_at: null, deleted_by: null }).in("id", ids);
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
    let closed = false;
    let channel: RealtimeChannel | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const open = async () => {
      // Erst die Anmeldung an die Live-Verbindung geben – sonst gilt sie als „nicht angemeldet“ und
      // die Zugriffsregeln lassen keine einzige Änderung durch
      await this.db.realtime.setAuth().catch(() => undefined);
      if (closed) return;
      channel = this.db
        .channel(`note_pages_${Math.random().toString(36).slice(2)}`)
        .on("postgres_changes", { event: "*", schema: "public", table: "note_pages" }, (payload) => {
          if (payload.eventType === "DELETE") {
            const id = (payload.old as { id?: string }).id;
            if (id) onEvent({ type: "delete", id });
            return;
          }
          onEvent({ type: "upsert", page: toMeta(payload.new as DbRow) });
        })
        .subscribe((status) => {
          if (closed) return;
          // Verbunden (auch nach einem Abbruch): einmal abgleichen, falls zwischendurch etwas verpasst wurde
          if (status === "SUBSCRIBED") onEvent({ type: "resync" });
          if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
            const old = channel;
            channel = undefined;
            if (old) void this.db.removeChannel(old);
            clearTimeout(retry);
            retry = setTimeout(() => void open(), 5_000);
          }
        });
    };
    void open();
    return () => {
      closed = true;
      clearTimeout(retry);
      if (channel) void this.db.removeChannel(channel);
      channel = undefined;
    };
  }
}
