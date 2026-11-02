// "Heute im Fokus": bis zu drei angepinnte Aufgaben pro Person und Tag
import { useMemo, useState } from "react";
import { useNotes } from "../state";
import type { Member } from "../types";
import { Icon } from "../ui/Icon";
import { MenuItem, MenuLabel, Popover, usePopover } from "../ui/Popover";
import { personDay } from "../daily/status";
import { TaskStamp } from "../studio/TaskList";
import { ProofBadge } from "./TaskExtras";
import { createTaskFor } from "../studio/teamList";
import { formatDate, today, untitled } from "../util";
import { MAX_FOCUS } from "./focus";
import { allTasks, byDue, doneProps, tasksOf } from "./tasks";

export function FocusSection(props: { member: Member; compact?: boolean }) {
  const notes = useNotes();
  const pick = usePopover();
  // Mehrere Aufgaben in einem Rutsch anpinnen (bis die drei Plätze voll sind)
  const [chosen, setChosen] = useState<string[]>([]);
  // Suche über alle offenen Aufgaben (nicht nur eigene) – oder neu anlegen
  const [query, setQuery] = useState("");
  const [showAll, setShowAll] = useState(false);
  const [busy, setBusy] = useState(false);
  const day = today();
  const userId = props.member.id;
  const { pages, isLive, inMyView } = notes;
  const items = useMemo(
    // Eigene Ansicht: nur Team und Eigenes; Leitung sieht beim Fokus anderer auch deren private Listen
    () => allTasks(pages, isLive, (db) => userId !== notes.me.id || inMyView(db)),
    [pages, isLive, inMyView, userId, notes.me.id],
  );
  const byId = new Map(items.map((t) => [t.row.id, t]));
  // Tagesstand aus der gemeinsamen Berechnung (wie der Telegram-Reminder)
  const today_ = personDay(notes.dayStatus, userId);
  const absent = today_?.absent ?? false;
  const focus = (today_?.focus ?? []).map((f) => ({ row: f.row, rank: f.rank, pending: f.pending, task: f }));
  const lead = notes.access.oversee;
  const free = (t: (typeof items)[number]) => !t.done && !focus.some((f) => f.row.id === t.row.id);
  const candidates = tasksOf(items, userId).filter(free).sort(byDue).slice(0, 12);
  const allOpen = items.filter(free).sort(byDue);
  const q = query.trim().toLowerCase();
  const shown = q ? allOpen.filter((t) => untitled(t.row).toLowerCase().includes(q)).slice(0, 40) : showAll ? allOpen.slice(0, 80) : candidates;
  const slots = MAX_FOCUS - focus.length;
  const closePick = () => {
    setChosen([]);
    setQuery("");
    setShowAll(false);
    pick.close();
  };
  const addNew = async () => {
    const title = query.trim();
    if (!title || busy) return;
    const same = allOpen.find((t) => untitled(t.row).trim().toLowerCase() === title.toLowerCase());
    if (same) {
      setChosen((c) => (c.includes(same.row.id) || c.length >= slots ? c : [...c, same.row.id]));
      setQuery("");
      return;
    }
    setBusy(true);
    try {
      const row = await createTaskFor(notes, props.member, title, notes.access.studioLocationId);
      if (row) {
        setChosen((c) => (c.length < slots ? [...c, row.id] : c));
        setQuery("");
      }
    } catch {
      // Fehlermeldung zeigt createPage bereits an
    } finally {
      setBusy(false);
    }
  };
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
        <span className="nk-muted nk-focus-count">{absent ? "–" : `${focus.filter((f) => f.task.done).length}/${focus.length || MAX_FOCUS}`}</span>
        <span className="nk-spacer" />
        {focus.length < MAX_FOCUS && (
          <button type="button" className="nk-btn is-ghost" onClick={(e) => pick.open(e.currentTarget)}>
            <Icon name="plus" /> Aufgabe anpinnen
          </button>
        )}
      </div>
      {absent ? (
        <p className="nk-focus-absent" title="Laut Dienstplan heute krank, in der Schule oder im Urlaub">
          <b>-</b> heute abwesend – zählt nicht als offen
        </p>
      ) : focus.length ? (
        <ol className="nk-focus-list">
          {focus.map(({ row, rank, pending, task }) => (
            <li key={row.id} className={`${task.done ? "is-done" : task.overdue ? "is-overdue" : ""}${pending ? " is-pending" : ""}`}>
              <span className={`nk-focus-rank is-${rank}`}>{rank}</span>
              <button
                type="button"
                className={`nk-check${task.done ? " is-on" : ""}`}
                aria-label={task.done ? "Wieder öffnen" : "Erledigt"}
                onClick={() => toggle(row.id, !task.done)}
              >
                {task.done && <Icon name="check" size={12} />}
              </button>
              <div className="nk-task-main">
                <button type="button" className="nk-focus-name" onClick={() => notes.openPeek(row.id)}>
                  {row.icon && <span>{row.icon} </span>}
                  {untitled(row)}
                </button>
                <TaskStamp row={row} done={task.done} />
              </div>
              <ProofBadge row={row} done={task.done} />
              {pending ? (
                lead ? (
                  <span className="nk-focus-approve">
                    <button type="button" className="nk-btn is-small" onClick={() => notes.decideFocus(row.id, userId, true)}>
                      ✓ Freigeben
                    </button>
                    <button type="button" className="nk-btn is-small is-ghost" onClick={() => notes.decideFocus(row.id, userId, false)}>
                      Ablehnen
                    </button>
                  </span>
                ) : (
                  <span className="nk-tag is-orange" title="Die Leitung wurde per Telegram gefragt">
                    ⏳ wartet auf Freigabe
                  </span>
                )
              ) : (
                <span className="nk-muted nk-focus-db">{untitled(task.db)}</span>
              )}
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
        <Popover anchor={pick.anchor} onClose={closePick} width={360}>
          <MenuLabel>
            Bis zu {MAX_FOCUS - focus.length} {MAX_FOCUS - focus.length === 1 ? "Aufgabe" : "Aufgaben"} auswählen
            {userId !== notes.actor?.id ? ` · ${first}` : ""}
          </MenuLabel>
          <form
            className="nk-quickadd"
            onSubmit={(e) => {
              e.preventDefault();
              void addNew();
            }}
          >
            <span aria-hidden>🔎</span>
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Alle Aufgaben suchen oder neu anlegen …" aria-label="Aufgabe suchen oder neu anlegen" autoFocus />
          </form>
          <div className="nk-menu-scroll">
            {q && !allOpen.some((t) => untitled(t.row).trim().toLowerCase() === q) && (
              <MenuItem icon={<span>＋</span>} label={`„${query.trim()}“ neu anlegen`} hint={busy ? "…" : "Enter"} disabled={busy} onClick={() => void addNew()} />
            )}
            {!q && showAll && <MenuLabel>Alle offenen Aufgaben</MenuLabel>}
            {shown.map((t) => {
              const index = chosen.indexOf(t.row.id);
              const full = chosen.length >= MAX_FOCUS - focus.length;
              return (
                <MenuItem
                  key={t.row.id}
                  icon={<span className={`nk-pick-box${index >= 0 ? " is-on" : ""}`}>{index >= 0 ? focus.length + index + 1 : ""}</span>}
                  label={untitled(t.row)}
                  hint={t.due ? formatDate(t.due) : untitled(t.db)}
                  active={index >= 0}
                  disabled={index < 0 && full}
                  onClick={() => setChosen((c) => (index >= 0 ? c.filter((id) => id !== t.row.id) : full ? c : [...c, t.row.id]))}
                />
              );
            })}
            {!shown.length && !q && <div className="nk-empty-hint">Keine eigenen offenen Aufgaben – oben suchen oder eine neue eintippen.</div>}
            {!q && !showAll && allOpen.length > candidates.length && (
              <button type="button" className="nk-btn is-ghost nk-pick-all" onClick={() => setShowAll(true)}>
                Alle offenen Aufgaben zeigen ({allOpen.length})
              </button>
            )}
          </div>
          {(shown.length > 0 || chosen.length > 0) && (
            <div className="nk-pick-foot">
              <button
                type="button"
                className="nk-btn is-primary"
                disabled={!chosen.length}
                onClick={() => {
                  // In der gewählten Reihenfolge anpinnen
                  chosen.forEach((id, i) => notes.setFocus(id, userId, focus.length + i + 1));
                  closePick();
                }}
              >
                📌 {chosen.length ? `${chosen.length} ${chosen.length === 1 ? "Aufgabe" : "Aufgaben"} anpinnen` : "Aufgaben auswählen"}
              </button>
            </div>
          )}
        </Popover>
      )}
    </section>
  );
}
