// Startseite: Begrüßung, zuletzt besucht, meine offenen Aufgaben aus allen Datenbanken
import { useMemo } from "react";
import { getValue, isDone } from "./database/logic";
import { useNotes } from "./state";
import type { PageMeta } from "./types";
import { Icon } from "./ui/Icon";
import { formatDate, relativeTime, today, untitled } from "./util";

export function Home(props: { title: string; onTemplates: () => void }) {
  const notes = useNotes();
  const hour = new Date().getHours();
  const greeting = hour < 11 ? "Guten Morgen" : hour < 18 ? "Guten Tag" : "Guten Abend";
  const first = notes.me.name === "Ich" ? "" : notes.me.name.split(" ")[0];

  const recent = notes.recent
    .map((id) => notes.pages.get(id))
    .filter((p): p is PageMeta => Boolean(p && notes.isLive(p.id)))
    .slice(0, 8);

  // Alle Zeilen, in denen ich in einer Personen-Eigenschaft stehe und die nicht erledigt sind
  const tasks = useMemo(() => {
    const out: { row: PageMeta; db: PageMeta; due: string | null }[] = [];
    for (const db of notes.pages.values()) {
      if (db.kind !== "database" || !db.schema || !notes.isLive(db.id)) continue;
      const people = db.schema.properties.filter((p) => p.type === "person");
      if (!people.length) continue;
      const date = db.schema.properties.find((p) => p.type === "date");
      const mine = db.space === "private" && db.ownerId === notes.me.id;
      for (const row of notes.childrenOf(db.id)) {
        const assigned = people.some((p) => {
          const v = getValue(row, p);
          return Array.isArray(v) && v.includes(notes.me.id);
        });
        // In der eigenen privaten Aufgabenliste zählt auch, was niemandem zugewiesen ist
        const unassigned = mine && people.every((p) => !(getValue(row, p) as string[] | null)?.length);
        if ((!assigned && !unassigned) || isDone(row, db.schema)) continue;
        out.push({ row, db, due: date ? ((row.props[date.id] as string | null) ?? null) : null });
      }
    }
    return out.sort((a, b) => (a.due ?? "￿").localeCompare(b.due ?? "￿")).slice(0, 30);
  }, [notes]);

  return (
    <div className="nk-page is-full">
      <div className="nk-page-inner nk-home">
        <h1 className="nk-home-title">
          {greeting}
          {first ? `, ${first}` : ""}
        </h1>

        <section>
          <div className="nk-home-heading">
            <Icon name="clock" /> Zuletzt besucht
          </div>
          <div className="nk-home-cards">
            {recent.map((p) => (
              <button key={p.id} type="button" className="nk-home-card" onClick={() => notes.navigate(p.id)}>
                <span className="nk-home-card-icon">{p.icon ?? <Icon name={p.kind === "database" ? "database" : "page"} size={22} />}</span>
                <b>{untitled(p)}</b>
                <small className="nk-muted">{relativeTime(p.updatedAt)}</small>
              </button>
            ))}
            <button
              type="button"
              className="nk-home-card is-new"
              onClick={async () => {
                const p = await notes.createPage({ space: "private" });
                notes.navigate(p.id);
              }}
            >
              <span className="nk-home-card-icon">
                <Icon name="plus" size={22} />
              </span>
              <b>Neue Seite</b>
            </button>
          </div>
        </section>

        <section>
          <div className="nk-home-heading">
            <Icon name="checkbox" /> Meine Aufgaben
          </div>
          {tasks.length ? (
            <div className="nk-home-tasks">
              {tasks.map(({ row, db, due }) => (
                <button key={row.id} type="button" className="nk-home-task" onClick={() => (notes.navigate(db.id), setTimeout(() => notes.openPeek(row.id)))}>
                  <span className="nk-row-icon">{row.icon ?? "☐"}</span>
                  <span className="nk-home-task-title">{untitled(row)}</span>
                  <span className="nk-muted nk-home-task-db">{untitled(db)}</span>
                  {due && <span className={`nk-date${due.slice(0, 10) < today() ? " is-past" : due.slice(0, 10) === today() ? " is-today" : ""}`}>{formatDate(due)}</span>}
                </button>
              ))}
            </div>
          ) : (
            <div className="nk-home-empty">
              <p className="nk-muted">Keine offenen Aufgaben. Aufgaben, bei denen du zuständig bist, erscheinen hier automatisch.</p>
              <button type="button" className="nk-btn" onClick={props.onTemplates}>
                <Icon name="template" /> Aufgabenliste aus Vorlage
              </button>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
