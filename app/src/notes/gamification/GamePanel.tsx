// Blitzi-Karte (Stimmung, Serie, Akku, Wochenpunkte), Rangliste und Feier nach erledigten Aufgaben
import { useEffect, useState } from "react";
import { useNotes } from "../state";
import type { Completion, Member } from "../types";
import { today } from "../util";
import { Blitzi } from "./Blitzi";
import { leaderboard, moodFor, myStats, speech, weekStart, type MyStats } from "./stats";

/** Akku: füllt sich mit jeder erledigten Aufgabe bis zum Tagesziel */
export function Energy(props: { value: number; goal: number }) {
  const full = props.value >= props.goal;
  return (
    <div className={`nk-energy${full ? " is-full" : ""}`} role="meter" aria-valuemin={0} aria-valuemax={props.goal} aria-valuenow={props.value} aria-label="Tagesziel">
      <div className="nk-energy-cells">
        {Array.from({ length: props.goal }, (_, i) => (
          <span key={i} className={i < props.value ? "is-on" : ""} />
        ))}
      </div>
      <span className="nk-energy-cap" />
      {full && <span className="nk-energy-bolt">⚡</span>}
    </div>
  );
}

export function statsFor(userId: string, completions: Completion[], workDays: string[] | null): MyStats {
  return myStats(userId, completions, { today: today(), workDays });
}

export function BlitziCard(props: { member: Member; open: number; ownWorkDays?: boolean }) {
  const notes = useNotes();
  const [variant, setVariant] = useState(0);
  const stats = statsFor(props.member.id, notes.completions, props.ownWorkDays ? notes.workDays : null);
  const mood = moodFor(stats, props.open, new Date().getHours());
  const first = props.member.name === "Ich" ? "" : props.member.name.split(" ")[0];
  return (
    <div className={`nk-game is-${mood}`}>
      <Blitzi mood={mood} size={96} onTap={() => setVariant((v) => v + 1)} />
      <div className="nk-game-main">
        <div className="nk-bubble">
          {first && variant === 0 && mood !== "sleepy" ? `${first}! ` : ""}
          {speech(mood, stats, props.open, variant)}
        </div>
        <div className="nk-game-stats">
          <div className="nk-stat">
            <span className="nk-stat-value">⚡ {stats.streak}</span>
            <span className="nk-stat-label">{stats.streak === 1 ? "Tag Serie" : "Tage Serie"}</span>
          </div>
          <div className="nk-stat is-wide">
            <Energy value={Math.min(stats.today, stats.goal)} goal={stats.goal} />
            <span className="nk-stat-label">
              {stats.today}/{stats.goal} heute{stats.today > stats.goal ? ` (+${stats.today - stats.goal})` : ""}
            </span>
          </div>
          <div className="nk-stat">
            <span className="nk-stat-value">{stats.weekPoints}</span>
            <span className="nk-stat-label">Punkte diese Woche</span>
          </div>
        </div>
      </div>
    </div>
  );
}

const MEDALS = ["🥇", "🥈", "🥉"];

export function Leaderboard(props: { highlight?: string; limit?: number }) {
  const notes = useNotes();
  const rows = leaderboard(notes.completions, notes.members, weekStart(today()));
  const limit = props.limit ?? 5;
  const top = rows.slice(0, limit);
  const mine = rows.find((r) => r.member.id === props.highlight);
  const shown = mine && !top.includes(mine) ? [...top, mine] : top;
  const max = Math.max(1, ...rows.map((r) => r.points));
  return (
    <div className="nk-board-card">
      <div className="nk-home-heading">🏆 Rangliste dieser Woche</div>
      {shown.length ? (
        <ol className="nk-leaders">
          {shown.map((r) => (
            <li key={r.member.id} className={r.member.id === props.highlight ? "is-me" : ""}>
              <span className="nk-leader-rank">{MEDALS[r.rank - 1] ?? `${r.rank}.`}</span>
              <span className={`nk-avatar is-${r.member.color}`}>{r.member.name[0]}</span>
              <span className="nk-leader-name">{r.member.name}</span>
              <span className="nk-leader-bar">
                <span style={{ width: `${(r.points / max) * 100}%` }} />
              </span>
              <span className="nk-leader-points">{r.points}</span>
            </li>
          ))}
        </ol>
      ) : (
        <p className="nk-muted nk-leaders-empty">Noch niemand hat diese Woche etwas erledigt – hol dir Platz 1!</p>
      )}
    </div>
  );
}

/** Kurze Feier unten rechts; beim vollen Akku größer */
export function Celebration() {
  const notes = useNotes();
  const c = notes.celebration;
  const { dismissCelebration } = notes;
  useEffect(() => {
    if (!c) return;
    const t = setTimeout(dismissCelebration, c.goal ? 4500 : 2600);
    return () => clearTimeout(t);
  }, [c, dismissCelebration]);
  if (!c) return null;
  return (
    <div className={`nk-celebrate${c.goal ? " is-goal" : ""}`} role="status" onClick={dismissCelebration}>
      <div className="nk-celebrate-sparks" aria-hidden>
        {Array.from({ length: 10 }, (_, i) => (
          <span key={i} style={{ ["--i" as string]: i }} />
        ))}
      </div>
      <Blitzi mood={c.goal ? "party" : "proud"} size={c.goal ? 84 : 54} />
      <div>
        <b>{c.goal ? "Akku voll – Tagesziel geschafft!" : "Erledigt!"}</b>
        <div className="nk-celebrate-points">+{c.points} ⚡</div>
        {c.goal && c.streak > 1 && <div className="nk-muted">{c.streak} Tage Serie{c.name ? `, ${c.name}` : ""}!</div>}
      </div>
    </div>
  );
}
