// Live-Bearbeitung einer Seite: Yjs-Dokument, Abgleich mit anderen Editoren, Anwesenheit (Cursor)
//
// Ablauf: Beim Öffnen wird der gespeicherte Stand geladen und ein "hello" mit dem eigenen Stand gesendet.
// Andere Editoren antworten mit dem, was fehlt ("sync"). Jede eigene Änderung geht sofort als "update"
// an alle. Gespeichert wird der zusammengeführte Stand – vor dem Speichern wird der Stand aus der
// Datenbank eingemischt, so geht nichts verloren, auch wenn einzelne Nachrichten nicht ankommen.
import { applyAwarenessUpdate, Awareness, encodeAwarenessUpdate, removeAwarenessStates } from "y-protocols/awareness";
import * as Y from "yjs";
import type { CollabChannel, CollabMessage, NotesStore } from "../types";

const REMOTE = "remote";

export function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function fromBase64(text: string): Uint8Array {
  const s = atob(text);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export type Peer = { clientId: number; name: string; color: string };

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

  constructor(
    private store: NotesStore,
    private pageId: string,
    /** Eigene Änderung (zum Speichern) */
    private onLocalChange: () => void,
  ) {}

  private get id() {
    return String(this.doc.clientID);
  }

  start(saved: string | null) {
    if (saved) Y.applyUpdate(this.doc, fromBase64(saved), REMOTE);
    this.channel = this.store.collab(this.pageId, (m) => this.receive(m));

    this.doc.on("update", (update: Uint8Array, origin: unknown) => {
      if (origin === REMOTE || this.destroyed) return;
      this.send({ type: "update", data: toBase64(update) });
      this.onLocalChange();
    });

    this.awareness.on("update", (change: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
      if (origin !== REMOTE) {
        const ids = [...change.added, ...change.updated, ...change.removed];
        this.send({ type: "awareness", data: toBase64(encodeAwarenessUpdate(this.awareness, ids)) });
      }
      this.emitPeers();
    });

    this.send({ type: "hello", from: this.id, sv: toBase64(Y.encodeStateVector(this.doc)) });
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

  /** Gespeicherten Stand (z. B. aus der Datenbank oder einem Live-Ereignis) einmischen */
  merge(saved: string) {
    if (!this.destroyed) Y.applyUpdate(this.doc, fromBase64(saved), REMOTE);
  }

  encode(): string {
    return toBase64(Y.encodeStateAsUpdate(this.doc));
  }

  setUser(user: { name: string; color: string }) {
    this.awareness.setLocalStateField("user", user);
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

  destroy() {
    if (this.destroyed) return;
    removeAwarenessStates(this.awareness, [this.doc.clientID], "local");
    this.destroyed = true;
    this.channel?.close();
    this.awareness.destroy();
    this.doc.destroy();
    this.peersListeners.clear();
  }
}
