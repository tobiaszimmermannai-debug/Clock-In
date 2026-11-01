// Kleine Erinnerung für Clock-In (beim Login, nach "Kommen" und zur Pause): Blitzi, Tagesfokus, Serie, offene Aufgaben.
// Lädt ohne den Editor – bleibt leichtgewichtig.
import "./reminder.css";
import { useEffect, useState } from "react";
import type { NotesStore, PageMeta } from "../types";
import { today, untitled } from "../util";
import { Blitzi } from "./Blitzi";
import { focusTasks } from "./focus";
import { Energy } from "./GamePanel";
import { moodFor, myStats, speech, type MyStats } from "./stats";
import { allTasks, byDue, tasksOf, type TaskItem } from "./tasks";

export type ReminderReason = "login" | "clock_in" | "break";

type Data = { name: string; open: TaskItem[]; focus: { item: TaskItem; rank: number }[]; stats: MyStats };

export function TaskReminder(props: { store: NotesStore; reason: ReminderReason; onOpen: () => void; onClose?: () => void }) {
  const { store } = props;
  const [data, setData] = useState<Data | null>(null);
  const [variant, setVariant] = useState(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const since = new Date(Date.now() - 90 * 864e5).toISOString();
      const [me, list, events, days] = await Promise.all([store.me(), store.listPages(), store.completions(since), store.workDays(since)]);
      if (me.device) return;
      const pages = new Map(list.map((p) => [p.id, p]));
      const isLive = (id: string) => {
        let p: PageMeta | undefined = pages.get(id);
        for (let i = 0; p && i < 50; i++) {
          if (p.archivedAt || p.deletedAt) return false;
          if (!p.parentId) return true;
          p = pages.get(p.parentId);
        }
        return false;
      };
      const items = allTasks(pages, isLive, (db) => db.space === "team" || db.ownerId === me.id);
      const byId = new Map(items.map((t) => [t.row.id, t]));
      const open = tasksOf(items, me.id)
        .filter((t) => !t.done)
        .sort(byDue);
      const focus = focusTasks(
        items.map((t) => t.row),
        me.id,
        today(),
      ).map((f) => ({ item: byId.get(f.row.id)!, rank: f.rank }));
      if (!cancelled) setData({ name: me.name.split(" ")[0], open, focus, stats: myStats(me.id, events, { today: today(), workDays: days }) });
    })().catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [store]);

  if (!data) return null;
  const { stats, open, focus } = data;
  const mood = moodFor(stats, open.length, new Date().getHours());
  const overdue = open.filter((t) => t.overdue).length;
  const title =
    props.reason === "break" ? `Gute Pause, ${data.name}!` : props.reason === "clock_in" ? `Schönen Arbeitstag, ${data.name}!` : `Hallo ${data.name}!`;
  const line =
    props.reason === "break"
      ? open.length
        ? `Erhol dich gut – danach warten noch ${open.length} ${open.length === 1 ? "Aufgabe" : "Aufgaben"} auf dich.`
        : "Erhol dich gut – du hast gerade nichts Offenes."
      : speech(mood, stats, open.length, variant);

  return (
    <div className={`nk-reminder is-${mood}`}>
      <div className="nk-reminder-top">
        <Blitzi mood={props.reason === "break" && mood === "sad" ? "sleepy" : mood} size={74} onTap={() => setVariant((v) => v + 1)} />
        <div className="nk-reminder-text">
          <b>{title}</b>
          <p>{line}</p>
        </div>
      </div>
      <div className="nk-reminder-stats">
        <span>
          <b>⚡ {stats.streak}</b> {stats.streak === 1 ? "Tag" : "Tage"} Serie
        </span>
        <span className="nk-reminder-energy">
          <Energy value={Math.min(stats.today, stats.goal)} goal={stats.goal} /> {stats.today}/{stats.goal}
        </span>
        {overdue > 0 && (
          <span className="is-bad">
            <b>{overdue}</b> überfällig
          </span>
        )}
      </div>
      {focus.length ? (
        <ol className="nk-reminder-focus">
          {focus.map(({ item, rank }) => (
            <li key={item.row.id} className={item.done ? "is-done" : ""}>
              <span className="nk-reminder-rank">{rank}</span>
              {untitled(item.row)}
            </li>
          ))}
        </ol>
      ) : (
        open.length > 0 && <p className="nk-reminder-hint">Noch kein Tagesfokus – pinne bis zu drei Aufgaben für heute an.</p>
      )}
      <div className="nk-reminder-actions">
        <button type="button" className="nk-reminder-primary" onClick={props.onOpen}>
          Zu meinen Aufgaben
        </button>
        {props.onClose && (
          <button type="button" className="nk-reminder-secondary" onClick={props.onClose}>
            Später
          </button>
        )}
      </div>
    </div>
  );
}
