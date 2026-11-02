// Studio-Dashboard: für den PC im Studio (immer offen) und für die Leitung.
// Reiter: Team (Wochen- & Monatsaufgaben mit Blitzi-Team-Szene) · Studioleitung · jede Mitarbeiterin/jeder Mitarbeiter.
import { useEffect, useMemo, useState } from "react";
import { personDay } from "../daily/status";
import { Blitzi } from "../gamification/Blitzi";
import { coinsOf, stageOf } from "../gamification/evolution";
import { FocusSection } from "../gamification/Focus";
import { BlitziCard, statsFor } from "../gamification/GamePanel";
import { lastWeek, Podium } from "../gamification/Podium";
import { daysFor, leaderboard } from "../gamification/stats";
import { allTasks, byDue, doneAtOf, tasksOf, type TaskItem } from "../gamification/tasks";
import { STUDIO_TASKS } from "../routes";
import { useNotes } from "../state";
import type { Member } from "../types";
import { addDays, storageGet, storageSet, today } from "../util";
import { isoWeek, periodLabel, periodOf } from "./period";
import { findStudioDb, STUDIO_PROPS } from "./StudioTasks";
import { useStudioRecurrence } from "./recurrence";
import { TaskLines } from "./TaskList";
import { sceneOfWeek, TeamScene } from "./TeamScene";

const byName = (a: Member, b: Member) => a.name.localeCompare(b.name, "de");
const DONE_DAYS = 14;

