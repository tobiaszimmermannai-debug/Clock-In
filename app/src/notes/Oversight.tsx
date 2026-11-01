// Team-Übersicht für die Leitung (Admins, Studioleitung): alle Personen, alle Aufgaben, Gelöschtes
import { useMemo, useState } from "react";
import { Blitzi } from "./gamification/Blitzi";
import { stageOf } from "./gamification/evolution";
import { FocusSection } from "./gamification/Focus";
import { statsFor } from "./gamification/GamePanel";
import { allTasks, assigneesOf, byDue, tasksOf, type TaskItem } from "./gamification/tasks";
import { useNotes } from "./state";
import type { Member, PageMeta } from "./types";
import { Icon } from "./ui/Icon";
import { formatDate, relativeTime, untitled } from "./util";

type Tab = "people" | "tasks" | "deleted";

export function Oversight() {
  const notes = useNotes();
  const [tab, setTab] = useState<Tab>("people");
  const { pages, isLive } = notes;
  const items = useMemo(() => allTasks(pages, isLive), [pages, isLive]);
  const people = notes.members.filter((m) => !m.device);

  return (
    <div className="nk-page is-full">
      <div className="nk-page-inner nk-oversight">
        <div className="nk-st-head">
          <h1 className="nk-st-title">🛡️ Team-Übersicht</h1>
          <span className="nk-spacer" />
          <div className="nk-segmented">
            {(
              [
                ["people", "Personen"],
                ["tasks", "Alle Aufgaben"],
                ["deleted", "Gelöscht"],
              ] as const
            ).map(([id, label]) => (
              <button key={id} type="button" aria-pressed={tab === id} onClick={() => setTab(id)}>
                {label}
              </button>
            ))}
          </div>
        </div>
        <p className="nk-muted nk-oversight-hint">
          {notes.access.admin
            ? "Als Admin siehst du alle Seiten und Aufgaben – auch private und gelöschte."
            : "Als Studioleitung siehst du alle Team-Seiten sowie die privaten Seiten und Aufgaben der Mitarbeiter deines Studios – auch gelöschte."}
        </p>
        {tab === "people" && <People people={people} items={items} />}
        {tab === "tasks" && <AllTasks people={people} items={items} />}
        {tab === "deleted" && <Deleted />}
      </div>
    </div>
  );
}

