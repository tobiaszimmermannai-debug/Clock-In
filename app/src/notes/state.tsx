// Zentraler Zustand: Seitenliste im Speicher, gebündeltes Speichern, Navigation, Live-Updates
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { isDone } from "./database/logic";
import { FOCUS_KEY, focusTasks, reorderFocus, withFocus } from "./gamification/focus";
import { dailyStatus, type DayPlan, type DayStatus } from "./daily/status";
import { DONE_AT_KEY } from "./gamification/tasks";
import { everyWhileVisible } from "./visibility";
import { dueProp, MOVES_KEY, movesOf, needsPhoto, nextOccurrence, postponed, PROOF_KEY, proofOf } from "./gamification/recur";
import { blitziInfo, type BlitziInfo } from "./gamification/blitzi";
import { dayOf, daysFor, pointsLeftToday } from "./gamification/stats";
import { taskSchema, welcomeContent } from "./templates";
import type {
  Access,
  BlitziProfile,
  Blocks,
  Completion,
  DbSchema,
  DocState,
  Member,
  NewPage,
  NotesStore,
  PageKind,
  PageMeta,
  PagePatch,
  PropValue,
  Space,
  Studio,
  Version,
} from "./types";
import { between, bySort, descendants, plainText, storageGet, storageSet, today, uid } from "./util";

/** Schnittstelle zum gerade offenen Editor einer Seite (für Live-Updates und Unterseiten-Links) */
export type EditorHandle = {
  appendPageLink(pageId: string): void;
  /** Inhalt ersetzen (Version wiederherstellen) – geht über Yjs an alle Mitbearbeitenden */
  replaceContent(blocks: Blocks): void;
  /** Gespeicherten Yjs-Stand eines anderen Geräts einmischen */
  applyRemote(ydoc: string): void;
  /** Aktueller Inhalt (aktueller als der gespeicherte, der höchstens alle 30 s geschrieben wird) */
  content(): Blocks;
};

/** Wer gerade auf einer Seite ist (aus den Live-Cursorn) */
export type Presence = { clientId: number; name: string; color: string };

export type Toast = { id: number; text: string; action?: { label: string; run: () => void } };

/** Belohnung nach einer erledigten Aufgabe (bzw. vollem Akku, neuer Stufe) – mit dem Blitzi der handelnden Person */
export type Celebration = {
  id: number;
  points: number;
  goal: boolean;
  streak: number;
  name: string;
  /** Serie ist mit dieser Aufgabe gewachsen */
  grew: boolean;
  /** Blitzi der Person: Stufe vorher/nachher (levelUp = neue Stufe), Items, Spitzname */
  memberId: string;
  stage: number;
  levelUp: boolean;
  items: string[];
  nickname: string | null;
  prestige: number;
};

/** Erfolge werden so weit zurück geladen (Serie, Rangliste) */
const HISTORY_DAYS = 90;

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
  /** Nur anlegen, wenn es die ID noch nicht gibt (wiederkehrende Aufgaben; Doppel von anderen Geräten still ignorieren) */
  ifMissing?: boolean;
};

/** Abhaken wartet auf einen Fotonachweis */
export type PhotoRequest = { rowId: string; title: string; reason: "lead" | "moved"; props: Record<string, PropValue> };

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
  /** Live-Editor hat Inhalt und Stand gespeichert (für Versionen und "zuletzt bearbeitet") */
  onDocSaved: (id: string, blocks: Blocks) => void;
  loadDoc: (id: string) => Promise<DocState>;
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
  // ---- Rechte, Studio-PC ----
  access: Access;
  locations: Studio[];
  /** Wer gerade handelt: man selbst bzw. am Studio-PC die gewählte Person (null = noch niemand gewählt) */
  actor: Member | null;
  setActor: (id: string | null) => void;
  /** Gehört in die normale Ansicht (Team oder eigene Seite) – Fremdes nur in der Leitungsübersicht */
  inMyView: (p: PageMeta) => boolean;
  /** Gelöschtes wirklich löschen bzw. zurückholen (nur Leitung) */
  purge: (id: string) => Promise<void>;
  restoreDeleted: (id: string) => void;
  // ---- Erfolge ----
  completions: Completion[];
  /** Blitzi-Profile (Prestige, Items, Spitzname) je Person */
  profiles: Map<string, BlitziProfile>;
  /** Blitzi einer Person (Stufe seit dem letzten Prestige, Items, Spitzname) */
  blitzi: (memberId: string) => BlitziInfo;
  /** Stufe 30: Item wählen (beim ersten Mal mit Spitzname) */
  prestige: (memberId: string, item: string, nickname?: string) => Promise<void>;
  /** Arbeitstage je Person (für die Serie) */
  workDays: Record<string, string[]> | null;
  celebration: Celebration | null;
  dismissCelebration: () => void;
  /** Tagesfokus: Aufgabe für eine Person heute auf Rang 1–3 setzen (null = entfernen) */
  setFocus: (rowId: string, userId: string, rank: number | null) => void;
  /** Tagesstand (wer offen, wer abwesend, was fällig) – dieselbe Berechnung wie der Telegram-Reminder */
  dayStatus: DayStatus;
  /** Tagesaufgabe freigeben oder ablehnen (Leitung) */
  decideFocus: (pageId: string, userId: string, ok: boolean) => void;
  /** Wer gerade an seine Aufgaben darf (eingecheckt oder ohne Zeiterfassung); null = keine Sperre bekannt */
  unlocked: Set<string> | null;
  /** Fotonachweis fürs Abhaken: offene Anfrage und Abschluss (Datei hochladen oder abbrechen) */
  photoRequest: PhotoRequest | null;
  resolvePhoto: (file: File | null) => Promise<void>;
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

