// Kleine Erinnerung für Clock-In (beim Login, nach "Kommen" und zur Pause): Blitzi, Tagesfokus, Serie, offene Aufgaben.
// Lädt ohne den Editor – bleibt leichtgewichtig.
import "./reminder.css";
import { type FormEvent, useEffect, useState } from "react";
import type { Member, NotesStore, PageMeta } from "../types";
import { today, untitled } from "../util";
import { Blitzi } from "./Blitzi";
import { blitziInfo, type BlitziInfo } from "./blitzi";
import { focusTasks, MAX_FOCUS } from "./focus";
import { requestFocusTask } from "./requestFocus";
import { Energy } from "./GamePanel";
import { daysFor, moodFor, speech, type MyStats } from "./stats";
import { allTasks, byDue, tasksOf, type TaskItem } from "./tasks";

export type ReminderReason = "login" | "clock_in" | "break";

type FocusRow = { id: string; title: string; rank: number; pending: boolean; done: boolean };
type Data = {
  name: string; open: TaskItem[]; focus: FocusRow[]; stats: MyStats; blitzi: BlitziInfo;
  me: Member; pages: PageMeta[]; studio: { id: string; name: string } | null; direct: boolean;
};

const GUIDE_SEEN = "clockin-focus-guide-seen";
const guideSeen = () => {
  try {
    return localStorage.getItem(GUIDE_SEEN) === "1";
  } catch {
    return true;
  }
};

