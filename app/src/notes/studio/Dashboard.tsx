// Studio-Dashboard: für den PC im Studio (immer offen), für die Leitung und für alle im eigenen Studio.
// Reiter: Team (Wochen- & Monatsaufgaben) · Ranking (Team-Wertung) · Statistik · Studioleitung · Personen (+ Aushilfen).
// Rechts: Live-Team-Rangliste und die Blitzi-Team-Szene (klein am Rand).
// Studio: am Studio-PC immer das Studio des Geräts (kein Ersatz-Studio); sonst das Studio, in dem man heute
// eingecheckt ist (Aushilfe), sonst das Heimatstudio. Nur Admins wählen frei.
import { useEffect, useMemo, useState } from "react";
import { personDay } from "../daily/status";
import { Blitzi } from "../gamification/Blitzi";
import { FocusSection } from "../gamification/Focus";
import { BlitziCard, Leaderboard } from "../gamification/GamePanel";
import { blitziName } from "../gamification/items";
import { lastWeek, TeamPodium } from "../gamification/Podium";
import { fmtAvg, leaderboard, teamLeaderboard, weekStart } from "../gamification/stats";
import { allTasks, byDue, doneAtOf, tasksOf, type TaskItem } from "../gamification/tasks";
import { STUDIO_TASKS } from "../routes";
import { useNotes } from "../state";
import type { Member } from "../types";
import { addDays, shortId, storageGet, storageSet, today } from "../util";
import { isoWeek, periodLabel, periodOf, periodRange } from "./period";
import { createStudioRow, creatableStudios, ensureStudioDb, findStudioDb, RHYTHM_OWNER, STUDIO_PROPS } from "./studioDb";
import { QuickAdd } from "./QuickAdd";
import { useStudioRecurrence } from "./recurrence";
import { StatisticsTab } from "./Statistics";
import { TaskLines } from "./TaskList";
import { sceneOfWeek, TeamScene } from "./TeamScene";

const byName = (a: Member, b: Member) => a.name.localeCompare(b.name, "de");
/** Erledigtes bleibt bis einschließlich 1 Tag nach dem Erledigen im Aufgabenbereich, danach im Archiv */
export const DONE_VISIBLE_DAYS = 1;

/** Ist die Aufgabe (erledigt am …) noch im Aufgabenbereich (sonst Archiv)? */
export const stillVisible = (doneAt: string, day = today()) => doneAt.slice(0, 10) >= addDays(day, -DONE_VISIBLE_DAYS);