function People(props: { people: Member[]; items: TaskItem[] }) {
  const notes = useNotes();
  const [focusFor, setFocusFor] = useState<string | null>(null);
  const studioName = (id?: string | null) => notes.locations.find((l) => l.id === id)?.name ?? "Ohne Studio";
  const byStudio = new Map<string, Member[]>();
  for (const m of props.people) byStudio.set(studioName(m.studioId), [...(byStudio.get(studioName(m.studioId)) ?? []), m]);

  return (
    <>
      {[...byStudio.entries()].map(([studio, members]) => (
        <section key={studio} className="nk-ov-studio">
          <div className="nk-home-heading">
            <Icon name="users" /> {studio}
          </div>
          <div className="nk-ov-grid">
            {members.map((m) => {
              const mine = tasksOf(props.items, m.id);
              const open = mine.filter((t) => !t.done);
              const overdue = open.filter((t) => t.overdue);
              const stats = statsFor(m.id, notes.completions, null);
              const privatePages = [...notes.pages.values()].filter(
                (p) => p.space === "private" && p.ownerId === m.id && !p.parentId && !p.deletedAt && !p.archivedAt,
              );
              return (
                <article key={m.id} className="nk-ov-card">
                  <header>
                    <Blitzi mood="happy" size={34} stage={stageOf(stats.streak)} kind={m.blitzi} still title={`Stufe ${stageOf(stats.streak)}`} />
                    <b>{m.name}</b>
                    {m.role === "manager" && <span className="nk-tag is-blue">Studioleitung</span>}
                    {m.role === "admin" && <span className="nk-tag is-purple">Admin</span>}
                  </header>
                  <div className="nk-ov-stats">
                    <span>
                      <b>{open.length}</b> offen
                    </span>
                    <span className={overdue.length ? "is-bad" : ""}>
                      <b>{overdue.length}</b> überfällig
                    </span>
                    <span>
                      <b>{stats.week}</b> erledigt (Woche)
                    </span>
                    <span>
                      <b>⚡ {stats.streak}</b> Serie
                    </span>
                  </div>
                  <label className="nk-ov-kind">
                    Blitzi
                    <select value={m.blitzi ?? ""} onChange={(e) => e.target.value && notes.setBlitzi(m.id, e.target.value as "m" | "w")}>
                      {!m.blitzi && <option value="">noch nicht gewählt</option>}
                      <option value="m">männlich</option>
                      <option value="w">weiblich</option>
                    </select>
                  </label>
                  {focusFor === m.id ? (
                    <FocusSection member={m} compact />
                  ) : (
                    <button type="button" className="nk-btn is-ghost" onClick={() => setFocusFor(m.id)}>
                      📌 Tagesfokus ansehen/setzen
                    </button>
                  )}
                  {privatePages.length > 0 && (
                    <div className="nk-ov-pages">
                      <small className="nk-muted">Private Seiten</small>
                      {privatePages.map((p) => (
                        <button key={p.id} type="button" className="nk-ov-page" onClick={() => notes.navigate(p.id)}>
                          {p.icon ?? <Icon name={p.kind === "database" ? "database" : "page"} size={14} />} {untitled(p)}
                        </button>
                      ))}
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        </section>
      ))}
    </>
  );
}

function AllTasks(props: { people: Member[]; items: TaskItem[] }) {
  const notes = useNotes();
  const [person, setPerson] = useState("");
  const [state, setState] = useState<"open" | "overdue" | "done" | "all">("open");
  const list = props.items
    .filter((t) => (state === "all" ? true : state === "done" ? t.done : state === "overdue" ? t.overdue : !t.done))
    .filter((t) => !person || assigneesOf(t.row, t.db.schema!).includes(person) || (person && tasksOf([t], person).length > 0))
    .sort((a, b) => Number(b.overdue) - Number(a.overdue) || byDue(a, b));
  const owner = (db: PageMeta) => (db.space === "team" ? "Team" : `privat · ${notes.members.find((m) => m.id === db.ownerId)?.name ?? "?"}`);
  const names = (t: TaskItem) =>
    assigneesOf(t.row, t.db.schema!)
      .map((id) => notes.members.find((m) => m.id === id)?.name.split(" ")[0])
      .filter(Boolean)
      .join(", ");

  return (
    <>
      <div className="nk-row-gap nk-ov-filters">
        <select className="nk-input is-compact" value={person} onChange={(e) => setPerson(e.target.value)}>
          <option value="">Alle Personen</option>
          {props.people.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </select>
        <div className="nk-segmented">
          {(
            [
              ["open", "Offen"],
              ["overdue", "Überfällig"],
              ["done", "Erledigt"],
              ["all", "Alle"],
            ] as const
          ).map(([id, label]) => (
            <button key={id} type="button" aria-pressed={state === id} onClick={() => setState(id)}>
              {label}
            </button>
          ))}
        </div>
        <span className="nk-muted">{list.length} Einträge</span>
      </div>
      <div className="nk-home-tasks">
        {list.slice(0, 300).map((t) => (
          <button key={t.row.id} type="button" className="nk-home-task" onClick={() => notes.openPeek(t.row.id)}>
            <span className={`nk-check${t.done ? " is-on" : ""}`}>{t.done && <Icon name="check" size={12} />}</span>
            <span className="nk-home-task-title">{untitled(t.row)}</span>
            <span className="nk-muted nk-home-task-db">
              {untitled(t.db)} · {owner(t.db)}
            </span>
            {names(t) && <span className="nk-ov-who">{names(t)}</span>}
            {t.due && <span className={`nk-date${t.overdue ? " is-past" : ""}`}>{formatDate(t.due)}</span>}
          </button>
        ))}
        {!list.length && <div className="nk-empty-hint">Keine Aufgaben in dieser Auswahl.</div>}
      </div>
    </>
  );
}

function Deleted() {
  const notes = useNotes();
  const [confirm, setConfirm] = useState<string | null>(null);
  // Nur die "Wurzel" einer Löschung zeigen (Unterseiten hängen daran)
  const gone = (p?: PageMeta) => Boolean(p && (p.deletedAt || p.archivedAt));
  const list = [...notes.pages.values()]
    .filter((p) => gone(p) && !gone(p.parentId ? notes.pages.get(p.parentId) : undefined))
    .sort((a, b) => (b.deletedAt ?? b.archivedAt ?? "").localeCompare(a.deletedAt ?? a.archivedAt ?? ""));
  const who = (id: string | null) => notes.members.find((m) => m.id === id)?.name ?? "Unbekannt";

  return (
    <div className="nk-home-tasks">
      {list.map((p) => {
        const parent = p.parentId ? notes.pages.get(p.parentId) : undefined;
        return (
          <div key={p.id} className="nk-home-task nk-ov-deleted">
            <span>{p.icon ?? <Icon name={p.kind === "database" ? "database" : "page"} />}</span>
            <span className="nk-home-task-title">
              {untitled(p)}
              <small className="nk-muted">
                {" "}
                · {p.space === "team" ? "Team" : `privat · ${who(p.ownerId)}`}
                {parent ? ` · in ${untitled(parent)}` : ""}
              </small>
            </span>
            <span className={`nk-tag ${p.deletedAt ? "is-red" : "is-gray"}`}>{p.deletedAt ? "gelöscht" : "Papierkorb"}</span>
            <small className="nk-muted">
              {p.deletedAt ? `${who(p.deletedBy)} · ${relativeTime(p.deletedAt)}` : relativeTime(p.archivedAt!)}
            </small>
            <button
              type="button"
              className="nk-btn"
              onClick={() => (p.deletedAt ? notes.restoreDeleted(p.id) : notes.restore(p.id))}
            >
              <Icon name="restore" /> Wiederherstellen
            </button>
            {confirm === p.id ? (
              <button type="button" className="nk-btn is-danger" onClick={() => (void notes.purge(p.id), setConfirm(null))}>
                Wirklich endgültig löschen
              </button>
            ) : (
              <button type="button" className="nk-icon-btn" aria-label="Endgültig löschen" title="Endgültig löschen" onClick={() => setConfirm(p.id)}>
                <Icon name="trash" />
              </button>
            )}
          </div>
        );
      })}
      {!list.length && <div className="nk-empty-hint">Nichts gelöscht.</div>}
    </div>
  );
}