export function TaskReminder(props: { store: NotesStore; reason: ReminderReason; onOpen: () => void; onClose?: () => void }) {
  const { store } = props;
  const [data, setData] = useState<Data | null>(null);
  const [variant, setVariant] = useState(0);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  // Anleitung beim ersten Mal aufgeklappt, danach eingeklappt
  const [guideOpen] = useState(() => !guideSeen());

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const since = new Date(Date.now() - 90 * 864e5).toISOString();
      // Nicht eingecheckt: Aufgaben gesperrt – dann keine Erinnerung
      if ((await store.access()).locked) return;
      const [me, list, events, days, profiles, access, locations, here] = await Promise.all([
        store.me(),
        store.listPages(),
        store.completions(since),
        store.workDays(since),
        store.blitziProfiles?.().catch(() => []) ?? Promise.resolve([]),
        store.access(),
        store.locations().catch(() => []),
        store.hereToday?.().catch(() => ({}) as Record<string, string>) ?? Promise.resolve({} as Record<string, string>),
      ]);
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
      ).map((f) => ({ id: f.row.id, title: untitled(f.row), rank: f.rank, pending: f.pending, done: byId.get(f.row.id)?.done ?? false }));
      const blitzi = blitziInfo(me.id, events, daysFor(days, me.id), today(), profiles.find((p) => p.userId === me.id) ?? null);
      // Angefragt wird im Studio, in dem die Person heute eingecheckt ist (sonst Heimatstudio)
      const studioId = here[me.id] ?? me.studioId ?? locations[0]?.id ?? null;
      const studio = studioId ? { id: studioId, name: locations.find((l) => l.id === studioId)?.name ?? "Studio" } : null;
      if (!cancelled) setData({ name: me.name.split(" ")[0], open, focus, stats: blitzi.stats, blitzi, me, pages: list, studio, direct: access.oversee });
    })().catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [store]);

  if (!data) return null;
  const { stats, open, focus } = data;
  const free = MAX_FOCUS - focus.length;
  const canRequest = props.reason !== "break" && free > 0 && data.studio !== null;

  const request = async (e: FormEvent) => {
    e.preventDefault();
    const title = draft.trim();
    if (!title || busy || !data.studio) return;
    setBusy(true);
    setError(undefined);
    try {
      const rank = focus.length + 1;
      const row = await requestFocusTask({ store, me: data.me, pages: data.pages, studioId: data.studio.id, studioName: data.studio.name, title, rank, direct: data.direct });
      setData({ ...data, pages: [...data.pages, row], focus: [...focus, { id: row.id, title, rank, pending: !data.direct, done: false }] });
      setDraft("");
    } catch (err) {
      setError(`Anfragen hat nicht geklappt: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  };
  const markGuide = () => {
    try {
      localStorage.setItem(GUIDE_SEEN, "1");
    } catch {
      // egal
    }
  };
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
        <Blitzi
          mood={props.reason === "break" && mood === "sad" ? "sleepy" : mood}
          size={92}
          stage={data.blitzi.stage}
          items={data.blitzi.items}
          onTap={() => setVariant((v) => v + 1)}
        />
        <div className="nk-reminder-text">
          <b>{title}</b>
          <p>{line}</p>
        </div>
      </div>
      <div className="nk-reminder-stats">
        <span>
          <b>⚡ {stats.streak}</b> {stats.streak === 1 ? "Tag" : "Tage"} Serie · Stufe {data.blitzi.stage}
          {data.blitzi.prestige > 0 ? ` · Prestige ${data.blitzi.prestige}` : ""}
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
      {props.reason !== "break" ? (
        <div className="nk-reminder-day">
          <div className="nk-reminder-day-head">
            <b>📌 Deine 3 Tagesaufgaben</b>
            <span>{focus.filter((f) => f.done).length}/{MAX_FOCUS}</span>
          </div>
          <ol className="nk-reminder-focus">
            {focus.map((f) => (
              <li key={f.id} className={f.done ? "is-done" : ""}>
                <span className="nk-reminder-rank">{f.rank}</span>
                <span className="nk-reminder-title">{f.title}</span>
                {f.pending && <span className="nk-reminder-pending">⏳ wartet auf Freigabe</span>}
              </li>
            ))}
            {Array.from({ length: free }, (_, i) => (
              <li key={`free-${i}`} className="is-free">
                <span className="nk-reminder-rank">{focus.length + i + 1}</span>
                <span className="nk-reminder-title">noch frei</span>
              </li>
            ))}
          </ol>
          {canRequest && <p className="nk-reminder-hint">Schon was im Kopf? Einfach eintippen und {data.direct ? "eintragen" : "anfragen"}:</p>}
          {canRequest && (
            <form className="nk-reminder-request" onSubmit={(e) => void request(e)}>
              <input
                value={draft}
                maxLength={120}
                onChange={(e) => setDraft(e.target.value)}
                placeholder="z. B. Flyer auffüllen"
                aria-label="Tagesaufgabe anfragen"
                enterKeyHint="send"
              />
              <button type="submit" disabled={!draft.trim() || busy}>{busy ? "…" : data.direct ? "Eintragen" : "Anfragen"}</button>
            </form>
          )}
          {error && <p className="nk-reminder-error">{error}</p>}
          <details className="nk-reminder-guide" open={guideOpen} onToggle={markGuide}>
            <summary>So funktioniert's</summary>
            <ol>
              <li>Jeden Tag nach dem Einchecken: bis zu <b>3 Tagesaufgaben</b> – das, was heute zuerst drankommt.</li>
              <li>
                Schon was im Kopf? Oben eintippen und <b>{data.direct ? "Eintragen" : "Anfragen"}</b>.
                {data.direct ? " Als Leitung steht sie direkt in deinem Fokus." : " Deine Studioleitung gibt sie frei – bis dahin steht „wartet auf Freigabe“ dran."}
              </li>
              <li>Oder unter <b>Aufgaben</b> bei einer bestehenden Aufgabe auf 📌 tippen bzw. „Aufgabe anpinnen“ wählen.</li>
              <li>Abhaken bringt Punkte (1 je Aufgabe, max. 3 am Tag) – und Blitzi wächst mit deiner Serie.</li>
            </ol>
          </details>
        </div>
      ) : (
        focus.length > 0 && (
          <ol className="nk-reminder-focus">
            {focus.map((f) => (
              <li key={f.id} className={f.done ? "is-done" : ""}>
                <span className="nk-reminder-rank">{f.rank}</span>
                <span className="nk-reminder-title">{f.title}</span>
              </li>
            ))}
          </ol>
        )
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
