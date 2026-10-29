// Zentraler Zustand: Seitenliste im Speicher, gebündeltes Speichern, Navigation, Live-Updates
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { taskSchema, welcomeContent } from "./templates";
import type { Blocks, DbSchema, Member, NewPage, NotesStore, PageKind, PageMeta, PagePatch, PropValue, Space, Version } from "./types";
import { between, bySort, descendants, plainText, storageGet, storageSet, uid } from "./util";

/** Schnittstelle zum gerade offenen Editor einer Seite (für Live-Updates und Unterseiten-Links) */
export type EditorHandle = {
  appendPageLink(pageId: string): void;
  /** Inhalt ersetzen (Version wiederherstellen) – geht über Yjs an alle Mitbearbeitenden */
  replaceContent(blocks: Blocks): void;
  /** Gespeicherten Yjs-Stand eines anderen Geräts einmischen */
  applyRemote(ydoc: string): void;
};

/** Wer gerade auf einer Seite ist (aus den Live-Cursorn) */
export type Presence = { clientId: number; name: string; color: string };

export type Toast = { id: number; text: string; action?: { label: string; run: () => void } };

export type CreateOptions = {
  /** Vorab vergebene ID (z. B. wenn der Link-Block schon eingefügt ist) */
  id?: string;
  parentId?: string | null;
  space?: Space;
  kind?: PageKind;
  title?: string;
  icon?: string | null;
  props?: Record<string, PropValue>;
  content?: Blocks;
  schema?: DbSchema | null;
  /** Position zwischen Nachbarn; Standard: ans Ende */
  position?: number;
  /** Link-Block in der Elternseite anhängen (wie beim Anlegen über die Seitenleiste) */
  linkInParent?: boolean;
};

type Ctx = {
  store: NotesStore;
  me: Member;
  members: Member[];
  pages: Map<string, PageMeta>;
  favorites: string[];
  recent: string[];
  current: string | null;
  peek: string | null;
  loaded: boolean;
  error?: string;
  navigate: (id: string | null) => void;
  openPeek: (id: string | null) => void;
  /** Lebende Kinder in Reihenfolge (ohne Papierkorb) */
  childrenOf: (parentId: string | null, space?: Space) => PageMeta[];
  isLive: (id: string) => boolean;
  createPage: (opts?: CreateOptions) => Promise<PageMeta>;
  updatePage: (id: string, patch: PagePatch, opts?: { delay?: number }) => void;
  saveContent: (id: string, blocks: Blocks) => void;
  /** Inhalt + Yjs-Stand speichern (Live-Editor) */
  saveDoc: (id: string, blocks: Blocks, ydoc: string) => void;
  loadDoc: (id: string) => Promise<{ content: Blocks; ydoc: string | null }>;
  /** Aktuellen Stand sofort als Version sichern */
  saveVersionNow: (id: string, blocks: Blocks) => Promise<void>;
  /** Version wiederherstellen (vorher wird der aktuelle Stand gesichert) */
  restoreVersion: (id: string, version: Version) => Promise<void>;
  presence: Record<string, Presence[]>;
  setPresence: (id: string, peers: Presence[]) => void;
  commentsOpen: boolean;
  setCommentsOpen: (open: boolean) => void;
  loadContent: (id: string) => Promise<Blocks>;
  archive: (id: string) => void;
  restore: (id: string) => void;
  destroy: (id: string) => Promise<void>;
  duplicate: (id: string) => Promise<PageMeta | undefined>;
  move: (id: string, target: { parentId: string | null; space?: Space; position?: number }) => void;
  toggleFavorite: (id: string) => void;
  registerEditor: (id: string, handle: EditorHandle | null) => void;
  toast: (text: string, action?: Toast["action"]) => void;
  toasts: Toast[];
  dismissToast: (id: number) => void;
  flush: () => Promise<void>;
};

const NotesContext = createContext<Ctx | null>(null);

export function useNotes(): Ctx {
  const ctx = useContext(NotesContext);
  if (!ctx) throw new Error("useNotes außerhalb von <NotesProvider>");
  return ctx;
}

/** Optional (für Blöcke, die auch im Export gerendert werden) */
export const useNotesOptional = () => useContext(NotesContext);

const CONTENT_DELAY = 700;
const META_DELAY = 400;
const VERSION_GAP = 10 * 60 * 1000;

