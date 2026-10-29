// Lokaler Speicher (nur dieses Gerät): Demo-Modus und Betrieb ohne Supabase
import type { Blocks, Member, NewPage, NotesStore, PageMeta, PagePatch, StoreEvent } from "../types";
import { storageGet, storageSet } from "../util";

type Row = PageMeta & { content: Blocks; plain: string };

const ME: Member = { id: "local-user", name: "Ich", color: "blue" };

export class LocalStore implements NotesStore {
  readonly kind = "local" as const;
  private rows: Map<string, Row>;
  private listeners = new Set<(e: StoreEvent) => void>();
  private onStorage = (e: StorageEvent) => {
    if (e.key !== this.key) return;
    this.rows = this.read();
    for (const row of this.rows.values()) this.emit({ type: "upsert", page: strip(row), content: row.content });
  };

  constructor(private key = "aun-local-pages", private user: Member = ME) {
    this.rows = this.read();
  }

  private read(): Map<string, Row> {
    return new Map(storageGet<Row[]>(this.key, []).map((r) => [r.id, r]));
  }

  private write() {
    storageSet(this.key, [...this.rows.values()]);
  }

  private emit(e: StoreEvent) {
    this.listeners.forEach((l) => l(e));
  }

  async me() {
    return this.user;
  }

  async members() {
    return [this.user];
  }

  async listPages() {
    return [...this.rows.values()].map(strip);
  }

  async getContent(id: string) {
    return this.rows.get(id)?.content ?? [];
  }

  async create(page: NewPage) {
    this.rows.set(page.id, { ...page });
    this.write();
  }

  async update(id: string, patch: PagePatch) {
    const row = this.rows.get(id);
    if (!row) return;
    this.rows.set(id, { ...row, ...patch, updatedAt: new Date().toISOString(), updatedBy: this.user.id });
    this.write();
  }

  async remove(ids: string[]) {
    for (const id of ids) this.rows.delete(id);
    this.write();
  }

  async search(query: string) {
    const q = query.toLowerCase();
    return [...this.rows.values()].filter((r) => r.plain.toLowerCase().includes(q)).map((r) => r.id);
  }

  async favorites() {
    return storageGet<string[]>(`${this.key}-favorites`, []);
  }

  async setFavorite(id: string, on: boolean) {
    const list = (await this.favorites()).filter((f) => f !== id);
    storageSet(`${this.key}-favorites`, on ? [...list, id] : list);
  }

  upload(file: File) {
    // Ohne Server: als Data-URL im Dokument (groß, aber offline verfügbar)
    return new Promise<string>((resolve, reject) => {
      if (file.size > 3 * 1024 * 1024) return reject(new Error("Im lokalen Modus sind Dateien bis 3 MB möglich."));
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error ?? new Error("Datei konnte nicht gelesen werden."));
      reader.readAsDataURL(file);
    });
  }

  async resolveUrl(url: string) {
    return url;
  }

  subscribe(onEvent: (e: StoreEvent) => void) {
    // Andere Tabs desselben Browsers
    if (this.listeners.size === 0) window.addEventListener("storage", this.onStorage);
    this.listeners.add(onEvent);
    return () => {
      this.listeners.delete(onEvent);
      if (this.listeners.size === 0) window.removeEventListener("storage", this.onStorage);
    };
  }
}

function strip(row: Row): PageMeta {
  const { content: _content, plain: _plain, ...meta } = row;
  return meta;
}
