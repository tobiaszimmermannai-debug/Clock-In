// Siegerehrung der Woche: Treppchen mit den Blitzis der Top 3, Medaillen, Konfetti, Scheinwerfer.
// Wird montags beim Einchecken gezeigt (ClockIn) und ist im Studio-Dashboard abrufbar.
import "./podium.css";
import type { Member } from "../types";
import { Blitzi } from "./Blitzi";
import type { LeaderRow, RankingInfo } from "./stats";

export { lastWeek, type RankingInfo } from "./stats";

const MEDAL = ["🥇", "🥈", "🥉"];
const PLACE_ORDER = [1, 0, 2]; // links Platz 2, Mitte Platz 1, rechts Platz 3

export function Podium(props: {
  rows: LeaderRow[];
  info: RankingInfo;
  stageOf: (m: Member) => number;
  me?: string;
  onClose: () => void;
}) {
  const top = props.rows.slice(0, 3);
  const rest = props.rows.slice(3, 10);
  const mine = props.me ? props.rows.find((r) => r.member.id === props.me) : undefined;
  return (
    <div className="nk-podium-backdrop" role="dialog" aria-label="Siegerehrung" onClick={(e) => e.target === e.currentTarget && props.onClose()}>
      <div className="nk-podium">
        <div className="nk-podium-lights" aria-hidden>
          <span />
          <span />
        </div>
        <div className="nk-podium-confetti" aria-hidden>
          {Array.from({ length: 24 }, (_, i) => (
            <span key={i} style={{ ["--i" as string]: i }} />
          ))}
        </div>
        <header>
          <small>Siegerehrung · {props.info.label}</small>
          <h2>🏆 Die Blitzis der Woche</h2>
          <span className="nk-podium-range">{props.info.range}</span>
        </header>
        {top.length ? (
          <div className="nk-podium-stage">
            {PLACE_ORDER.map((i) => {
              const r = top[i];
              if (!r) return <div key={i} className="nk-podium-slot is-empty" />;
              return (
                <div key={r.member.id} className={`nk-podium-slot is-${i + 1}`} style={{ ["--d" as string]: `${(2 - i) * 0.55}s` }}>
                  <div className="nk-podium-hero">
                    <span className="nk-podium-medal">{MEDAL[i]}</span>
                    <Blitzi mood={i === 0 ? "party" : "proud"} stage={props.stageOf(r.member)} size={i === 0 ? 120 : 96} still title={r.member.name} />
                  </div>
                  <div className="nk-podium-block">
                    <b>{i + 1}</b>
                    <span className="nk-podium-name">{r.member.name.split(" ")[0]}</span>
                    <span className="nk-podium-points">{r.points} ⚡</span>
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <p className="nk-podium-empty">Letzte Woche wurde nichts erledigt – diese Woche holt ihr euch das Treppchen!</p>
        )}
        {rest.length > 0 && (
          <ol className="nk-podium-rest" start={4}>
            {rest.map((r) => (
              <li key={r.member.id} className={r.member.id === props.me ? "is-me" : ""}>
                <span>{r.rank}.</span> {r.member.name} <b>{r.points} ⚡</b>
              </li>
            ))}
          </ol>
        )}
        {mine && <p className="nk-podium-mine">Du: Platz {mine.rank} mit {mine.points} {mine.points === 1 ? "Punkt" : "Punkten"} ({mine.count} Aufgaben)</p>}
        <button type="button" className="nk-podium-close" onClick={props.onClose}>
          Los geht's in die neue Woche ⚡
        </button>
      </div>
    </div>
  );
}