export function StudioDashboard() {
  const notes = useNotes();
  const pcStudio = notes.access.studio ? (notes.access.studioLocationId ?? null) : null;
  const [studioId, setStudioId] = useState<string | null>(pcStudio ?? notes.me.studioId ?? notes.locations[0]?.id ?? null);
  const [tab, setTab] = useState("team");
  const ranking = lastWeek(today());
  const [podium, setPodium] = useState(() => {
    // Studio-PC: montags einmal am Tag automatisch
    const monday = new Date().getDay() === 1;
    return monday && notes.access.studio && !storageGet<boolean>(`aun-podium-pc-${today()}`, false);
  });
  const closePodium = () => {
    storageSet(`aun-podium-pc-${today()}`, true);
    setPodium(false);
  };
  const items = useMemo(() => allTasks(notes.pages, notes.isLive), [notes.pages, notes.isLive]);
  useStudioRecurrence();

  // Am Studio-PC: nach der automatischen Abmeldung zurück zum Team-Reiter
  useEffect(() => {
    if (notes.access.studio && !notes.actor) setTab("team");
  }, [notes.access.studio, notes.actor]);

  const people = notes.members.filter((m) => !m.device && m.studioId === studioId);
  const leads = people.filter((m) => m.role === "manager").sort(byName);
  const staff = people.filter((m) => m.role !== "manager").sort(byName);
  const studioName = notes.locations.find((l) => l.id === studioId)?.name ?? "Studio";
  const openOf = (m: Member) => tasksOf(items, m.id).filter((t) => !t.done).length;
  const current = people.find((m) => m.id === tab);

  const open = (m: Member | null) => {
    setTab(m ? m.id : "team");
    // Am Studio-PC handelt, wessen Reiter offen ist (Gutschriften, Tagesaufgaben) – nur eingecheckt
    if (m && notes.access.studio && !lockedHere(m)) notes.setActor(m.id);
  };

  // Am Studio-PC: Aufgaben einer Person erst nach ihrem Einchecken (Praktikanten ohne Zeiterfassung immer)
  const lockedHere = (m: Member) => notes.access.studio && notes.unlocked !== null && !notes.unlocked.has(m.id);

  const tabButton = (m: Member, lead: boolean) => {
    const day = personDay(notes.dayStatus, m.id);
    const n = openOf(m);
    const locked = lockedHere(m);
    return (
      <button key={m.id} type="button" role="tab" aria-selected={tab === m.id} className="nk-dash-tab" onClick={() => open(m)}>
        <span className="nk-dash-tab-blitzi">
          <Blitzi mood={day?.absent ? "sleepy" : "happy"} stage={stageOf(statsFor(m.id, notes.completions, daysFor(notes.workDays, m.id)).streak)} still size={30} />
        </span>
        <span className="nk-dash-tab-text">
          {lead && <small>Studioleitung</small>}
          {m.name.split(" ")[0]}
        </span>
        {day?.absent ? (
          <span className="nk-dash-badge is-absent">-</span>
        ) : locked ? (
          <span className="nk-dash-badge is-absent" title="Noch nicht eingecheckt">
            🔒
          </span>
        ) : (
          n > 0 && <span className="nk-dash-badge">{n}</span>
        )}
      </button>
    );
  };

  return (
    <div className="nk-page is-full nk-dash">
      <div className="nk-dash-head">
        <h1>
          {studioName} <span className="nk-muted">· Aufgaben</span>
        </h1>
        <button type="button" className="nk-btn is-ghost nk-dash-podium" onClick={() => setPodium(true)}>
          🏆 Siegerehrung {ranking.label}
        </button>
        {!pcStudio && notes.locations.length > 1 && (
          <select className="nk-dash-studio" value={studioId ?? ""} onChange={(e) => (setStudioId(e.target.value), setTab("team"))} aria-label="Studio">
            {notes.locations.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
        )}
      </div>
      <nav className="nk-dash-tabs" role="tablist">
        <button type="button" role="tab" aria-selected={tab === "team"} className="nk-dash-tab is-team" onClick={() => open(null)}>
          <span className="nk-dash-tab-emoji">🤝</span>
          <span className="nk-dash-tab-text">
            <small>Wochen & Monat</small>
            Team
          </span>
        </button>
        {leads.map((m) => tabButton(m, true))}
        {staff.map((m) => tabButton(m, false))}
      </nav>
      {podium && (
        <Podium
          rows={leaderboard(notes.completions, notes.members, ranking.from, ranking.to)}
          info={ranking}
          me={notes.actor?.id}
          stageOf={(m) => stageOf(statsFor(m.id, notes.completions, daysFor(notes.workDays, m.id)).streak)}
          onClose={closePodium}
        />
      )}
      <div className="nk-dash-body">
        {current ? (
          lockedHere(current) ? (
            <div className="nk-locked is-inline">
              <Blitzi mood="sleepy" stage={stageOf(statsFor(current.id, notes.completions, daysFor(notes.workDays, current.id)).streak)} size={110} still />
              <h2>{current.name.split(" ")[0]} ist noch nicht eingecheckt</h2>
              <p>Die Aufgaben erscheinen hier, sobald {current.name.split(" ")[0]} am Tablet eingecheckt hat.</p>
            </div>
          ) : (
            <PersonTab key={current.id} member={current} items={items} />
          )
        ) : (
          <TeamTab studioId={studioId} people={people} items={items} />
        )}
      </div>
    </div>
  );
}

function TeamTab(props: { studioId: string | null; people: Member[]; items: TaskItem[] }) {
  const notes = useNotes();
  const day = today();
  const week = periodOf("week", day);
  const month = periodOf("month", day);
  const db = findStudioDb(notes.pages, notes.isLive);
  const P = STUDIO_PROPS;
  const ofPeriod = (rhythm: "week" | "month", period: string) =>
    props.items
      .filter((t) => t.db.id === db?.id && t.row.props[P.studio] === props.studioId && t.row.props[P.rhythm] === rhythm && t.row.props[P.period] === period)
      .sort((a, b) => Number(a.done) - Number(b.done) || byDue(a, b));
  const weekly = ofPeriod("week", week);
  const monthly = ofPeriod("month", month);
  const all = [...weekly, ...monthly];
  const done = all.filter((t) => t.done).length;

  // Fortschritt der Szene: Teamaufgaben – ohne Teamaufgaben die heutigen Tagesaufgaben im Studio
  const status = props.people.map((m) => personDay(notes.dayStatus, m.id)).filter((p): p is NonNullable<typeof p> => Boolean(p));
  const focusTotal = status.reduce((s, p) => s + (p.absent ? 0 : p.focus.length), 0);
  const focusDone = status.reduce((s, p) => s + (p.absent ? 0 : p.done), 0);
  const progress = all.length ? done / all.length : focusTotal ? focusDone / focusTotal : 0;
  const caption = all.length
    ? `${done} von ${all.length} Teamaufgaben erledigt (${Math.round(progress * 100)} %)`
    : focusTotal
      ? `Noch keine Teamaufgaben – heute ${focusDone} von ${focusTotal} Tagesaufgaben erledigt`
      : "Noch keine Teamaufgaben für diese Woche/diesen Monat";
  const team = props.people
    .filter((m) => !personDay(notes.dayStatus, m.id)?.absent)
    .map((member) => {
      const streak = statsFor(member.id, notes.completions, daysFor(notes.workDays, member.id)).streak;
      return { member, stage: stageOf(streak), coins: coinsOf(streak) };
    });
  const absent = props.people.filter((m) => personDay(notes.dayStatus, m.id)?.absent).map((m) => m.name.split(" ")[0]);

  return (
    <>
      {team.length > 0 ? (
        <TeamScene team={team} progress={progress} initial={sceneOfWeek(isoWeek(day).week)} caption={caption} absent={absent} />
      ) : (
        <p className="nk-muted">In diesem Studio ist noch niemand eingetragen.</p>
      )}
      <div className="nk-dash-cols">
        <section>
          <h2 className="nk-home-heading">
            🗓️ Wochenaufgaben · {periodLabel(week)} <span className="nk-muted">{weekly.filter((t) => t.done).length}/{weekly.length}</span>
          </h2>
          <TaskLines items={weekly} showWho showDb={false} empty="Keine Wochenaufgaben." />
        </section>
        <section>
          <h2 className="nk-home-heading">
            📅 Monatsaufgaben · {periodLabel(month)} <span className="nk-muted">{monthly.filter((t) => t.done).length}/{monthly.length}</span>
          </h2>
          <TaskLines items={monthly} showWho showDb={false} empty="Keine Monatsaufgaben." />
        </section>
      </div>
      {notes.access.oversee && (
        <button type="button" className="nk-btn is-ghost" onClick={() => notes.navigate(STUDIO_TASKS)}>
          ＋ Wochen- & Monatsaufgaben anlegen oder verteilen
        </button>
      )}
    </>
  );
}

function PersonTab(props: { member: Member; items: TaskItem[] }) {
  const notes = useNotes();
  const mine = tasksOf(props.items, props.member.id);
  const open = mine.filter((t) => !t.done).sort(byDue);
  const since = addDays(today(), -DONE_DAYS);
  const done = mine
    .filter((t) => t.done)
    .map((t) => ({ t, at: doneAtOf(t.row, notes.completions) ?? t.row.updatedAt }))
    .filter((x) => x.at.slice(0, 10) >= since)
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, 30)
    .map((x) => x.t);

  return (
    <>
      <div className="nk-dash-person">
        <BlitziCard member={props.member} open={open.length} />
      </div>
      <FocusSection member={props.member} />
      <section>
        <h2 className="nk-home-heading">
          ☑️ Offene Aufgaben <span className="nk-muted">{open.length}</span>
        </h2>
        <TaskLines items={open} empty="Keine offenen Aufgaben 🎉" />
      </section>
      <section>
        <h2 className="nk-home-heading">
          ✅ Erledigt <span className="nk-muted">letzte {DONE_DAYS} Tage</span>
        </h2>
        <TaskLines items={done} empty="Noch nichts erledigt." />
      </section>
    </>
  );
}
