// "Heute im Fokus": bis zu drei angepinnte Aufgaben pro Person und Tag
import { useMemo } from "react";
import { useNotes } from "../state";
import type { Member } from "../types";
import { Icon } from "../ui/Icon";
import { MenuItem, MenuLabel, Popover, usePopover } from "../ui/Popover";
import { formatDate, today, untitled } from "../util";
import { focusTasks, MAX_FOCUS } from "./focus";
import { allTasks, byDue, doneProps, tasksOf } from "./tasks";

export function FocusSection(props: { member: Member; compact?: boolean }) {
  const notes = useNotes();
  const pick = usePopover();
  const day = today();
  const userId = props.member.id;
  const { pages, isLive, inMyView } = notes;
  const items = useMemo(
    // Eigene Ansicht: nur Team und Eigenes; Leitung sieht beim Fokus anderer auch deren private Listen
    () => allTasks(pages, isLive, (db) => userId !== notes.me.id || inMyView(db)),
    [pages, isLive, inMyView, userId, notes.me.id],
  );
  const byId = new Map(items.map((t) => [t.row.id, t]));
  const focus = focusTasks(
    items.map((t) => t.row),
    userId,
    day,
  ).map((f) => ({ ...f, task: byId.get(f.row.id)! }));
  const candidates = tasksOf(items, userId)
    .filter((t) => !t.done && !focus.some((f) => f.row.id === t.row.id))
    .sort(byDue)
    .slice(0, 12);
  const first = props.member.name.split(" ")[0];

  const toggle = (id: string, done: boolean) => {
    const t = byId.get(id);
    if (!t) return;
    const next = doneProps(t.row, t.db.schema!, done);
    if (next) notes.updatePage(id, { props: next }, { delay: 0 });
  };

  return (
    <section className={`nk-focus${props.compact ? " is-compact" : ""}`}>
      <div className="nk-focus-head">
        <span className="nk-focus-title">📌 Heute im Fokus{userId !== notes.actor?.id ? ` · ${first}` : ""}</span>
        <span className="nk-muted nk-focus-count">
          {focus.filter((f) => f.task.done).length}/{focus.length || MAX_FOCUS}
        </span>
        <span className="nk-spacer" />
        {focus.length < MAX_FOCUS && (
          <button type="button" className="nk-btn is-ghost" onClick={(e) => pick.open(e.currentTarget)}>
            <Icon name="plus" /> Aufgabe anpinnen
          </button>
        )}
      </div>
      {focus.length ? (
        <ol className="nk-focus-list">
          {focus.map(({ row, rank, task }) => (
            <li key={row.id} className={task.done ? "is-done" : task.overdue ? "is-overdue" : ""}>
              <span className={`nk-focus-rank is-${rank}`}>{rank}</span>
              <button
                type="button"
                className={`nk-check${task.done ? " is-on" : ""}`}
                aria-label={task.done ? "Wieder öffnen" : "Erledigt"}
                onClick={() => toggle(row.id, !task.done)}
              >
                {task.done && <Icon name="check" size={12} />}
              </button>
              <button type="button" className="nk-focus-name" onClick={() => notes.openPeek(row.id)}>
                {row.icon && <span>{row.icon} </span>}
                {untitled(row)}
              </button>
              <span className="nk-muted nk-focus-db">{untitled(task.db)}</span>
              {task.due && <span className={`nk-date${task.overdue ? " is-past" : task.due.slice(0, 10) === day ? " is-today" : ""}`}>{formatDate(task.due)}</span>}
              <span className="nk-focus-actions">
                {rank > 1 && (
                  <button type="button" className="nk-icon-btn" aria-label="Höher priorisieren" onClick={() => notes.setFocus(row.id, userId, rank - 1)}>
                    <Icon name="arrowUp" size={14} />
                  </button>
                )}
                <button type="button" className="nk-icon-btn" aria-label="Nicht mehr anpinnen" onClick={() => notes.setFocus(row.id, userId, null)}>
                  <Icon name="close" size={14} />
                </button>
              </span>
            </li>
          ))}
        </ol>
      ) : (
        <p className="nk-muted nk-focus-empty">Wähle bis zu drei Aufgaben, die heute zuerst drankommen – sie bleiben hier oben angepinnt.</p>
      )}
      {pick.anchor && (
        <Popover anchor={pick.anchor} onClose={pick.close} width={340}>
          <MenuLabel>Offene Aufgaben{userId !== notes.actor?.id ? ` von ${first}` : ""}</MenuLabel>
          <div className="nk-menu-scroll">
            {candidates.map((t) => (
              <MenuItem
                key={t.row.id}
                icon={<span>{t.row.icon ?? "☐"}</span>}
                label={untitled(t.row)}
                hint={t.due ? formatDate(t.due) : untitled(t.db)}
                onClick={() => {
                  notes.setFocus(t.row.id, userId, focus.length + 1);
                  pick.close();
                }}
              />
            ))}
            {!candidates.length && <div className="nk-empty-hint">Keine offenen Aufgaben mit Zuständigkeit – in einer Aufgabenliste unter „Zuständig“ eintragen.</div>}
          </div>
        </Popover>
      )}
    </section>
  );
}
