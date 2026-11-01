// Live-Bearbeitung einer Seite: Yjs-Dokument, Abgleich mit anderen Editoren, Anwesenheit (Cursor), Speichern
//
// Ablauf: Beim Öffnen wird der gespeicherte Stand geladen und ein "hello" mit dem eigenen Stand gesendet.
// Andere Editoren antworten mit dem, was fehlt ("sync"). Jede eigene Änderung geht sofort als "update"
// an alle.
//
// Speichern ohne Datenflut: Eigene Änderungen werden gebündelt als kleine Schritte gespeichert
// (appendDocUpdate). Etwa alle 30 Sekunden – und beim Schließen – fasst der Editor alles zu einem Stand
// zusammen (compactDoc). Dabei wird der gespeicherte Stand vorher eingemischt und nur geschrieben, wenn
// niemand zwischendurch geschrieben hat; so geht nichts verloren, auch wenn Live-Nachrichten ausfallen.
// Als Rückfallebene holt der Editor alle 20 Sekunden neue Schritte anderer nach.
import { applyAwarenessUpdate, Awareness, encodeAwarenessUpdate, removeAwarenessStates } from "y-protocols/awareness";
import * as Y from "yjs";
import type { Blocks, CollabChannel, CollabMessage, DocState, NotesStore } from "../types";
import { fromBase64, toBase64 } from "../util";

export { fromBase64, toBase64 };

const REMOTE = "remote";
const PERSIST_DELAY = 900;
const COMPACT_DELAY = 30_000;
const PULL_INTERVAL = 20_000;
const RETRY_DELAY = 5_000;

export type Peer = { clientId: number; name: string; color: string };

export type SessionHooks = {
  /** Inhalt (BlockNote-JSON) aus dem Yjs-Dokument – für Suche, Export und Versionen */
  toContent: (fragment: Y.XmlFragment) => Blocks;
  /** Nach erfolgreichem Zusammenfassen */
  onSaved?: (content: Blocks) => void;
  onError?: (message: string) => void;
};

export class CollabSession {
  readonly doc = new Y.Doc();
  readonly awareness = new Awareness(this.doc);
  /** Feldname wie von BlockNote erwartet */
  readonly fragment = this.doc.getXmlFragment("document-store");
  /** Kommentar-Threads liegen im selben Dokument */
  readonly threads = this.doc.getMap<unknown>("threads");
  private channel: CollabChannel | null = null;
  private waiters: ((synced: boolean) => void)[] = [];
  private peersListeners = new Set<(peers: Peer[]) => void>();
  private synced = false;
  private destroyed = false;
  private closing = false;

  // Speichern
  private pending: Uint8Array[] = [];
  private included = new Set<number>();
  private lastId = 0;
  private dirty = false;
  private queue: Promise<unknown> = Promise.resolve();
  private persistTimer?: ReturnType<typeof setTimeout>;
  private compactTimer?: ReturnType<typeof setTimeout>;
  private pullTimer?: ReturnType<typeof setInterval>;
  private failing = false;
  private onHide = () => {
    if (document.visibilityState === "hidden") void this.flush();
  };

  constructor(
    private store: NotesStore,
    private pageId: string,
    private hooks: SessionHooks,
  ) {}

  private get id() {
    return String(this.doc.clientID);
  }

