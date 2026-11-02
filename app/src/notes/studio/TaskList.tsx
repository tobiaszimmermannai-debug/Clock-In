// Aufgabenzeilen mit Zeitstempel: „eingetragen am …“ und – sobald erledigt – „erledigt am …“
import { assigneesOf, doneAtOf, doneProps, type TaskItem } from "../gamification/tasks";
import { useNotes } from "../state";
import { Icon } from "../ui/Icon";
import type { PageMeta } from "../types";
import { formatDate, pad, today, untitled } from "../util";

/** 02.11., 09:14 (mit Jahr, wenn nicht dieses Jahr) */
export function stamp(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const year = d.getFullYear() === new Date().getFullYear() ? "" : String(d.getFullYear()).slice(2);
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${year}, ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function TaskStamp(props: { row: PageMeta; done: boolean }) {
  const notes = useNotes();
  const doneAt = props.done ? doneAtOf(props.row, notes.completions) : null;
  return (
    <span className="nk-stamp">
      eingetragen am {stamp(props.row.createdAt)}
      {props.done && <> · {doneAt ? `erledigt am ${stamp(doneAt)}` : "erledigt"}</>}
    </span>
  );
}

export function TaskLines(props: { items: TaskItem[]; empty?: string; showWho?: boolean; showDb?: boolean }) {
  const notes = useNotes();
  const day = today();
  const toggle = (t: TaskItem) => {
    const next = doneProps(t.row, t.db.schema!, !t.done);
    if (next) notes.updatePage(t.row.id, { props: next }, { delay: 0 });
  };
  if (!props.items.length) return props.empty ? <p className="nk-muted nk-tasks-empty">{props.empty}</p> : null;
  return (
    <ul className="nk-tasks">
      {props.items.map((t) => {
        const who = props.showWho
          ? assigneesOf(t.row, t.db.schema!)
              .map((id) => notes.members.find((m) => m.id === id)?.name.split(" ")[0])
              .filter(Boolean)
              .join(", ")
          : "";
        return (
          <li key={t.row.id} className={t.done ? "is-done" : t.overdue ? "is-overdue" : ""}>
            <button type="button" className={`nk-check${t.done ? " is-on" : ""}`} aria-label={t.done ? "Wieder öffnen" : "Erledigt"} onClick={() => toggle(t)}>
              {t.done && <Icon name="check" size={12} />}
            </button>
            <div className="nk-task-main">
              <button type="button" className="nk-task-title" onClick={() => notes.openPeek(t.row.id)}>
                {t.row.icon && <span>{t.row.icon} </span>}
                {untitled(t.row)}
              </button>
              <TaskStamp row={t.row} done={t.done} />
            </div>
            {who && <span className="nk-task-who">{who}</span>}
            {props.showDb !== false && <span className="nk-muted nk-task-db">{untitled(t.db)}</span>}
            {t.due && (
              <span className={`nk-date${t.overdue ? " is-past" : t.due.slice(0, 10) === day ? " is-today" : ""}`}>{formatDate(t.due)}</span>
            )}
          </li>
        );
      })}
    </ul>
  );
}
