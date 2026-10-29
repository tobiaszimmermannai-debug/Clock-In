// Schnellsuche (Strg/⌘+K): Titel sofort, Inhalte über den Speicher
import { useEffect, useMemo, useState } from "react";
import { useNotes } from "./state";
import type { PageMeta } from "./types";
import { Icon } from "./ui/Icon";
import { Modal } from "./ui/Popover";
import { ancestors, relativeTime, untitled } from "./util";

export function Search(props: { onClose: () => void }) {
  const notes = useNotes();
  const [query, setQuery] = useState("");
  const [contentHits, setContentHits] = useState<string[]>([]);
  const [index, setIndex] = useState(0);
  const q = query.trim().toLowerCase();

  useEffect(() => {
    if (q.length < 2) return setContentHits([]);
    let cancelled = false;
    const t = setTimeout(() => {
      notes.store
        .search(q)
        .then((ids) => !cancelled && setContentHits(ids))
        .catch(() => undefined);
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [q, notes.store]);

  const results = useMemo(() => {
    const live = [...notes.pages.values()].filter((p) => notes.isLive(p.id));
    if (!q) return notes.recent.map((id) => notes.pages.get(id)).filter((p): p is PageMeta => Boolean(p && notes.isLive(p.id))).slice(0, 8);
    const byTitle = live.filter((p) => untitled(p).toLowerCase().includes(q));
    const byContent = contentHits.map((id) => notes.pages.get(id)).filter((p): p is PageMeta => Boolean(p && notes.isLive(p.id) && !byTitle.includes(p)));
    return [...byTitle.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)), ...byContent].slice(0, 30);
  }, [q, contentHits, notes]);

  useEffect(() => setIndex(0), [q]);

  const open = (p: PageMeta) => {
    const parent = p.parentId ? notes.pages.get(p.parentId) : undefined;
    if (parent?.kind === "database") {
      notes.navigate(parent.id);
      setTimeout(() => notes.openPeek(p.id));
    } else notes.navigate(p.id);
    props.onClose();
  };

  return (
    <Modal onClose={props.onClose} label="Suchen" className="nk-search">
      <div className="nk-search-head">
        <Icon name="search" size={18} />
        <input
          autoFocus
          placeholder="Seiten und Inhalte durchsuchen …"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") (e.preventDefault(), setIndex((i) => Math.min(results.length - 1, i + 1)));
            if (e.key === "ArrowUp") (e.preventDefault(), setIndex((i) => Math.max(0, i - 1)));
            if (e.key === "Enter" && results[index]) open(results[index]);
          }}
        />
      </div>
      <div className="nk-search-body">
        <div className="nk-menu-section">{q ? "Ergebnisse" : "Zuletzt besucht"}</div>
        {results.map((p, i) => {
          const path = ancestors(p.id, notes.pages).map(untitled).join(" / ");
          return (
            <button
              key={p.id}
              type="button"
              className={`nk-search-row${i === index ? " is-active" : ""}`}
              onMouseEnter={() => setIndex(i)}
              onClick={() => open(p)}
            >
              <span className="nk-search-icon">{p.icon ?? <Icon name={p.kind === "database" ? "database" : "page"} />}</span>
              <span className="nk-search-text">
                <span>{untitled(p)}</span>
                {path && <small className="nk-muted">{path}</small>}
              </span>
              <small className="nk-muted">{relativeTime(p.updatedAt)}</small>
            </button>
          );
        })}
        {!results.length && <div className="nk-empty-hint">{q ? "Nichts gefunden." : "Noch keine Seiten besucht."}</div>}
      </div>
    </Modal>
  );
}
