// Blitzi-Karte (Stimmung, Serie, Akku, Wochenpunkte), Rangliste und Feier nach erledigten Aufgaben
import { useState } from "react";
import { useNotes } from "../state";
import type { Completion, Member } from "../types";
import { Modal } from "../ui/Popover";
import { today } from "../util";
import { Blitzi } from "./Blitzi";
import { MAX_PRESTIGE, MAX_STAGE, stageName, stageOf, UNLOCKS } from "./evolution";
import { blitziName } from "./items";
import { PrestigeModal } from "./Prestige";
import { RewardOverlay } from "./Reward";
import { fmtAvg, moodFor, myStats, speech, teamLeaderboard, weekStart, type MyStats } from "./stats";

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

/** Hinweis auf die nächste Stufe bzw. das Prestige */
export function nextStep(stats: MyStats, stage = stageOf(stats.streak)): string {
  if (stage >= MAX_STAGE) return "Stufe 30 – such dir ein Item aus (Prestige)!";
  if (stats.today > 0) return `Morgen wartet Stufe ${stage + 1}`;
  return `1 Aufgabe heute → Stufe ${stage + 1}`;
}

/** Alle 30 Stufen: freigeschaltete farbig, kommende als Schatten */
export function EvolutionModal(props: { stage: number; prestige: number; items: string[]; onClose: () => void }) {
  const { stage } = props;
  return (
    <Modal label="Blitzis Entwicklung" onClose={props.onClose} className="nk-evo-modal">
      <div className="nk-modal-head">
        <b>⚡ Blitzis Entwicklung</b>
        <span className="nk-muted">
          Stufe {stage}/{MAX_STAGE}
          {props.prestige > 0 ? ` · Prestige ${props.prestige}` : ""}
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
                <Blitzi mood={open ? "happy" : "neutral"} stage={n} items={props.items} size={74} still locked={!open} title={open ? stageName(n) : `Stufe ${n} – noch gesperrt`} />
                <b>{n}</b>
                {UNLOCKS[n] && <small>{UNLOCKS[n]}</small>}
              </li>
            );
          })}
        </ol>
        <p className="nk-muted nk-evo-help">
          Jeder Tag deiner Serie schaltet eine Stufe frei – vom gemütlichen Sofa-Blitzi bis zum Muskelpaket. Reißt die Serie,
          fängt Blitzi wieder bei Stufe 1 an. Nur Arbeitstage zählen – freie Tage, Samstage ohne Schicht, Schule, Urlaub
          und Krank unterbrechen die Serie nie. Auf Stufe {MAX_STAGE} wählst du ein Item aus 100 (Prestige): Es bleibt für immer,
          und Blitzi startet wieder bei Stufe 1. Beim ersten Mal bekommt Blitzi einen Spitznamen.
        </p>
      </div>
    </Modal>
  );
}

/** Darf ich für diese Person das Prestige auslösen? Selbst, oder am Studio-PC die gerade gewählte Person */
export function canPrestige(notes: ReturnType<typeof useNotes>, member: Member) {
  if (member.device) return false;
  return notes.access.studio ? notes.actor?.id === member.id : notes.me.id === member.id;
}

export function BlitziCard(props: { member: Member; open: number }) {
  const notes = useNotes();
  const [variant, setVariant] = useState(0);
  const [evolution, setEvolution] = useState(false);
  const [shop, setShop] = useState(false);
  const info = notes.blitzi(props.member.id);
  const stats = info.stats;
  const mood = moodFor(stats, props.open, new Date().getHours());
  const first = props.member.name === "Ich" ? "" : (info.nickname ?? props.member.name.split(" ")[0]);
  const stage = info.stage;
  const ready = stage >= MAX_STAGE && info.prestige < MAX_PRESTIGE && canPrestige(notes, props.member);
  return (
    <div className={`nk-game is-${mood}`}>
      <div className="nk-game-hero">
        <Blitzi mood={mood} size={128} stage={stage} items={info.items} onTap={() => setVariant((v) => v + 1)} />
        <button type="button" className="nk-stage" onClick={() => setEvolution(true)} title="Alle Stufen ansehen">
          <b>
            Stufe {stage}/{MAX_STAGE}
          </b>
          <span>{stageName(stage)}</span>
          {info.prestige > 0 && <span className="nk-stage-prestige">Prestige {info.prestige}</span>}
        </button>
        {info.nickname && <span className="nk-blitzi-name">{blitziName(props.member.name, info.nickname)}</span>}
        {ready && (
          <button type="button" className="nk-btn is-primary nk-prestige-btn" onClick={() => setShop(true)}>
            🎁 Item wählen
          </button>
        )}
      </div>
      <div className="nk-game-main">
        <div className="nk-bubble">
          {first && variant === 0 && mood !== "sleepy" ? `${first}! ` : ""}
          {speech(mood, stats, props.open, variant)}
          <span className="nk-bubble-next">{nextStep(stats, stage)}</span>
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
            <span className="nk-stat-label" title="1 Punkt je Aufgabe, höchstens 3 pro Tag, +1 für die Ausstempel-Statistik">Punkte diese Woche</span>
          </div>
        </div>
      </div>
      {evolution && <EvolutionModal stage={stage} prestige={info.prestige} items={info.items} onClose={() => setEvolution(false)} />}
      {shop && <PrestigeModal member={props.member} onClose={() => setShop(false)} />}
    </div>
  );
}