  start(saved: DocState | { ydoc: string | null; updateIds?: number[] }) {
    if (saved.ydoc) Y.applyUpdate(this.doc, fromBase64(saved.ydoc), REMOTE);
    for (const id of saved.updateIds ?? []) this.include(id);
    this.channel = this.store.collab(this.pageId, (m) => this.receive(m));

    this.doc.on("update", (update: Uint8Array, origin: unknown) => {
      if (origin === REMOTE || this.destroyed) return;
      this.send({ type: "update", data: toBase64(update) });
      this.pending.push(update);
      this.dirty = true;
      this.schedulePersist();
      this.scheduleCompact(COMPACT_DELAY);
    });

    this.awareness.on("update", (change: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
      if (origin !== REMOTE) {
        const ids = [...change.added, ...change.updated, ...change.removed];
        this.send({ type: "awareness", data: toBase64(encodeAwarenessUpdate(this.awareness, ids)) });
      }
      this.emitPeers();
    });

    this.send({ type: "hello", from: this.id, sv: toBase64(Y.encodeStateVector(this.doc)) });
    this.pullTimer = setInterval(() => void this.pull(), PULL_INTERVAL);
    if (typeof document !== "undefined") document.addEventListener("visibilitychange", this.onHide);
    // Liegen beim Öffnen noch einzelne Schritte vor, bald zusammenfassen (hält die Tabelle klein)
    if (saved.updateIds?.length) this.scheduleCompact(5_000);
  }

  private include(id: number) {
    this.included.add(id);
    if (id > this.lastId) this.lastId = id;
  }

  private send(m: CollabMessage) {
    if (!this.destroyed) this.channel?.send(m);
  }

  private receive(m: CollabMessage) {
    if (this.destroyed) return;
    switch (m.type) {
      case "update":
        Y.applyUpdate(this.doc, fromBase64(m.data), REMOTE);
        return;
      case "awareness":
        applyAwarenessUpdate(this.awareness, fromBase64(m.data), REMOTE);
        return;
      case "hello":
        // Neuer Editor: fehlende Änderungen schicken, eigenen Stand mitgeben (damit er uns seine schickt)
        this.send({
          type: "sync",
          to: m.from,
          data: toBase64(Y.encodeStateAsUpdate(this.doc, fromBase64(m.sv))),
          sv: toBase64(Y.encodeStateVector(this.doc)),
        });
        if (this.awareness.getLocalState()) {
          this.send({ type: "awareness", data: toBase64(encodeAwarenessUpdate(this.awareness, [this.doc.clientID])) });
        }
        return;
      case "sync": {
        if (m.to !== this.id) return;
        Y.applyUpdate(this.doc, fromBase64(m.data), REMOTE);
        if (m.sv) {
          const missing = Y.encodeStateAsUpdate(this.doc, fromBase64(m.sv));
          // Leeres Update = 2 Bytes
          if (missing.length > 2) this.send({ type: "update", data: toBase64(missing) });
        }
        this.synced = true;
        this.waiters.splice(0).forEach((w) => w(true));
        return;
      }
    }
  }

  // ---------------- Speichern ----------------

  /** Speicher-Aufgaben nacheinander ausführen */
  private run<T>(job: () => Promise<T>): Promise<T> {
    const next = this.queue.then(job, job);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private fail(e: unknown) {
    if (!this.failing) this.hooks.onError?.((e as Error)?.message || "Speichern fehlgeschlagen.");
    this.failing = true;
  }

  private schedulePersist(delay = PERSIST_DELAY) {
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => void this.persist(), delay);
  }

  private scheduleCompact(delay: number) {
    if (this.compactTimer || this.closing) return;
    this.compactTimer = setTimeout(() => {
      this.compactTimer = undefined;
      void this.compact();
    }, delay);
  }

  /** Eigene Änderungen als einen kleinen Schritt speichern */
  persist(): Promise<void> {
    return this.run(async () => {
      if (!this.pending.length) return;
      const batch = this.pending.splice(0);
      try {
        const id = await this.store.appendDocUpdate(this.pageId, toBase64(Y.mergeUpdates(batch)));
        if (id !== null) this.include(id);
        this.failing = false;
      } catch (e) {
        this.pending.unshift(...batch);
        this.fail(e);
        if (!this.destroyed) this.schedulePersist(RETRY_DELAY);
      }
    });
  }

