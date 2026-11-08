// Team-Szene: alle Blitzis des Studios lösen gemeinsam eine Aufgabe – je erledigter Teamaufgabe geht es voran.
// Stärke = Blitzis Entwicklungsstufe (Serie); stärkere Blitzis sind größer und tragen mehr bei.
// 10 Aktionen (Bühnenbilder in sceneArt.tsx), jede Woche eine andere (mit ◀ ▶ durchblättern).
import { useId, useState } from "react";
import { Blitzi } from "../gamification/Blitzi";
import { MAX_STAGE } from "../gamification/evolution";
import type { Member } from "../types";
import { SCENES } from "./sceneArt";

export { SCENES } from "./sceneArt";
export type TeamMate = { member: Member; stage: number; items?: string[] };

/** ISO-Kalenderwoche → Aktion der Woche */
export function sceneOfWeek(isoWeek: number) {
  return ((isoWeek % SCENES.length) + SCENES.length) % SCENES.length;
}

export function TeamScene(props: {
  team: TeamMate[];
  /** 0 … 1 */
  progress: number;
  initial: number;
  caption: string;
  absent?: string[];
  /** klein am Rand (Seitenleiste) statt groß über den Aufgaben */
  compact?: boolean;
}) {
  const id = useId().replace(/[^a-zA-Z0-9]/g, "");
  const ids = { sky: `${id}-sky`, water: `${id}-water` };
  const [index, setIndex] = useState(props.initial);
  const scene = SCENES[index];
  const p = Math.max(0, Math.min(1, props.progress));
  // Stärkste vorne (bzw. am wichtigsten Platz)
  const team = [...props.team].sort((a, b) => b.stage - a.stage || a.member.name.localeCompare(b.member.name, "de"));
  const total = team.reduce((s, t) => s + t.stage, 0) || 1;
  const frame = scene.draw(p, Math.max(1, team.length), ids);
  const won = p >= 1;
  const sizeOf = (stage: number) => 8.5 + (4 * (stage - 1)) / (MAX_STAGE - 1); // Prozent der Breite

  return (
    <section className={`nk-scene${won ? " is-won" : ""}${props.compact ? " is-compact" : ""}`}>
      <header className="nk-scene-head">
        <button type="button" className="nk-icon-btn" aria-label="Vorige Aktion" onClick={() => setIndex((index + SCENES.length - 1) % SCENES.length)}>
          ◀
        </button>
        <div className="nk-scene-title">
          <b>{scene.title}</b>
          <span>{won ? scene.done : scene.goal}</span>
        </div>
        <button type="button" className="nk-icon-btn" aria-label="Nächste Aktion" onClick={() => setIndex((index + 1) % SCENES.length)}>
          ▶
        </button>
      </header>
      <div className="nk-scene-stage">
        <svg className="nk-scene-svg" viewBox="0 0 1000 400" aria-hidden>
          <defs>
            <linearGradient id={ids.sky} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="#bfe3ff" />
              <stop offset="1" stopColor="#eef8ff" />
            </linearGradient>
            <linearGradient id={ids.water} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="#5fb4ef" />
              <stop offset="1" stopColor="#2f7fc0" />
            </linearGradient>
          </defs>
          {frame.back}
        </svg>
        {team.map((t, i) => {
          const spot = frame.spots[i];
          if (!spot) return null;
          const width = sizeOf(t.stage) * (spot.scale ?? 1);
          return (
            <div
              key={t.member.id}
              className={`nk-scene-mate ${spot.cls ?? ""}`}
              style={{ left: `${spot.x / 10}%`, top: `${spot.y / 4}%`, width: `${width}%`, ["--i" as string]: i }}
              title={`${t.member.name} · Stufe ${t.stage} · trägt ${Math.round((t.stage / total) * 100)} % bei`}
            >
              <Blitzi mood={won ? "party" : "happy"} stage={t.stage} items={t.items} still fluid noShadow title={t.member.name} />
              <span className="nk-scene-name">{t.member.name.split(" ")[0]}</span>
            </div>
          );
        })}
        {frame.front && (
          <svg className="nk-scene-svg is-front" viewBox="0 0 1000 400" aria-hidden>
            {frame.front}
          </svg>
        )}
        {won && <div className="nk-scene-confetti" aria-hidden>{Array.from({ length: 16 }, (_, i) => <span key={i} style={{ ["--i" as string]: i }} />)}</div>}
      </div>
      <footer className="nk-scene-foot">
        <div className="nk-scene-bar" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(p * 100)}>
          <span style={{ width: `${p * 100}%` }} />
        </div>
        <span>{props.caption}</span>
        <span className="nk-scene-power">
          💪 {team.map((t) => `${t.member.name.split(" ")[0]} ${Math.round((t.stage / total) * 100)} %`).join(" · ")}
        </span>
        {props.absent && props.absent.length > 0 && <span className="nk-muted">Heute nicht dabei: {props.absent.join(", ")}</span>}
      </footer>
    </section>
  );
}
