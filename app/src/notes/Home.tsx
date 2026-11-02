// Startseite: Tagesfokus (angepinnt), Blitzi mit Serie/Akku, Rangliste, zuletzt besucht, meine Aufgaben.
// Am Studio-PC zuerst "Wer bist du?".
import { useMemo, useState } from "react";
import { FocusSection } from "./gamification/Focus";
import { BlitziCard, Leaderboard } from "./gamification/GamePanel";
import { allTasks, byDue, doneProps, tasksOf } from "./gamification/tasks";
import { useNotes } from "./state";
import { TaskStamp } from "./studio/TaskList";
import type { Member, PageMeta } from "./types";
import { Icon } from "./ui/Icon";
import { formatDate, initials, relativeTime, today, untitled } from "./util";

export function Home(props: { title: string; onTemplates: () => void }) {
  const notes = useNotes();
  const actor = notes.actor;
  const hour = new Date().getHours();
  const greeting = hour < 11 ? "Guten Morgen" : hour < 18 ? "Guten Tag" : "Guten Abend";
  const { pages, isLive, inMyView } = notes;
  const items = useMemo(() => allTasks(pages, isLive, inMyView), [pages, isLive, inMyView]);

  if (!actor) {
    return (
      <div className="nk-page is-full">
        <div className="nk-page-inner nk-home">
          <StudioWho />
          <Leaderboard limit={8} />
        </div>
      </div>
    );
  }

  const first = actor.name === "Ich" ? "" : actor.name.split(" ")[0];
  const mine = tasksOf(items, actor.id);
  const open = mine.filter((t) => !t.done).sort(byDue);
  const recent = notes.recent
    .map((id) => notes.pages.get(id))
    .filter((p): p is PageMeta => Boolean(p && notes.isLive(p.id) && notes.inMyView(p)))
    .slice(0, 8);

  const toggle = (id: string, done: boolean) => {
    const t = items.find((x) => x.row.id === id);
    const next = t && doneProps(t.row, t.db.schema!, done);
    if (next) notes.updatePage(id, { props: next }, { delay: 0 });
  };

  return (
    <div className="nk-page is-full">
      <div className="nk-page-inner nk-home">
        <h1 className="nk-home-title">
          {greeting}
          {first ? `, ${first}` : ""}
        </h1>

        <FocusSection member={actor} />

        <div className="nk-home-game">
          <BlitziCard member={actor} open={open.length} />
          <Leaderboard highlight={actor.id} />
        </div>

        {!notes.access.studio && (
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
        )}

        <section>
          <div className="nk-home-heading">
            <Icon name="checkbox" /> {notes.access.studio ? `Aufgaben von ${first}` : "Meine Aufgaben"}
            <span className="nk-muted"> · {open.length} offen</span>
          </div>
          {open.length ? (
            <div className="nk-home-tasks">
              {open.slice(0, 40).map(({ row, db, due, overdue }) => (
                <div key={row.id} className="nk-home-task">
                  <button type="button" className="nk-check" aria-label="Erledigt" onClick={() => toggle(row.id, true)} />
                  <div className="nk-task-main">
                    <button type="button" className="nk-home-task-title" onClick={() => (notes.navigate(db.id), setTimeout(() => notes.openPeek(row.id)))}>
                      {row.icon && <span>{row.icon} </span>}
                      {untitled(row)}
                    </button>
                    <TaskStamp row={row} done={false} />
                  </div>
                  <span className="nk-muted nk-home-task-db">{untitled(db)}</span>
                  {due && <span className={`nk-date${overdue ? " is-past" : due.slice(0, 10) === today() ? " is-today" : ""}`}>{formatDate(due)}</span>}
                </div>
              ))}
            </div>
          ) : (
            <div className="nk-home-empty">
              <p className="nk-muted">Keine offenen Aufgaben. Aufgaben, bei denen {notes.access.studio ? "du" : "du"} zuständig bist, erscheinen hier automatisch.</p>
              {!notes.access.studio && (
                <button type="button" className="nk-btn" onClick={props.onTemplates}>
                  <Icon name="template" /> Aufgabenliste aus Vorlage
                </button>
              )}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

/** Studio-PC: Person auswählen – eigenes Studio zuerst */
export function StudioWho() {
  const notes = useNotes();
  const [others, setOthers] = useState(false);
  const people = notes.members.filter((m) => !m.device);
  const studio = notes.access.studioLocationId;
  const here = people.filter((m) => !studio || m.studioId === studio);
  const rest = people.filter((m) => studio && m.studioId !== studio);
  const tile = (m: Member) => (
    <button key={m.id} type="button" className="nk-who-tile" onClick={() => notes.setActor(m.id)}>
      <span className={`nk-avatar is-${m.color}`}>{initials(m.name)}</span>
      <span>{m.name}</span>
    </button>
  );
  return (
    <section className="nk-who">
      <h1 className="nk-home-title">Wer bist du?</h1>
      <p className="nk-muted">Tippe auf deinen Namen – dann siehst du deinen Tagesfokus und deine Aufgaben. Nach 10 Minuten ohne Eingabe meldet sich der PC wieder ab.</p>
      <div className="nk-who-grid">{here.map(tile)}</div>
      {rest.length > 0 && (
        <>
          <button type="button" className="nk-btn is-ghost" onClick={() => setOthers(!others)}>
            {others ? "Andere Studios ausblenden" : `Andere Studios (${rest.length})`}
          </button>
          {others && <div className="nk-who-grid">{rest.map(tile)}</div>}
        </>
      )}
    </section>
  );
}