const MEDALS = ["🥇", "🥈", "🥉"];

/** Live-Team-Rangliste dieser Woche: Punkteschnitt je Studio (gleiche Chancen für jedes Studio) */
export function Leaderboard(props: { highlight?: string; limit?: number; studioId?: string | null; title?: string }) {
  const notes = useNotes();
  const rows = teamLeaderboard(notes.completions, notes.members, notes.locations, weekStart(today()));
  const mine = props.studioId ?? notes.members.find((m) => m.id === props.highlight)?.studioId ?? null;
  const max = Math.max(0.1, ...rows.map((r) => r.avg));
  return (
    <div className="nk-board-card">
      <div className="nk-home-heading">{props.title ?? "🏆 Team-Rangliste dieser Woche"}</div>
      {rows.length ? (
        <ol className="nk-leaders">
          {rows.slice(0, props.limit ?? rows.length).map((r) => (
            <li key={r.studio.id} className={r.studio.id === mine ? "is-me" : ""}>
              <span className="nk-leader-rank">{r.avg > 0 ? (MEDALS[r.rank - 1] ?? `${r.rank}.`) : `${r.rank}.`}</span>
              <span className="nk-leader-name">{r.studio.name.replace(/^Studio\s+/, "")}</span>
              <span className="nk-leader-bar">
                <span style={{ width: `${(r.avg / max) * 100}%` }} />
              </span>
              <span className="nk-leader-points" title={`${r.points} Punkte · ${r.people} Personen`}>Ø {fmtAvg(r.avg)}</span>
            </li>
          ))}
        </ol>
      ) : (
        <p className="nk-muted nk-leaders-empty">Noch keine Studios.</p>
      )}
      <p className="nk-muted nk-leaders-help">Wochenpunkte aller ÷ Anzahl Personen je Studio – jedes Studio hat dieselbe Chance.</p>
    </div>
  );
}

/** Belohnung nach dem Abhaken: Overlay mit dem persönlichen Blitzi (zufällige Animation, Lichtsäule beim Aufstieg) */
export function Celebration() {
  const notes = useNotes();
  const c = notes.celebration;
  if (!c) return null;
  const person = notes.members.find((m) => m.id === c.memberId);
  const name = blitziName(person?.name ?? c.name, c.nickname);
  const headline = c.levelUp
    ? c.stage >= MAX_STAGE
      ? "Stufe 30 – such dir ein Item aus!"
      : `Blitzi entwickelt sich – Stufe ${c.stage}!`
    : c.goal
      ? "Akku voll – Tagesziel geschafft!"
      : undefined;
  const line = [
    c.points > 0 ? `+${c.points} ⚡` : "⚡ Tagesmaximum (3 Punkte) erreicht – zählt für die Serie",
    c.levelUp ? stageName(c.stage) : "",
    !c.levelUp && c.goal && c.streak > 1 ? `${c.streak} Tage Serie!` : "",
    c.prestige > 0 ? `Prestige ${c.prestige}` : "",
  ].filter(Boolean).join(" · ");
  return (
    <RewardOverlay key={c.id} stage={c.stage} items={c.items} name={name} headline={headline} line={line} levelUp={c.levelUp}
      onClose={notes.dismissCelebration} />
  );
}