export function NotesProvider(props: {
  store: NotesStore;
  routing: "hash" | "memory";
  children: ReactNode;
}) {
  const { store, routing } = props;
  const [me, setMe] = useState<Member>({ id: "", name: "", color: "blue" });
  const [members, setMembers] = useState<Member[]>([]);
  const [pages, setPages] = useState<Map<string, PageMeta>>(new Map());
  const [favorites, setFavorites] = useState<string[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string>();
  const [current, setCurrent] = useState<string | null>(null);
  const [peek, setPeek] = useState<string | null>(null);
  const [recent, setRecent] = useState<string[]>([]);
  const [toasts, setToasts] = useState<Toast[]>([]);

  const pagesRef = useRef(pages);
  pagesRef.current = pages;
  const meRef = useRef(me);
  meRef.current = me;

  // Gebündelte Schreibvorgänge pro Seite: Änderungen sammeln, nacheinander senden
  const pending = useRef(new Map<string, PagePatch>());
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const chains = useRef(new Map<string, Promise<void>>());
  const lastSaved = useRef(new Map<string, string>());
  const editors = useRef(new Map<string, EditorHandle>());
  const versionAt = useRef(new Map<string, number>());
  const [presence, setPresenceState] = useState<Record<string, Presence[]>>({});
  const [commentsOpen, setCommentsOpenState] = useState(() => storageGet<boolean>("aun-comments", false));
  const toastSeq = useRef(0);

  const toast = useCallback((text: string, action?: Toast["action"]) => {
    const id = ++toastSeq.current;
    setToasts((t) => [...t.slice(-2), { id, text, action }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), action ? 7000 : 4000);
  }, []);
  const dismissToast = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);

  const enqueue = useCallback((id: string, job: () => Promise<void>) => {
    const prev = chains.current.get(id) ?? Promise.resolve();
    const next = prev.then(job, job);
    chains.current.set(id, next);
    void next.finally(() => {
      if (chains.current.get(id) === next) chains.current.delete(id);
    });
    return next;
  }, []);

  // Automatischer Versionsverlauf: höchstens alle 10 Minuten den Stand vor einer neuen Bearbeitung sichern
  const snapshot = useCallback(
    async (id: string, prevJson: string) => {
      const now = Date.now();
      let last = versionAt.current.get(id);
      if (last === undefined) {
        versionAt.current.set(id, now); // Sperre, solange die letzte Version abgefragt wird
        const list = await store.listVersions(id).catch(() => []);
        last = list[0] ? new Date(list[0].createdAt).getTime() : 0;
        versionAt.current.set(id, last);
      }
      if (now - last < VERSION_GAP) return;
      versionAt.current.set(id, now);
      const title = pagesRef.current.get(id)?.title ?? "";
      await store.saveVersion({ pageId: id, title, content: JSON.parse(prevJson) as Blocks }).catch(() => versionAt.current.delete(id));
    },
    [store],
  );

  const flushOne = useCallback(
    (id: string) => {
      const t = timers.current.get(id);
      if (t) clearTimeout(t);
      timers.current.delete(id);
      const patch = pending.current.get(id);
      if (!patch) return chains.current.get(id) ?? Promise.resolve();
      pending.current.delete(id);
      if (patch.content) {
        patch.plain = plainText(patch.content);
        const json = JSON.stringify(patch.content);
        const prev = lastSaved.current.get(id);
        lastSaved.current.set(id, json);
        if (prev && prev !== json) void snapshot(id, prev);
      }
      return enqueue(id, async () => {
        try {
          await store.update(id, patch);
        } catch (e) {
          toast(`Speichern fehlgeschlagen: ${(e as Error).message}`, {
            label: "Erneut versuchen",
            run: () => {
              pending.current.set(id, { ...patch, ...pending.current.get(id) });
              void flushOne(id);
            },
          });
        }
      });
    },
    [enqueue, snapshot, store, toast],
  );

  const flush = useCallback(async () => {
    await Promise.all([...pending.current.keys()].map((id) => flushOne(id)));
    await Promise.all([...chains.current.values()]);
  }, [flushOne]);

  const schedule = useCallback(
    (id: string, patch: PagePatch, delay: number) => {
      pending.current.set(id, { ...pending.current.get(id), ...patch });
      const t = timers.current.get(id);
      if (t) clearTimeout(t);
      if (delay <= 0) return void flushOne(id);
      timers.current.set(id, setTimeout(() => void flushOne(id), delay));
    },
    [flushOne],
  );

  // Vor dem Schließen/Wechseln des Tabs alles speichern
  useEffect(() => {
    const onHide = () => void flush();
    const onVisibility = () => document.visibilityState === "hidden" && onHide();
    window.addEventListener("pagehide", onHide);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("pagehide", onHide);
      document.removeEventListener("visibilitychange", onVisibility);
      void flush();
    };
  }, [flush]);

  const setPage = useCallback((page: PageMeta) => {
    setPages((m) => new Map(m).set(page.id, page));
  }, []);

  const patchLocal = useCallback((id: string, patch: Partial<PageMeta>) => {
    setPages((m) => {
      const p = m.get(id);
      if (!p) return m;
      return new Map(m).set(id, { ...p, ...patch, updatedAt: new Date().toISOString(), updatedBy: meRef.current.id });
    });
  }, []);

  // ---------------- Laden + Live-Updates ----------------
  const recentKey = me.id ? `aun-recent-${store.kind}-${me.id}` : "";

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [who, list, favs] = await Promise.all([store.me(), store.listPages(), store.favorites()]);
        const people = await store.members().catch(() => [who]);
        if (cancelled) return;
        setMe(who);
        meRef.current = who;
        setMembers(people.some((m) => m.id === who.id) ? people : [who, ...people]);
        const map = new Map(list.map((p) => [p.id, p]));
        setPages(map);
        pagesRef.current = map;
        setFavorites(favs);
        setRecent(storageGet<string[]>(`aun-recent-${store.kind}-${who.id}`, []));
        // Erster Start: Willkommensseite und eigene Aufgabenliste anlegen
        if (!list.some((p) => p.ownerId === who.id && p.space === "private")) await seed(who);
        setLoaded(true);
      } catch (e) {
        if (!cancelled) setError((e as Error).message || "Laden fehlgeschlagen.");
      }
    })();
    return () => {
      cancelled = true;
    };
    // Nur beim Wechsel des Speichers neu laden
  }, [store]);

  useEffect(() => {
    if (!loaded) return;
    return store.subscribe((ev) => {
      if (ev.type === "delete") {
        setPages((m) => {
          if (!m.has(ev.id)) return m;
          const next = new Map(m);
          next.delete(ev.id);
          return next;
        });
        return;
      }
      const id = ev.page.id;
      // Live-Inhalt immer einmischen (Yjs führt zusammen, nichts wird überschrieben)
      if (ev.ydoc) editors.current.get(id)?.applyRemote(ev.ydoc);
      if (ev.content) lastSaved.current.set(id, JSON.stringify(ev.content));
      // Eigene, noch offene Änderungen an Titel/Eigenschaften haben Vorrang
      if (pending.current.has(id) || chains.current.has(id)) return;
      setPage(ev.page);
    });
  }, [loaded, setPage, store]);

  // ---------------- Navigation ----------------
  // Eingebettet: zuletzt geöffnete Seite pro Nutzer merken (Geräte werden geteilt)
  const lastKey = me.id ? `aun-last-page-${store.kind}-${me.id}` : "";
  const lastKeyRef = useRef(lastKey);
  lastKeyRef.current = lastKey;

  useEffect(() => {
    if (routing !== "hash") {
      if (lastKey) setCurrent(storageGet<string | null>(lastKey, null));
      return;
    }
    const read = () => {
      const m = location.hash.match(/^#\/p\/([\w-]+)/);
      setCurrent(m ? m[1] : null);
      setPeek(null);
    };
    read();
    window.addEventListener("hashchange", read);
    return () => window.removeEventListener("hashchange", read);
  }, [routing, lastKey]);

  const navigate = useCallback(
    (id: string | null) => {
      setPeek(null);
      if (routing === "hash") {
        const target = id ? `#/p/${id}` : "#/";
        if (location.hash !== target) location.hash = target;
        else setCurrent(id);
      } else {
        setCurrent(id);
        if (lastKeyRef.current) storageSet(lastKeyRef.current, id);
      }
    },
    [routing],
  );

  useEffect(() => {
    if (!current || !recentKey) return;
    setRecent((r) => {
      const next = [current, ...r.filter((x) => x !== current)].slice(0, 20);
      storageSet(recentKey, next);
      return next;
    });
  }, [current, recentKey]);

  // ---------------- Abfragen ----------------
  const isLive = useCallback((id: string) => {
    const seen = new Set<string>();
    let p = pagesRef.current.get(id);
    while (p) {
      if (p.archivedAt || seen.has(p.id)) return false;
      seen.add(p.id);
      if (!p.parentId) return true;
      p = pagesRef.current.get(p.parentId);
    }
    return false;
  }, []);

  const childrenOf = useCallback(
    (parentId: string | null, space?: Space) =>
      [...pages.values()]
        .filter((p) => p.parentId === parentId && !p.archivedAt && (parentId !== null || p.space === space))
        .sort(bySort),
    [pages],
  );

  // ---------------- Schreiben ----------------
  const nextPosition = (parentId: string | null, space: Space) => {
    const siblings = [...pagesRef.current.values()].filter((p) => p.parentId === parentId && (parentId || p.space === space));
    return siblings.length ? Math.max(...siblings.map((p) => p.position)) + 1 : 1;
  };

  const createPage = useCallback(
    async (opts: CreateOptions = {}): Promise<PageMeta> => {
      const parent = opts.parentId ? pagesRef.current.get(opts.parentId) : undefined;
      const space: Space = parent?.space ?? opts.space ?? "private";
      const now = new Date().toISOString();
      const who = meRef.current;
      const page: NewPage = {
        id: opts.id ?? uid(),
        parentId: parent?.id ?? null,
        space,
        ownerId: space === "private" && parent ? parent.ownerId : who.id,
        kind: opts.kind ?? "page",
        title: opts.title ?? "",
        icon: opts.icon ?? null,
        cover: null,
        props: opts.props ?? {},
        schema: opts.kind === "database" ? (opts.schema ?? null) : null,
        options: {},
        position: opts.position ?? nextPosition(parent?.id ?? null, space),
        archivedAt: null,
        createdAt: now,
        createdBy: who.id,
        updatedAt: now,
        updatedBy: who.id,
        content: opts.content ?? [],
        plain: plainText(opts.content ?? []),
      };
      const { content: _content, plain: _plain, ...meta } = page;
      setPage(meta);
      pagesRef.current = new Map(pagesRef.current).set(meta.id, meta);
      lastSaved.current.set(page.id, JSON.stringify(page.content));
      await enqueue(page.id, async () => {
        try {
          await store.create(page);
        } catch (e) {
          setPages((m) => {
            const next = new Map(m);
            next.delete(page.id);
            return next;
          });
          toast(`Anlegen fehlgeschlagen: ${(e as Error).message}`);
          throw e;
        }
      });
      // Ist die Elternseite gerade offen, erscheint der Link als Block; sonst listet sie die Unterseite unten auf
      if (opts.linkInParent && parent && parent.kind === "page") editors.current.get(parent.id)?.appendPageLink(page.id);
      return meta;
    },
    [enqueue, flushOne, schedule, setPage, store, toast],
  );

  async function seed(who: Member) {
    meRef.current = who;
    const welcome = await createPageRaw({ title: "Erste Schritte", icon: "👋", content: welcomeContent(), position: 1 }, who);
    await createPageRaw({ title: "Meine Aufgaben", icon: "✅", kind: "database", schema: taskSchema(), position: 2 }, who);
    if (routing === "hash" ? !location.hash.startsWith("#/p/") : !storageGet(`aun-last-page-${store.kind}-${who.id}`, null)) navigate(welcome.id);
  }

  // Für den ersten Start (vor dem Rendern verfügbar)
  async function createPageRaw(opts: CreateOptions, who: Member) {
    const now = new Date().toISOString();
    const page: NewPage = {
      id: uid(),
      parentId: null,
      space: "private",
      ownerId: who.id,
      kind: opts.kind ?? "page",
      title: opts.title ?? "",
      icon: opts.icon ?? null,
      cover: null,
      props: {},
      schema: opts.schema ?? null,
      options: {},
      position: opts.position ?? 1,
      archivedAt: null,
      createdAt: now,
      createdBy: who.id,
      updatedAt: now,
      updatedBy: who.id,
      content: opts.content ?? [],
      plain: plainText(opts.content ?? []),
    };
    await store.create(page);
    const { content: _content, plain: _plain, ...meta } = page;
    setPage(meta);
    return meta;
  }

  const updatePage = useCallback(
    (id: string, patch: PagePatch, opts: { delay?: number } = {}) => {
      const { content: _content, plain: _plain, ...meta } = patch;
      patchLocal(id, meta);
      schedule(id, patch, opts.delay ?? META_DELAY);
    },
    [patchLocal, schedule],
  );

  const saveContent = useCallback(
    (id: string, blocks: Blocks) => {
      patchLocal(id, {});
      schedule(id, { content: blocks }, CONTENT_DELAY);
    },
    [patchLocal, schedule],
  );

  const saveDoc = useCallback(
    (id: string, blocks: Blocks, ydoc: string) => {
      patchLocal(id, {});
      schedule(id, { content: blocks, ydoc }, 0);
    },
    [patchLocal, schedule],
  );

  const loadDoc = useCallback(
    async (id: string) => {
      await flushOne(id);
      const doc = await store.getDoc(id);
      lastSaved.current.set(id, JSON.stringify(doc.content));
      return doc;
    },
    [flushOne, store],
  );

  const saveVersionNow = useCallback(
    async (id: string, blocks: Blocks) => {
      await store.saveVersion({ pageId: id, title: pagesRef.current.get(id)?.title ?? "", content: blocks });
      versionAt.current.set(id, Date.now());
    },
    [store],
  );

  const restoreVersion = useCallback(
    async (id: string, version: Version) => {
      const blocks = version.content ?? [];
      const current = lastSaved.current.get(id);
      if (current) await saveVersionNow(id, JSON.parse(current) as Blocks);
      const editor = editors.current.get(id);
      // Offener Editor: Änderung läuft über Yjs zu allen Mitbearbeitenden; sonst Inhalt neu aufbauen lassen
      if (editor) editor.replaceContent(blocks);
      else schedule(id, { content: blocks, ydoc: null }, 0);
      const page = pagesRef.current.get(id);
      if (page && version.title && version.title !== page.title) updatePage(id, { title: version.title }, { delay: 0 });
    },
    [saveVersionNow, schedule, updatePage],
  );

  const setPresence = useCallback((id: string, peers: Presence[]) => {
    setPresenceState((p) => {
      const cur = p[id] ?? [];
      if (cur.length === peers.length && cur.every((x, i) => x.clientId === peers[i].clientId && x.name === peers[i].name)) return p;
      return { ...p, [id]: peers };
    });
  }, []);

  const setCommentsOpen = useCallback((open: boolean) => {
    setCommentsOpenState(open);
    storageSet("aun-comments", open);
  }, []);

  const loadContent = useCallback(
    async (id: string) => {
      await flushOne(id);
      const blocks = await store.getContent(id);
      lastSaved.current.set(id, JSON.stringify(blocks));
      return blocks;
    },
    [flushOne, store],
  );

  const archive = useCallback(
    (id: string) => {
      const p = pagesRef.current.get(id);
      updatePage(id, { archivedAt: new Date().toISOString() }, { delay: 0 });
      if (current === id || (current && descendants(id, [...pagesRef.current.values()]).some((d) => d.id === current))) {
        navigate(p?.parentId && isLive(p.parentId) ? p.parentId : null);
      }
      if (peek === id) setPeek(null);
      toast(`„${p?.title || "Ohne Titel"}“ in den Papierkorb verschoben`, {
        label: "Rückgängig",
        run: () => updatePage(id, { archivedAt: null }, { delay: 0 }),
      });
    },
    [current, isLive, navigate, peek, toast, updatePage],
  );

  const restore = useCallback(
    (id: string) => {
      const p = pagesRef.current.get(id);
      const parentGone = p?.parentId && !isLive(p.parentId);
      updatePage(id, parentGone ? { archivedAt: null, parentId: null } : { archivedAt: null }, { delay: 0 });
    },
    [isLive, updatePage],
  );

  const destroy = useCallback(
    async (id: string) => {
      const ids = [id, ...descendants(id, [...pagesRef.current.values()]).map((d) => d.id)];
      for (const x of ids) {
        pending.current.delete(x);
        const t = timers.current.get(x);
        if (t) clearTimeout(t);
      }
      setPages((m) => {
        const next = new Map(m);
        ids.forEach((x) => next.delete(x));
        return next;
      });
      setFavorites((f) => f.filter((x) => !ids.includes(x)));
      try {
        await store.remove(ids);
      } catch (e) {
        toast(`Löschen fehlgeschlagen: ${(e as Error).message}`);
      }
    },
    [store, toast],
  );

  const move = useCallback(
    (id: string, target: { parentId: string | null; space?: Space; position?: number }) => {
      const all = [...pagesRef.current.values()];
      const page = pagesRef.current.get(id);
      if (!page) return;
      if (target.parentId && (target.parentId === id || descendants(id, all).some((d) => d.id === target.parentId))) return;
      const parent = target.parentId ? pagesRef.current.get(target.parentId) : undefined;
      const space = parent?.space ?? target.space ?? page.space;
      const ownerId = space === "private" ? (parent?.ownerId ?? meRef.current.id) : page.ownerId;
      const position = target.position ?? nextPosition(target.parentId, space);
      updatePage(id, { parentId: target.parentId, space, ownerId, position }, { delay: 0 });
      // Unterseiten folgen dem Bereich (Server macht dasselbe per Trigger)
      if (space !== page.space || ownerId !== page.ownerId) {
        for (const d of descendants(id, all)) patchLocal(d.id, { space, ownerId });
      }
    },
    [patchLocal, updatePage],
  );

  const duplicate = useCallback(
    async (id: string) => {
      const root = pagesRef.current.get(id);
      if (!root) return;
      await flush();
      const all = [...pagesRef.current.values()];
      const tree = [root, ...descendants(id, all).filter((d) => !d.archivedAt)];
      const ids = new Map(tree.map((p) => [p.id, uid()]));
      const remap = (blocks: Blocks): Blocks =>
        JSON.parse(JSON.stringify(blocks), (_k, v) => (typeof v === "string" && ids.has(v) ? ids.get(v) : v)) as Blocks;
      const now = new Date().toISOString();
      const siblings = all.filter((p) => p.parentId === root.parentId && (root.parentId || p.space === root.space)).sort(bySort);
      const after = siblings[siblings.findIndex((s) => s.id === id) + 1];
      let first: PageMeta | undefined;
      for (const p of tree) {
        const content = remap(await store.getContent(p.id));
        const copy: NewPage = {
          ...p,
          id: ids.get(p.id)!,
          parentId: p === root ? root.parentId : (ids.get(p.parentId!) ?? p.parentId),
          ownerId: p.space === "private" ? p.ownerId : meRef.current.id,
          title: p === root ? `${root.title || "Ohne Titel"} (Kopie)` : p.title,
          position: p === root ? between(root.position, after?.position) : p.position,
          createdAt: now,
          createdBy: meRef.current.id,
          updatedAt: now,
          updatedBy: meRef.current.id,
          content,
          plain: plainText(content),
        };
        await store.create(copy);
        const { content: _c, plain: _p, ...meta } = copy;
        setPage(meta);
        first ??= meta;
      }
      toast("Seite dupliziert");
      return first;
    },
    [flush, setPage, store, toast],
  );

  const toggleFavorite = useCallback(
    (id: string) => {
      const on = !favorites.includes(id);
      setFavorites((f) => (on ? [...f, id] : f.filter((x) => x !== id)));
      store.setFavorite(id, on).catch((e: Error) => toast(`Favorit konnte nicht gespeichert werden: ${e.message}`));
    },
    [favorites, store, toast],
  );

  const registerEditor = useCallback((id: string, handle: EditorHandle | null) => {
    if (handle) editors.current.set(id, handle);
    else editors.current.delete(id);
  }, []);

  const value = useMemo<Ctx>(
    () => ({
      store,
      me,
      members,
      pages,
      favorites,
      recent,
      current,
      peek,
      loaded,
      error,
      navigate,
      openPeek: setPeek,
      childrenOf,
      isLive,
      createPage,
      updatePage,
      saveContent,
      saveDoc,
      loadDoc,
      saveVersionNow,
      restoreVersion,
      presence,
      setPresence,
      commentsOpen,
      setCommentsOpen,
      loadContent,
      archive,
      restore,
      destroy,
      duplicate,
      move,
      toggleFavorite,
      registerEditor,
      toast,
      toasts,
      dismissToast,
      flush,
    }),
    [store, me, members, pages, favorites, recent, current, peek, loaded, error, navigate, childrenOf, isLive, createPage, updatePage, saveContent, saveDoc, loadDoc, saveVersionNow, restoreVersion, presence, setPresence, commentsOpen, setCommentsOpen, loadContent, archive, restore, destroy, duplicate, move, toggleFavorite, registerEditor, toast, toasts, dismissToast, flush],
  );

  return <NotesContext.Provider value={value}>{props.children}</NotesContext.Provider>;
}