/** Leere Seite (nur ein leerer Absatz) – lohnt keine Version */
const isBlank = (blocks: Blocks) => !plainText(blocks).trim() && blocks.length <= 1;

export function NotesProvider(props: {
  store: NotesStore;
  routing: "hash" | "memory";
  /** Eingebettet: diese Seite zuerst öffnen (z. B. Link aus Telegram) */
  initialPage?: string | null;
  children: ReactNode;
}) {
  const { store, routing } = props;
  const initialPageRef = useRef(props.initialPage ?? null);
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
  const [access, setAccess] = useState<Access>({ oversee: false, admin: false, studio: false });
  const [locations, setLocations] = useState<Studio[]>([]);
  const [completions, setCompletions] = useState<Completion[]>([]);
  const [profiles, setProfiles] = useState<Map<string, BlitziProfile>>(new Map());
  const profilesRef = useRef(profiles);
  profilesRef.current = profiles;
  const [here, setHere] = useState<Record<string, string>>({});
  const completionsRef = useRef<Completion[]>([]);
  completionsRef.current = completions;
  const [workDays, setWorkDays] = useState<Record<string, string[]> | null>(null);
  const [dayPlan, setDayPlan] = useState<DayPlan | null>(null);
  const [unlocked, setUnlocked] = useState<Set<string> | null>(null);
  const [photoRequest, setPhotoRequest] = useState<PhotoRequest | null>(null);
  const workDaysRef = useRef<Record<string, string[]> | null>(null);
  workDaysRef.current = workDays;
  const [actorId, setActorId] = useState<string | null>(() => storageGet<string | null>("aun-studio-actor", null));
  const [celebration, setCelebration] = useState<Celebration | null>(null);
  const membersRef = useRef<Member[]>([]);
  const accessRef = useRef(access);
  accessRef.current = access;
  const actorRef = useRef<string | null>(null);
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

  // Automatischer Versionsverlauf: höchstens alle 10 Minuten den aktuellen Stand sichern (leere Seiten nicht)
  const snapshot = useCallback(
    async (id: string, blocks: Blocks) => {
      if (isBlank(blocks)) return;
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
      await store.saveVersion({ pageId: id, title, content: blocks }).catch(() => versionAt.current.delete(id));
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
        lastSaved.current.set(id, JSON.stringify(patch.content));
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
    [enqueue, store, toast],
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
        const since = new Date(Date.now() - HISTORY_DAYS * 864e5).toISOString();
        const [who, list, favs, rights] = await Promise.all([store.me(), store.listPages(), store.favorites(), store.access()]);
        const [people, studios, events, days] = await Promise.all([
          store.members().catch(() => [who]),
          store.locations().catch(() => []),
          store.completions(since).catch(() => []),
          store.workDays(since).catch(() => null),
        ]);
        store
          .dayPlan(today())
          .then((plan) => !cancelled && setDayPlan(plan))
          .catch(() => undefined);
        store
          .unlocked()
          .then((ids) => !cancelled && setUnlocked(ids ? new Set(ids) : null))
          .catch(() => undefined);
        store.blitziProfiles?.()
          .then((list) => !cancelled && setProfiles(new Map(list.map((p) => [p.userId, p]))))
          .catch(() => undefined);
        store.hereToday?.()
          .then((map) => !cancelled && setHere(map))
          .catch(() => undefined);
        if (cancelled) return;
        setMe(who);
        meRef.current = who;
        setAccess(rights);
        accessRef.current = rights;
        setLocations(studios);
        setCompletions(events);
        setWorkDays(days);
        const everyone = people.some((m) => m.id === who.id) ? people : [who, ...people];
        setMembers(everyone);
        membersRef.current = everyone;
        const map = new Map(list.map((p) => [p.id, p]));
        setPages(map);
        pagesRef.current = map;
        setFavorites(favs);
        setRecent(storageGet<string[]>(`aun-recent-${store.kind}-${who.id}`, []));
        // Erster Start: Willkommensseite und eigene Aufgabenliste anlegen (nicht am Studio-PC)
        if (!rights.studio && !rights.locked && !list.some((p) => p.ownerId === who.id && p.space === "private")) await seed(who);
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
      if (ev.type === "resync") {
        void syncPagesRef.current?.();
        return;
      }
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

  // Abgleich mit dem Server: neue/geänderte Seiten übernehmen, verschwundene entfernen – eigene, noch nicht
  // gespeicherte Änderungen haben Vorrang. Rückfallebene, falls Live-Nachrichten fehlen.
  const syncPagesRef = useRef<(() => Promise<void>) | null>(null);
  syncPagesRef.current = async () => {
    const list = await store.listPages().catch(() => null);
    if (!list) return;
    const server = new Map(list.map((p) => [p.id, p]));
    setPages((m) => {
      let changed = false;
      const next = new Map(m);
      for (const p of list) {
        if (pending.current.has(p.id) || chains.current.has(p.id)) continue;
        const cur = m.get(p.id);
        if (!cur || cur.updatedAt !== p.updatedAt || JSON.stringify(cur.props) !== JSON.stringify(p.props) || cur.deletedAt !== p.deletedAt) {
          next.set(p.id, p);
          changed = true;
        }
      }
      for (const id of m.keys()) {
        if (!server.has(id) && !pending.current.has(id) && !chains.current.has(id)) {
          next.delete(id);
          changed = true;
        }
      }
      if (!changed) return m;
      pagesRef.current = next;
      return next;
    });
  };

  // Jede Minute (nur bei sichtbarem Tab) und beim Zurückkehren sofort abgleichen
  useEffect(() => {
    if (!loaded) return;
    return everyWhileVisible(() => void syncPagesRef.current?.(), 60_000);
  }, [loaded]);

  // Erledigte Aufgaben / Tagesplan alle 2 Min. auffrischen – nur bei sichtbarem Tab, beim Zurückkehren sofort
  useEffect(() => {
    if (!loaded) return;
    return everyWhileVisible(() => {
      const since = new Date(Date.now() - HISTORY_DAYS * 864e5).toISOString();
      store
        .completions(since)
        .then(setCompletions)
        .catch(() => undefined);
      store
        .dayPlan(today())
        .then(setDayPlan)
        .catch(() => undefined);
      store
        .unlocked()
        .then((ids) => setUnlocked(ids ? new Set(ids) : null))
        .catch(() => undefined);
      store.blitziProfiles?.()
        .then((list) => setProfiles(new Map(list.map((p) => [p.userId, p]))))
        .catch(() => undefined);
      store.hereToday?.()
        .then(setHere)
        .catch(() => undefined);
    }, 120_000);
  }, [loaded, store]);

  // ---------------- Navigation ----------------
  // Eingebettet: zuletzt geöffnete Seite pro Nutzer merken (Geräte werden geteilt)
  const lastKey = me.id ? `aun-last-page-${store.kind}-${me.id}` : "";
  const lastKeyRef = useRef(lastKey);
  lastKeyRef.current = lastKey;

  useEffect(() => {
    if (routing !== "hash") {
      if (lastKey) {
        setCurrent(initialPageRef.current ?? storageGet<string | null>(lastKey, null));
        initialPageRef.current = null;
      }
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
      if (p.archivedAt || p.deletedAt || seen.has(p.id)) return false;
      seen.add(p.id);
      if (!p.parentId) return true;
      const parent = pagesRef.current.get(p.parentId);
      // Elternseite für mich nicht sichtbar (z. B. zugewiesene Aufgabe aus einer fremden Liste): gilt als lebend
      if (!parent) return true;
      p = parent;
    }
    return false;
  }, []);

  const childrenOf = useCallback(
    (parentId: string | null, space?: Space) =>
      [...pages.values()]
        .filter((p) => p.parentId === parentId && !p.archivedAt && !p.deletedAt && (parentId !== null || p.space === space))
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
      const existing = opts.ifMissing && opts.id ? pagesRef.current.get(opts.id) : undefined;
      if (existing) return existing;
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
        deletedAt: null,
        deletedBy: null,
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
          // Gleiche feste ID schon von einem anderen Gerät angelegt: kein Fehler (kommt per Live-Update)
          if (opts.ifMissing && /duplicate|23505|409/i.test(`${(e as { code?: string }).code ?? ""} ${(e as Error).message}`)) return;
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
      deletedAt: null,
      deletedBy: null,
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

  // Gutschrift: an die Zuständigen, sonst an die handelnde Person. 1 Punkt je Aufgabe, höchstens 3 pro Tag
  const recordCompletion = useCallback(
    (row: PageMeta, schema: DbSchema, done: boolean) => {
      if (!done) {
        setCompletions((c) => c.filter((x) => x.pageId !== row.id));
        store.setCompletion(row.id, [], 0, false).catch(() => undefined);
        return;
      }
      const people = membersRef.current.filter((m) => !m.device);
      const assigned = schema.properties
        .filter((p) => p.type === "person")
        .flatMap((p) => (Array.isArray(row.props[p.id]) ? (row.props[p.id] as string[]) : []))
        .filter((id, i, all) => all.indexOf(id) === i && people.some((m) => m.id === id));
      const actor = actorRef.current;
      const credited = assigned.length ? assigned : actor ? [actor] : [];
      if (!credited.length) return;
      const day = today();
      const now = new Date().toISOString();
      const before = completionsRef.current;
      const doneToday = (userId: string) => before.filter((x) => !x.bonus && x.userId === userId && x.pageId !== row.id && dayOf(x.doneAt) === day).length;
      const added = credited.map((userId) => ({ pageId: row.id, userId, points: pointsLeftToday(doneToday(userId)), doneAt: now }));
      setCompletions((c) => {
        const next = [...c.filter((x) => x.pageId !== row.id), ...added];
        // Feiern, wenn die handelnde Person etwas gutgeschrieben bekommt
        const mine = actor ? added.find((a) => a.userId === actor) : undefined;
        if (mine) {
          const days = daysFor(workDaysRef.current, actor!);
          const profile = profilesRef.current.get(actor!) ?? null;
          const after = blitziInfo(actor!, next, days, day, profile);
          const prev = blitziInfo(actor!, c, days, day, profile);
          const person = people.find((m) => m.id === actor);
          setCelebration({
            id: Date.now(),
            points: mine.points,
            goal: after.stats.today === after.stats.goal,
            streak: after.stats.streak,
            name: person?.name.split(" ")[0] ?? "",
            grew: after.stats.streak > prev.stats.streak,
            memberId: actor!,
            stage: after.stage,
            levelUp: after.stage > prev.stage,
            items: after.items,
            nickname: after.nickname,
            prestige: after.prestige,
          });
        }
        return next;
      });
      for (const a of added) store.setCompletion(row.id, [a.userId], a.points, true).catch(() => undefined);
    },
    [store],
  );

  const updatePage = useCallback(
    (id: string, patchIn: PagePatch, opts: { delay?: number } = {}) => {
      let patch = patchIn;
      const page = pagesRef.current.get(id);
      const db = page?.parentId ? pagesRef.current.get(page.parentId) : undefined;
      if (page && patch.props && db?.kind === "database" && db.schema) {
        // Fälligkeit nach hinten verschoben → mitzählen (ab dem 2. Mal Fotonachweis)
        const due = dueProp(db.schema);
        let incoming = patch.props;
        if (due && postponed(page.props[due.id], incoming[due.id])) {
          incoming = { ...incoming, [MOVES_KEY]: movesOf(page) + 1 };
          patch = { ...patch, props: incoming };
        }
        const before = isDone(page, db.schema);
        const after = isDone({ ...page, props: incoming }, db.schema);
        if (!before && after) {
          const need = needsPhoto({ ...page, props: incoming });
          if (need.required && !proofOf({ ...page, props: incoming })) {
            // Erst Foto, dann erledigt
            setPhotoRequest({ rowId: id, title: page.title, reason: need.reason!, props: incoming });
            return;
          }
          const next = nextOccurrence({ ...page, props: incoming }, db.schema, today());
          if (next) void createPageRef.current?.({ ...next, parentId: db.id, ifMissing: true }).catch(() => undefined);
        }
        if (before !== after) {
          // "erledigt am …" an der Aufgabe festhalten (wieder geöffnet: entfernen)
          const props = { ...patch.props };
          if (after) props[DONE_AT_KEY] = new Date().toISOString();
          else delete props[DONE_AT_KEY];
          patch = { ...patch, props };
          recordCompletion({ ...page, props }, db.schema, after);
        }
      }
      const { content: _content, plain: _plain, ...meta } = patch;
      patchLocal(id, meta);
      if (page) pagesRef.current = new Map(pagesRef.current).set(id, { ...page, ...meta });
      schedule(id, patch, opts.delay ?? META_DELAY);
    },
    [patchLocal, recordCompletion, schedule],
  );

  const saveContent = useCallback(
    (id: string, blocks: Blocks) => {
      patchLocal(id, {});
      schedule(id, { content: blocks }, CONTENT_DELAY);
    },
    [patchLocal, schedule],
  );

  const onDocSaved = useCallback(
    (id: string, blocks: Blocks) => {
      const json = JSON.stringify(blocks);
      if (lastSaved.current.get(id) === json) return;
      lastSaved.current.set(id, json);
      patchLocal(id, {});
      void snapshot(id, blocks);
    },
    [patchLocal, snapshot],
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
      const editor = editors.current.get(id);
      // Aktuellen Stand sichern, damit das Wiederherstellen rückgängig gemacht werden kann
      const saved = lastSaved.current.get(id);
      const current = editor ? editor.content() : saved ? (JSON.parse(saved) as Blocks) : [];
      if (!isBlank(current)) await saveVersionNow(id, current);
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
      // Offener Editor kennt den neuesten Stand
      const open = editors.current.get(id);
      if (open) return open.content();
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
      const now = new Date().toISOString();
      setPages((m) => {
        const next = new Map(m);
        ids.forEach((x) => {
          const p = next.get(x);
          if (p && !p.deletedAt) next.set(x, { ...p, deletedAt: now, deletedBy: meRef.current.id });
        });
        pagesRef.current = next;
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

  const purge = useCallback(
    async (id: string) => {
      const ids = [id, ...descendants(id, [...pagesRef.current.values()]).map((d) => d.id)];
      setPages((m) => {
        const next = new Map(m);
        ids.forEach((x) => next.delete(x));
        pagesRef.current = next;
        return next;
      });
      try {
        await store.purge(ids);
      } catch (e) {
        toast(`Endgültig löschen fehlgeschlagen: ${(e as Error).message}`);
      }
    },
    [store, toast],
  );

  const restoreDeleted = useCallback(
    (id: string) => {
      const ids = [id, ...descendants(id, [...pagesRef.current.values()]).map((d) => d.id)].filter((x) => pagesRef.current.get(x)?.deletedAt);
      setPages((m) => {
        const next = new Map(m);
        ids.forEach((x) => {
          const p = next.get(x);
          if (p) next.set(x, { ...p, deletedAt: null, deletedBy: null, archivedAt: x === id ? null : p.archivedAt });
        });
        pagesRef.current = next;
        return next;
      });
      store
        .restoreDeleted(ids)
        .then(() => store.update(id, { archivedAt: null }))
        .catch((e: Error) => toast(`Wiederherstellen fehlgeschlagen: ${e.message}`));
    },
    [store, toast],
  );

  const setFocus = useCallback(
    (rowId: string, userId: string, rank: number | null) => {
      const day = today();
      const rows = [...pagesRef.current.values()].filter((p) => !p.deletedAt);
      const current = focusTasks(rows, userId, day);
      // Leitung trägt direkt ein; Mitarbeiter (und der Studio-PC) warten auf Freigabe – die Datenbank prüft das ebenso
      const pendingNew = !accessRef.current.oversee;
      for (const [id, r] of reorderFocus(
        current.map((x) => ({ id: x.row.id, rank: x.rank })),
        rowId,
        rank,
      )) {
        const row = pagesRef.current.get(id);
        const pending = current.find((x) => x.row.id === id)?.pending ?? pendingNew;
        if (row) updatePage(id, { props: withFocus(row.props, userId, day, r, pending) }, { delay: 0 });
      }
    },
    [updatePage],
  );

  const studioName = useCallback((id: string | null | undefined) => locations.find((l) => l.id === id)?.name ?? "Ohne Studio", [locations]);
  const dayStatus = useMemo(
    () => dailyStatus({ day: today(), pages, members, plan: dayPlan, isLive, studioName }),
    [pages, members, dayPlan, isLive, studioName],
  );

  const decideFocus = useCallback(
    (pageId: string, userId: string, ok: boolean) => {
      const row = pagesRef.current.get(pageId);
      const entry = row?.props[FOCUS_KEY] as Record<string, string> | undefined;
      if (row && entry?.[userId]) {
        const next = { ...entry };
        if (ok) next[userId] = next[userId].replace(/:\?$/, "");
        else delete next[userId];
        patchLocal(pageId, { props: { ...row.props, [FOCUS_KEY]: next as unknown as PropValue } });
      }
      store
        .decideFocus(pageId, userId, ok)
        .then((r) => r === "gone" && toast("Diese Tagesaufgabe gibt es nicht mehr."))
        .catch((e: Error) => toast(`Freigabe fehlgeschlagen: ${e.message}`));
    },
    [patchLocal, store, toast],
  );

  const createPageRef = useRef<((opts: CreateOptions) => Promise<PageMeta>) | null>(null);
  createPageRef.current = createPage;

  const resolvePhoto = useCallback(
    async (file: File | null) => {
      const req = photoRequest;
      setPhotoRequest(null);
      if (!req || !file) return;
      try {
        const url = await store.upload(file, req.rowId);
        const proof = { url, at: new Date().toISOString(), by: actorRef.current ?? meRef.current.id };
        updatePage(req.rowId, { props: { ...req.props, [PROOF_KEY]: proof as unknown as PropValue } }, { delay: 0 });
      } catch (e) {
        toast(`Foto hochladen fehlgeschlagen: ${(e as Error).message}`);
      }
    },
    [photoRequest, store, toast, updatePage],
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
        // Offene Seiten liefern den neuesten Stand aus dem Editor
        const content = remap(await loadContent(p.id));
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
    [flush, loadContent, setPage, store, toast],
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

  const actor = access.studio ? (members.find((m) => m.id === actorId && !m.device) ?? null) : me;
  actorRef.current = actor ? actor.id : null;

  const setActor = useCallback((id: string | null) => {
    setActorId(id);
    storageSet("aun-studio-actor", id);
  }, []);

  const inMyView = useCallback((p: PageMeta) => p.space === "team" || p.ownerId === meRef.current.id, []);
  const dismissCelebration = useCallback(() => setCelebration(null), []);

  // Mitglieder mit dem Studio, in dem sie heute eingecheckt sind (Aushilfe)
  const membersHere = useMemo(() => members.map((m) => (here[m.id] ? { ...m, hereId: here[m.id] } : m)), [members, here]);
  const blitzi = useCallback(
    (memberId: string) => blitziInfo(memberId, completions, daysFor(workDays, memberId), today(), profiles.get(memberId) ?? null),
    [completions, workDays, profiles],
  );
  const prestige = useCallback(
    async (memberId: string, item: string, nickname?: string) => {
      if (!store.prestige) throw new Error("Prestige gibt es nur mit der Clock-In-Datenbank.");
      const profile = await store.prestige(memberId, item, nickname);
      setProfiles((m) => new Map(m).set(memberId, profile));
    },
    [store],
  );

  const value = useMemo<Ctx>(
    () => ({
      store,
      me,
      members: membersHere,
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
      onDocSaved,
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
      access,
      locations,
      actor,
      setActor,
      inMyView,
      purge,
      restoreDeleted,
      completions,
      profiles,
      blitzi,
      prestige,
      workDays,
      celebration,
      dismissCelebration,
      setFocus,
      dayStatus,
      decideFocus,
      unlocked,
      photoRequest,
      resolvePhoto,
    }),
    [store, me, members, membersHere, pages, favorites, recent, current, peek, loaded, error, navigate, childrenOf, isLive, createPage, updatePage, saveContent, onDocSaved, loadDoc, saveVersionNow, restoreVersion, presence, setPresence, commentsOpen, setCommentsOpen, loadContent, archive, restore, destroy, duplicate, move, toggleFavorite, registerEditor, toast, toasts, dismissToast, flush, access, locations, actor, setActor, inMyView, purge, restoreDeleted, completions, profiles, blitzi, prestige, workDays, celebration, dismissCelebration, setFocus, dayStatus, decideFocus, unlocked, photoRequest, resolvePhoto],
  );

  return <NotesContext.Provider value={value}>{props.children}</NotesContext.Provider>;
}
