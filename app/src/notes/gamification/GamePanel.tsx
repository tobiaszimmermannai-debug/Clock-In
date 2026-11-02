// Blitzi-Karte (Stimmung, Serie, Akku, Wochenpunkte), Rangliste und Feier nach erledigten Aufgaben
import { useEffect, useState } from "react";
import { useNotes } from "../state";
import type { Completion, Member } from "../types";
import { Modal } from "../ui/Popover";
import { today } from "../util";
import { Blitzi } from "./Blitzi";
import { coinsOf, MAX_STAGE, stageName, stageOf, UNLOCKS } from "./evolution";
import { daysFor, leaderboard, moodFor, myStats, speech, weekStart, type MyStats } from "./stats";

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

/** Hinweis auf die nächste Stufe bzw. Münze */
export function nextStep(stats: MyStats): string {
  const maxed = stageOf(stats.streak + 1) === stageOf(stats.streak);
  if (stats.today > 0) return maxed ? "Morgen gibt's die nächste Goldmünze" : `Morgen wartet Stufe ${stageOf(stats.streak + 1)}`;
  return maxed ? "1 Aufgabe heute = 1 Goldmünze" : `1 Aufgabe heute → Stufe ${stageOf(stats.streak + 1)}`;
}

/** Alle 30 Stufen: freigeschaltete farbig, kommende als Schatten */
export function EvolutionModal(props: { streak: number; onClose: () => void }) {
  const stage = stageOf(props.streak);
  const coins = coinsOf(props.streak);
  return (
    <Modal label="Blitzis Entwicklung" onClose={props.onClose} className="nk-evo-modal">
      <div className="nk-modal-head">
        <b>⚡ Blitzis Entwicklung</b>
        <span className="nk-muted">
          Stufe {stage}/{MAX_STAGE}
          {coins > 0 ? ` · ${coins} 🪙` : ""}
        </span>
        <button type="button" className="nk-btn is-ghost nk-evo-close" onClick={props.onClose} aria-label="Schließen">
          ✕
        </button>
      </div>
      <div className="nk-evo-body">
        <ol className="nk-evo-grid">
          {Array.from({ length: MAX_STAGE }, (_, i) => i + 1).map((n) => {
            const open = n <= stage;
            return (
              <li key={n} className={`${open ? "is-open" : "is-locked"}${n === stage ? " is-current" : ""}`}>
                <Blitzi mood={open ? "happy" : "neutral"} stage={n} size={74} still locked={!open} title={open ? stageName(n) : `Stufe ${n} – noch gesperrt`} />
                <b>{n}</b>
                {UNLOCKS[n] && <small>{UNLOCKS[n]}</small>}
              </li>
            );
          })}
        </ol>
        <p className="nk-muted nk-evo-help">
          Jeder Tag deiner Serie schaltet eine Stufe frei – vom gemütlichen Sofa-Blitzi bis zum Muskelpaket. Reißt die Serie,
          fängt Blitzi wieder bei Stufe 1 an. Nur Arbeitstage zählen – freie Tage, Samstage ohne Schicht, Schule, Urlaub
          und Krank unterbrechen die Serie nie. Ab Stufe {MAX_STAGE} sitzt Blitzi für jeden weiteren Tag auf einer Goldmünze mehr.
        </p>
      </div>
    </Modal>
  );
}

export function BlitziCard(props: { member: Member; open: number }) {
  const notes = useNotes();
  const [variant, setVariant] = useState(0);
  const [evolution, setEvolution] = useState(false);
  const stats = statsFor(props.member.id, notes.completions, daysFor(notes.workDays, props.member.id));
  const mood = moodFor(stats, props.open, new Date().getHours());
  const first = props.member.name === "Ich" ? "" : props.member.name.split(" ")[0];
  const stage = stageOf(stats.streak);
  const coins = coinsOf(stats.streak);
  return (
    <div className={`nk-game is-${mood}`}>
      <div className="nk-game-hero">
        <Blitzi mood={mood} size={128} stage={stage} coins={coins} onTap={() => setVariant((v) => v + 1)} />
        <button type="button" className="nk-stage" onClick={() => setEvolution(true)} title="Alle Stufen ansehen">
          <b>
            Stufe {stage}/{MAX_STAGE}
          </b>
          <span>{stageName(stage)}</span>
          {coins > 0 && <span className="nk-stage-coins">🪙 {coins}</span>}
        </button>
      </div>
      <div className="nk-game-main">
        <div className="nk-bubble">
          {first && variant === 0 && mood !== "sleepy" ? `${first}! ` : ""}
          {speech(mood, stats, props.open, variant)}
          <span className="nk-bubble-next">{nextStep(stats)}</span>
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
            <span className="nk-stat-label" title="1 Punkt je Aufgabe, höchstens 3 pro Tag">Punkte diese Woche · max. 3/Tag</span>
          </div>
        </div>
      </div>
      {evolution && <EvolutionModal streak={stats.streak} onClose={() => setEvolution(false)} />}
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
    const t = setTimeout(dismissCelebration, c.goal || c.grew ? 4500 : 2600);
    return () => clearTimeout(t);
  }, [c, dismissCelebration]);
  if (!c) return null;
  return (
    <div className={`nk-celebrate${c.goal || c.grew ? " is-goal" : ""}`} role="status" onClick={dismissCelebration}>
      <div className="nk-celebrate-sparks" aria-hidden>
        {Array.from({ length: 10 }, (_, i) => (
          <span key={i} style={{ ["--i" as string]: i }} />
        ))}
      </div>
      <Blitzi
        mood={c.goal || c.grew ? "party" : "proud"}
        size={c.goal || c.grew ? 104 : 68}
        stage={stageOf(c.streak)}
        coins={coinsOf(c.streak)}
      />
      <div>
        <b>
          {c.grew
            ? coinsOf(c.streak) > 0
              ? "Neue Goldmünze!"
              : `Blitzi entwickelt sich – Stufe ${stageOf(c.streak)}!`
            : c.goal
              ? "Akku voll – Tagesziel geschafft!"
              : "Erledigt!"}
        </b>
        <div className="nk-celebrate-points">{c.points > 0 ? `+${c.points} ⚡` : "⚡ Tagesmaximum (3 Punkte) erreicht – zählt für die Serie"}</div>
        {c.grew && coinsOf(c.streak) === 0 && <div className="nk-muted">{stageName(stageOf(c.streak))}</div>}
        {!c.grew && c.goal && c.streak > 1 && <div className="nk-muted">{c.streak} Tage Serie{c.name ? `, ${c.name}` : ""}!</div>}
      </div>
    </div>
  );
}