  /** Alles zu einem Stand zusammenfassen (inkl. Inhalt für Suche/Export) */
  compact(): Promise<void> {
    return this.run(async () => {
      if (!this.dirty && !this.included.size) return;
      const ids = [...this.included];
      let pendingAtBuild = 0;
      try {
        const content = await this.store.compactDoc(
          this.pageId,
          (stored) => {
            if (stored) Y.applyUpdate(this.doc, fromBase64(stored), REMOTE);
            pendingAtBuild = this.pending.length;
            return { ydoc: toBase64(Y.encodeStateAsUpdate(this.doc)), content: this.hooks.toContent(this.fragment) };
          },
          ids,
        );
        // Was im Stand steckt, muss nicht mehr einzeln gespeichert oder gelöscht werden
        this.pending.splice(0, pendingAtBuild);
        for (const id of ids) this.included.delete(id);
        this.dirty = this.pending.length > 0;
        this.failing = false;
        this.hooks.onSaved?.(content);
      } catch (e) {
        this.fail(e);
        if (!this.destroyed) this.scheduleCompact(RETRY_DELAY);
      }
    });
  }

  /** Neue Schritte anderer nachholen (falls Live-Nachrichten fehlten) */
  pull(): Promise<void> {
    return this.run(async () => {
      if (this.destroyed) return;
      try {
        const rows = await this.store.pullDocUpdates(this.pageId, this.lastId);
        for (const r of rows) {
          if (!this.included.has(r.id)) Y.applyUpdate(this.doc, fromBase64(r.data), REMOTE);
          this.include(r.id);
        }
      } catch {
        // Nächster Versuch beim nächsten Intervall
      }
    });
  }

  /** Sofort speichern und zusammenfassen (Tab wird versteckt, Seite wird geschlossen) */
  async flush() {
    if (this.persistTimer) clearTimeout(this.persistTimer);
    if (this.compactTimer) clearTimeout(this.compactTimer);
    this.persistTimer = this.compactTimer = undefined;
    await this.persist();
    if (this.dirty) await this.compact();
  }

  // ---------------- Anwesenheit ----------------

  /** Auf Antwort eines anderen Editors warten (bevor eine neue Seite aus JSON aufgebaut wird) */
  waitForPeer(ms: number): Promise<boolean> {
    if (this.synced) return Promise.resolve(true);
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== done);
        resolve(false);
      }, ms);
      const done = (ok: boolean) => {
        clearTimeout(t);
        resolve(ok);
      };
      this.waiters.push(done);
    });
  }

  /** Gespeicherten Stand (z. B. aus einem Live-Ereignis) einmischen */
  merge(saved: string) {
    if (!this.destroyed) Y.applyUpdate(this.doc, fromBase64(saved), REMOTE);
  }

  encode(): string {
    return toBase64(Y.encodeStateAsUpdate(this.doc));
  }

  peers(): Peer[] {
    const out: Peer[] = [];
    this.awareness.getStates().forEach((state, clientId) => {
      const user = (state as { user?: { name?: string; color?: string } }).user;
      if (clientId !== this.doc.clientID && user?.name) out.push({ clientId, name: user.name, color: user.color ?? "#787774" });
    });
    return out;
  }

  onPeers(cb: (peers: Peer[]) => void) {
    this.peersListeners.add(cb);
    return () => this.peersListeners.delete(cb);
  }

  private emitPeers() {
    const list = this.peers();
    this.peersListeners.forEach((l) => l(list));
  }

  /** Schließen: Anwesenheit sofort beenden, dann speichern und abbauen */
  async close() {
    if (this.closing) return;
    this.closing = true;
    if (typeof document !== "undefined") document.removeEventListener("visibilitychange", this.onHide);
    if (this.pullTimer) clearInterval(this.pullTimer);
    removeAwarenessStates(this.awareness, [this.doc.clientID], "local");
    try {
      await this.flush();
    } finally {
      this.destroyed = true;
      this.channel?.close();
      this.awareness.destroy();
      this.doc.destroy();
      this.peersListeners.clear();
    }
  }
}