export function StudioDashboard() {
  const notes = useNotes();
  const pc = notes.access.studio;
  const pcStudio = pc ? (notes.access.studioLocationId ?? null) : null;
  const meHere = notes.members.find((m) => m.id === notes.me.id);
  // Am PC immer das Studio des Geräts; sonst heute eingecheckt (Aushilfe) bzw. Heimatstudio
  const ownStudio = pc ? pcStudio : (meHere?.hereId ?? notes.me.studioId ?? meHere?.studioId ?? null);
  const [chosen, setChosen] = useState<string | null>(null);
  const studioId = notes.access.admin && !pc ? (chosen ?? ownStudio ?? notes.locations[0]?.id ?? null) : ownStudio;
  const [tab, setTab] = useState("team");
  const ranking = lastWeek(today());
  const [podium, setPodium] = useState(() => {
    // Studio-PC: montags einmal am Tag automatisch
    const monday = new Intl.DateTimeFormat("en-US", { timeZone: "Europe/Berlin", weekday: "short" }).format(new Date()) === "Mon";
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
  // Aushilfen: heute hier eingecheckt, Heimatstudio woanders
  const guests = notes.members.filter((m) => !m.device && m.hereId === studioId && m.studioId !== studioId).sort(byName);
  const leads = people.filter((m) => m.role === "manager").sort(byName);
  const staff = people.filter((m) => m.role !== "manager").sort(byName);
  const studioName = notes.locations.find((l) => l.id === studioId)?.name ?? "Studio";
  const openOf = (m: Member) => tasksOf(items, m.id).filter((t) => !t.done).length;
  const current = [...people, ...guests].find((m) => m.id === tab);

  const open = (m: Member | null) => {
    setTab(m ? m.id : "team");
    // Am Studio-PC handelt, wessen Reiter offen ist (Gutschriften, Tagesaufgaben) – nur eingecheckt
    if (m && notes.access.studio && !lockedHere(m)) notes.setActor(m.id);
  };

  // Am Studio-PC: Aufgaben einer Person erst nach ihrem Einchecken (Praktikanten ohne Zeiterfassung immer)
  const lockedHere = (m: Member) => notes.access.studio && notes.unlocked !== null && !notes.unlocked.has(m.id);

  const tabButton = (m: Member, lead: boolean, guest = false) => {
    const day = personDay(notes.dayStatus, m.id);
    const n = openOf(m);
    const locked = lockedHere(m);
    return (
      <button key={m.id} type="button" role="tab" aria-selected={tab === m.id} className="nk-dash-tab" onClick={() => open(m)}>
        <span className="nk-dash-tab-blitzi">
          <Blitzi mood={day?.absent ? "sleepy" : "happy"} stage={notes.blitzi(m.id).stage} items={notes.blitzi(m.id).items} still size={30} />
        </span>
        <span className="nk-dash-tab-text">
          {lead && <small>Studioleitung</small>}
          {guest && <small>Aushilfe</small>}
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

  if (pc && !pcStudio) {
    return (
      <div className="nk-page is-full nk-dash">
        <div className="nk-locked is-inline">
          <Blitzi mood="sad" stage={1} size={110} still />
          <h2>Dieses PC-Terminal hat kein Studio hinterlegt</h2>
          <p>Bitte in der Verwaltung (Einstellungen → Tablets & PCs) dem PC ein Studio zuordnen.</p>
        </div>
      </div>
    );
  }
  if (!studioId) {
    return (
      <div className="nk-page is-full nk-dash">
        <p className="nk-muted">Dir ist noch kein Studio zugeordnet.</p>
      </div>
    );
  }
  const teams = teamLeaderboard(notes.completions, notes.members, notes.locations, ranking.from, ranking.to);
  const heroes = (sid: string) => {
    const board = leaderboard(notes.completions, notes.members, ranking.from, ranking.to);
    return board
      .filter((r) => r.member.studioId === sid && r.member.role !== "admin")
      .map((r) => ({ member: r.member, stage: notes.blitzi(r.member.id).stage, items: notes.blitzi(r.member.id).items }));
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
        {notes.access.admin && !pc && notes.locations.length > 1 && (
          <select className="nk-dash-studio" value={studioId ?? ""} onChange={(e) => (setChosen(e.target.value), setTab("team"))} aria-label="Studio">
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
        <button type="button" role="tab" aria-selected={tab === "ranking"} className="nk-dash-tab is-team" onClick={() => setTab("ranking")}>
          <span className="nk-dash-tab-emoji">🏆</span>
          <span className="nk-dash-tab-text">
            <small>Team-Wertung</small>
            Ranking
          </span>
        </button>
        <button type="button" role="tab" aria-selected={tab === "stats"} className="nk-dash-tab is-team" onClick={() => setTab("stats")}>
          <span className="nk-dash-tab-emoji">📊</span>
          <span className="nk-dash-tab-text">
            <small>Ausstempeln</small>
            Statistik
          </span>
        </button>
        {leads.map((m) => tabButton(m, true))}
        {staff.map((m) => tabButton(m, false))}
        {guests.map((m) => tabButton(m, false, true))}
      </nav>
      {podium && (
        <TeamPodium teams={teams} info={ranking} heroes={heroes} myStudio={studioId} onClose={closePodium} />
      )}
      <div className="nk-dash-layout">
      <div className="nk-dash-body">
        {tab === "ranking" ? (
          <RankingTab studioId={studioId} />
        ) : tab === "stats" ? (
          <StatisticsTab />
        ) : current ? (
          lockedHere(current) ? (
            <div className="nk-locked is-inline">
              <Blitzi mood="sleepy" stage={notes.blitzi(current.id).stage} items={notes.blitzi(current.id).items} size={110} still />
              <h2>{current.name.split(" ")[0]} ist noch nicht eingecheckt</h2>
              <p>Die Aufgaben erscheinen hier, sobald {current.name.split(" ")[0]} am Tablet eingecheckt hat.</p>
            </div>
          ) : (
            <PersonTab key={current.id} member={current} items={items} />
          )
        ) : (
          <TeamTab studioId={studioId} studioName={studioName} people={people} items={items} />
        )}
      </div>
      <aside className="nk-dash-aside">
        <Leaderboard studioId={studioId} title="🏆 Team-Rangliste live" />
        {tab === "team" && <TeamSceneSide studioId={studioId} people={[...people, ...guests]} items={items} />}
      </aside>
      </div>
    </div>
  );
}

/** Team-Szene klein am Rand: Fortschritt der Team-Aufgaben mit allen Blitzis des Studios */
function TeamSceneSide(props: { studioId: string; people: Member[]; items: TaskItem[] }) {
  const notes = useNotes();
  const day = today();
  const db = findStudioDb(notes.pages, notes.isLive);
  const P = STUDIO_PROPS;
  const week = periodOf("week", day);
  const month = periodOf("month", day);
  const all = props.items.filter(
    (t) => t.db.id === db?.id && t.row.props[P.studio] === props.studioId
      && ((t.row.props[P.rhythm] === "week" && t.row.props[P.period] === week) || (t.row.props[P.rhythm] === "month" && t.row.props[P.period] === month)),
  );
  const done = all.filter((t) => t.done).length;
  const status = props.people.map((m) => personDay(notes.dayStatus, m.id)).filter((p): p is NonNullable<typeof p> => Boolean(p));
  const focusTotal = status.reduce((s, p) => s + (p.absent ? 0 : p.focus.length), 0);
  const focusDone = status.reduce((s, p) => s + (p.absent ? 0 : p.done), 0);
  const progress = all.length ? done / all.length : focusTotal ? focusDone / focusTotal : 0;
  const caption = all.length ? `${done}/${all.length} Teamaufgaben` : focusTotal ? `${focusDone}/${focusTotal} Tagesaufgaben` : "Noch keine Teamaufgaben";
  const team = props.people
    .filter((m) => !personDay(notes.dayStatus, m.id)?.absent)
    .map((member) => ({ member, stage: notes.blitzi(member.id).stage, items: notes.blitzi(member.id).items }));
  const absent = props.people.filter((m) => personDay(notes.dayStatus, m.id)?.absent).map((m) => m.name.split(" ")[0]);
  if (!team.length) return null;
  return <TeamScene team={team} progress={progress} initial={sceneOfWeek(isoWeek(day).week)} caption={caption} absent={absent} compact />;
}

/** Reiter „Ranking“: Wochenwertung der Studios ausführlich + persönliche Punkte im eigenen Studio */
function RankingTab(props: { studioId: string }) {
  const notes = useNotes();
  const from = weekStart(today());
  const teams = teamLeaderboard(notes.completions, notes.members, notes.locations, from);
  const board = leaderboard(notes.completions, notes.members, from);
  const mine = notes.members
    .filter((m) => !m.device && m.role !== "admin" && m.studioId === props.studioId)
    .map((m) => ({ m, row: board.find((r) => r.member.id === m.id) }))
    .sort((a, b) => (b.row?.points ?? 0) - (a.row?.points ?? 0) || a.m.name.localeCompare(b.m.name, "de"));
  const short = (name: string) => name.replace(/^Studio\s+/, "");
  return (
    <div className="nk-ranking">
      <section>
        <h2 className="nk-home-heading">🏆 Team-Wertung dieser Woche</h2>
        <p className="nk-muted">Wochenpunkte aller Personen eines Studios ÷ Anzahl der Personen. Gleichstand: mehr Aufgaben je Person, dann Studio-Name.</p>
        <div className="nk-stats-table-wrap">
        <table className="nk-stats-table nk-ranking-table">
          <thead>
            <tr>
              <th>Platz</th>
              <th>Studio</th>
              <th className="num">Ø Punkte</th>
              <th className="num">Punkte</th>
              <th className="num">Personen</th>
              <th className="num">Ø Aufgaben</th>
            </tr>
          </thead>
          <tbody>
            {teams.map((t) => (
              <tr key={t.studio.id} className={t.studio.id === props.studioId ? "is-me" : ""}>
                <td>{t.avg > 0 ? (["🥇", "🥈", "🥉"][t.rank - 1] ?? `${t.rank}.`) : `${t.rank}.`}</td>
                <td>{short(t.studio.name)}</td>
                <td className="num"><b>{fmtAvg(t.avg)}</b></td>
                <td className="num">{t.points}</td>
                <td className="num">{t.people}</td>
                <td className="num">{fmtAvg(t.avgCount)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      </section>
      <section>
        <h2 className="nk-home-heading">⚡ Punkte im Studio {short(notes.locations.find((l) => l.id === props.studioId)?.name ?? "")}</h2>
        <ol className="nk-leaders">
          {mine.map(({ m, row }, i) => {
            const b = notes.blitzi(m.id);
            return (
              <li key={m.id} className={m.id === notes.me.id || m.id === notes.actor?.id ? "is-me" : ""}>
                <span className="nk-leader-rank">{i + 1}.</span>
                <Blitzi mood="happy" stage={b.stage} items={b.items} size={28} still />
                <span className="nk-leader-name">{blitziName(m.name, b.nickname)}</span>
                <span className="nk-leader-points">{row?.points ?? 0} ⚡ · {row?.count ?? 0} Aufg.</span>
              </li>
            );
          })}
        </ol>
      </section>
    </div>
  );
}

function TeamTab(props: { studioId: string | null; studioName: string; people: Member[]; items: TaskItem[] }) {
  const notes = useNotes();
  // Wochenaufgaben legt das Studio selbst an (Studioleitung, Studio-PC) – ohne Freigabe; Monatsaufgaben Tobias & Dominik
  const canAddWeek = props.studioId !== null && creatableStudios(notes.access, notes.me, notes.locations, "week").includes(props.studioId);
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
  const absent = props.people.filter((m) => personDay(notes.dayStatus, m.id)?.absent).map((m) => m.name.split(" ")[0]);

  return (
    <>
      {props.people.length === 0 && <p className="nk-muted">In diesem Studio ist noch niemand eingetragen.</p>}
      <p className="nk-muted nk-dash-caption">{caption}{absent.length ? ` · heute nicht dabei: ${absent.join(", ")}` : ""}</p>
      <div className="nk-dash-cols">
        <section>
          <h2 className="nk-home-heading">
            🗓️ Wochenaufgaben · {periodLabel(week)} <span className="nk-muted">{weekly.filter((t) => t.done).length}/{weekly.length}</span>
          </h2>
          <p className="nk-dash-owner">von der {RHYTHM_OWNER.week}</p>
          {canAddWeek && props.studioId && <WeekAdd studioId={props.studioId} studioName={props.studioName} />}
          <TaskLines items={weekly} showWho showDb={false} empty="Keine Wochenaufgaben." />
        </section>
        <section>
          <h2 className="nk-home-heading">
            📅 Monatsaufgaben · {periodLabel(month)} <span className="nk-muted">{monthly.filter((t) => t.done).length}/{monthly.length}</span>
          </h2>
          <p className="nk-dash-owner">von {RHYTHM_OWNER.month}</p>
          <TaskLines items={monthly} showWho showDb={false} empty="Keine Monatsaufgaben." />
        </section>
      </div>
      {(notes.access.oversee || canAddWeek) && (
        <button type="button" className="nk-btn is-ghost" onClick={() => notes.navigate(STUDIO_TASKS)}>
          {notes.access.admin ? "＋ Wochen- & Monatsaufgaben anlegen oder verteilen" : "🗓️ Alle Wochen- & Monatsaufgaben ansehen"}
        </button>
      )}
    </>
  );
}

function PersonTab(props: { member: Member; items: TaskItem[] }) {
  const notes = useNotes();
  const mine = tasksOf(props.items, props.member.id);
  const open = mine.filter((t) => !t.done).sort(byDue);
  const finished = mine
    .filter((t) => t.done)
    .map((t) => ({ t, at: doneAtOf(t.row, notes.completions) ?? t.row.updatedAt }));
  const done = finished
    .filter((x) => stillVisible(x.at))
    .sort((a, b) => b.at.localeCompare(a.at))
    .map((x) => x.t);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [newestFirst, setNewestFirst] = useState(true);
  const archive = finished
    .filter((x) => !stillVisible(x.at))
    .sort((a, b) => (newestFirst ? b.at.localeCompare(a.at) : a.at.localeCompare(b.at)));

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
        <QuickAdd member={props.member} />
        <TaskLines items={open} empty="Keine offenen Aufgaben 🎉" />
      </section>
      <section>
        <h2 className="nk-home-heading">
          ✅ Erledigt <span className="nk-muted">heute und gestern</span>
        </h2>
        <TaskLines items={done} empty="Noch nichts erledigt." />
      </section>
      <section className="nk-archive">
        <h2 className="nk-home-heading">
          <button type="button" className="nk-btn is-ghost" onClick={() => setArchiveOpen((o) => !o)} aria-expanded={archiveOpen}>
            🗄️ Archiv <span className="nk-muted">{archive.length}</span> {archiveOpen ? "▾" : "▸"}
          </button>
          {archiveOpen && archive.length > 1 && (
            <button type="button" className="nk-btn is-ghost nk-archive-sort" onClick={() => setNewestFirst((v) => !v)}>
              {newestFirst ? "Neueste zuerst ▼" : "Älteste zuerst ▲"}
            </button>
          )}
        </h2>
        {archiveOpen && (
          <ul className="nk-archive-list">
            {archive.map(({ t, at }) => (
              <li key={t.row.id}>
                <time>{new Date(at).toLocaleDateString("de-DE", { weekday: "short", day: "2-digit", month: "2-digit", year: "numeric" })}</time>
                <TaskLines items={[t]} empty="" />
              </li>
            ))}
            {archive.length === 0 && <li className="nk-muted">Noch nichts im Archiv.</li>}
          </ul>
        )}
      </section>
    </>
  );
}

/** Wochenaufgabe fürs Studio direkt anlegen (diese Woche, fällig Sonntag) */
function WeekAdd(props: { studioId: string; studioName: string }) {
  const notes = useNotes();
  const [text, setText] = useState("");
  const [repeat, setRepeat] = useState(false);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    const title = text.trim();
    if (!title || busy) return;
    setBusy(true);
    try {
      const db = await ensureStudioDb(notes);
      const period = periodOf("week", today());
      await createStudioRow(notes, db, { title, studio: props.studioId, rhythm: "week", period, group: shortId(), due: periodRange(period).end, repeat });
      setText("");
      notes.toast(`Wochenaufgabe „${title}“ angelegt`);
    } catch {
      // Fehlermeldung zeigt createPage bereits an
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="nk-quickadd"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <span aria-hidden>＋</span>
      <input value={text} onChange={(e) => setText(e.target.value)} placeholder={`Neue Wochenaufgabe für ${props.studioName} …`} aria-label="Neue Wochenaufgabe" />
      <label className="nk-quickadd-flag" title="Jede Woche automatisch neu anlegen">
        <input type="checkbox" checked={repeat} onChange={(e) => setRepeat(e.target.checked)} /> 🔁 jede Woche
      </label>
      <button type="submit" className="nk-btn is-primary" disabled={!text.trim() || busy}>
        {busy ? "…" : "Anlegen"}
      </button>
    </form>
  );
}
