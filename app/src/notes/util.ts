import type { Blocks, Color, PageMeta } from "./types";

export const uid = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (c) =>
        (Number(c) ^ (Math.random() * 16) >> (Number(c) / 4)).toString(16),
      );

export const shortId = () => Math.random().toString(36).slice(2, 10);

export const COLORS: Color[] = ["default", "gray", "brown", "orange", "yellow", "green", "blue", "purple", "pink", "red"];

export const COLOR_LABELS: Record<Color, string> = {
  default: "Standard",
  gray: "Grau",
  brown: "Braun",
  orange: "Orange",
  yellow: "Gelb",
  green: "Grün",
  blue: "Blau",
  purple: "Lila",
  pink: "Pink",
  red: "Rot",
};

/** Kräftige Farbtöne für Cursor anderer Personen im Editor */
export const COLOR_HEX: Record<Color, string> = {
  default: "#787774",
  gray: "#787774",
  brown: "#9f6b53",
  orange: "#d9730d",
  yellow: "#cb912f",
  green: "#448361",
  blue: "#337ea9",
  purple: "#9065b0",
  pink: "#c14c8a",
  red: "#d44c47",
};

export const randomColor = (): Color => COLORS[1 + Math.floor(Math.random() * (COLORS.length - 1))];

export const untitled = (p: Pick<PageMeta, "title"> | undefined) => p?.title.trim() || "Ohne Titel";

/** Position zwischen zwei Nachbarn (Bruchzahlen → kein Umnummerieren nötig) */
export function between(before: number | undefined, after: number | undefined): number {
  if (before === undefined && after === undefined) return 1;
  if (before === undefined) return (after as number) - 1;
  if (after === undefined) return before + 1;
  return (before + after) / 2;
}

/** Klartext eines BlockNote-Dokuments (Suche, Vorschau) */
export function plainText(blocks: Blocks): string {
  const out: string[] = [];
  const visitInline = (content: unknown) => {
    if (typeof content === "string") return out.push(content);
    if (!Array.isArray(content)) {
      // Tabellen: { type: "tableContent", rows: [{ cells: [...] }] }
      const rows = (content as { rows?: { cells: unknown[] }[] } | undefined)?.rows;
      rows?.forEach((r) => r.cells.forEach((c) => visitInline((c as { content?: unknown }).content ?? c)));
      return;
    }
    for (const item of content) {
      if (typeof item === "string") out.push(item);
      else if (item && typeof item === "object") {
        const node = item as { text?: string; content?: unknown; props?: { label?: string } };
        if (typeof node.text === "string") out.push(node.text);
        else if (node.props?.label) out.push(node.props.label);
        if (node.content) visitInline(node.content);
      }
    }
  };
  const visit = (list: Blocks) => {
    for (const b of list) {
      if (!b || typeof b !== "object") continue;
      const block = b as { content?: unknown; children?: Blocks; props?: Record<string, unknown> };
      if (block.content) visitInline(block.content);
      if (typeof block.props?.caption === "string" && block.props.caption) out.push(block.props.caption);
      if (block.children?.length) visit(block.children);
      out.push("\n");
    }
  };
  visit(blocks);
  return out.join(" ").replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, "\n").trim();
}

/** Alle Nachfahren einer Seite (inkl. Datenbank-Zeilen) */
export function descendants(id: string, pages: PageMeta[]): PageMeta[] {
  const byParent = new Map<string, PageMeta[]>();
  for (const p of pages) {
    if (!p.parentId) continue;
    const list = byParent.get(p.parentId) ?? [];
    list.push(p);
    byParent.set(p.parentId, list);
  }
  const out: PageMeta[] = [];
  const walk = (pid: string) => {
    for (const c of byParent.get(pid) ?? []) {
      out.push(c);
      walk(c.id);
    }
  };
  walk(id);
  return out;
}

export function ancestors(id: string, byId: Map<string, PageMeta>): PageMeta[] {
  const out: PageMeta[] = [];
  const seen = new Set<string>();
  let cur = byId.get(id);
  while (cur?.parentId && !seen.has(cur.parentId)) {
    seen.add(cur.parentId);
    cur = byId.get(cur.parentId);
    if (cur) out.unshift(cur);
  }
  return out;
}

export const bySort = (a: PageMeta, b: PageMeta) => a.position - b.position || a.createdAt.localeCompare(b.createdAt);

// ---------------- Datum ----------------

export const pad = (n: number) => String(n).padStart(2, "0");
export const isoDay = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const today = () => isoDay(new Date());

export function addDays(day: string, n: number): string {
  const [y, m, d] = day.split("-").map(Number);
  return isoDay(new Date(y, m - 1, d + n));
}

const WEEKDAYS = ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"];
export const MONTHS = ["Januar", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober", "November", "Dezember"];

/** "2026-10-29" oder "2026-10-29T14:30" → "29. Okt. 2026" / "Heute 14:30" */
export function formatDate(value: string, opts: { relative?: boolean } = {}): string {
  const [day, time] = value.split("T");
  const [y, m, d] = day.split("-").map(Number);
  if (!y || !m || !d) return value;
  const t = time ? ` ${time.slice(0, 5)}` : "";
  if (opts.relative !== false) {
    const diff = Math.round((new Date(y, m - 1, d).getTime() - new Date(new Date().toDateString()).getTime()) / 864e5);
    if (diff === 0) return `Heute${t}`;
    if (diff === 1) return `Morgen${t}`;
    if (diff === -1) return `Gestern${t}`;
  }
  const date = new Date(y, m - 1, d);
  const sameYear = y === new Date().getFullYear();
  return `${WEEKDAYS[date.getDay()]}, ${d}. ${MONTHS[m - 1].slice(0, 3)}${m === 5 ? "" : "."}${sameYear ? "" : ` ${y}`}${t}`;
}

export function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${formatDate(isoDay(d))}, ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function relativeTime(iso: string): string {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return "gerade eben";
  if (s < 3600) return `vor ${Math.floor(s / 60)} Min.`;
  if (s < 86400) return `vor ${Math.floor(s / 3600)} Std.`;
  if (s < 86400 * 7) return `vor ${Math.floor(s / 86400)} Tag${s < 86400 * 2 ? "" : "en"}`;
  return formatTimestamp(iso);
}

export function initials(name: string) {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? "?") + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase();
}

export function download(filename: string, text: string, type = "text/markdown") {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const safeFileName = (s: string) => s.replace(/[\\/:*?"<>|]+/g, "-").trim() || "Seite";

export function storageGet<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

export function storageSet(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Speicher voll oder gesperrt (privates Fenster) – Komfortfunktion, kein Fehler
  }
}
