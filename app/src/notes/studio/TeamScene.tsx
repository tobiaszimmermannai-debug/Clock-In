// Team-Szene: alle Blitzis des Studios lösen gemeinsam eine Aufgabe – je erledigter Teamaufgabe geht es voran.
// Stärke = Blitzis Entwicklungsstufe (Serie); stärkere Blitzis sind größer und tragen mehr bei.
// 10 Aktionen, jede Woche eine andere (mit ◀ ▶ durchblättern).
import { type ReactNode, useId, useState } from "react";
import { Blitzi } from "../gamification/Blitzi";
import { MAX_STAGE } from "../gamification/evolution";
import type { Member } from "../types";

export type TeamMate = { member: Member; stage: number; coins: number };
type Spot = { x: number; y: number; cls?: string; scale?: number };
type Frame = { back: ReactNode; front?: ReactNode; spots: Spot[] };
type Scene = { id: string; title: string; goal: string; done: string; draw: (p: number, n: number, ids: Ids) => Frame };
type Ids = { sky: string; water: string };

const W = 1000;
const GROUND = 336;

const spread = (n: number, from: number, to: number) =>
  n <= 0 ? [] : n === 1 ? [(from + to) / 2] : Array.from({ length: n }, (_, i) => from + ((to - from) * i) / (n - 1));
const gap = (n: number, max: number, room: number) => Math.min(max, room / Math.max(1, n));
/** Abstand, damit n Figuren hintereinander in den Platz passen (nie aus dem Bild) */
const fit = (n: number, max: number, room: number) => Math.max(18, Math.min(max, room / Math.max(1, n - 1)));

const sky = (ids: Ids, ground = "#9bd36b") => (
  <>
    <rect width={W} height="400" fill={`url(#${ids.sky})`} />
    <circle cx="880" cy="70" r="34" fill="#ffe680" opacity="0.9" />
    <path d="M120 80 q20 -22 44 -6 q16 -16 36 2 q20 0 18 16 h-104 q-10 -10 6 -12z" fill="#fff" opacity="0.85" />
    <path d="M560 56 q16 -18 36 -5 q14 -12 30 2 q16 0 14 13 h-86 q-8 -8 6 -10z" fill="#fff" opacity="0.7" />
    <rect y={GROUND - 4} width={W} height={400 - GROUND + 4} fill={ground} />
  </>
);

/** Gegner beim Tauziehen: Team Schlappi (müde graue Kugeln) */
const schlappi = (x: number, y: number, k: number) => (
  <g key={k} transform={`translate(${x} ${y})`}>
    <ellipse cx="0" cy="-34" rx="30" ry="34" fill="#b9bcc4" stroke="#55585f" strokeWidth="3" />
    <path d="M-12 -44 h8 M4 -44 h8" stroke="#55585f" strokeWidth="3" strokeLinecap="round" />
    <path d="M-7 -26 q7 -5 14 0" stroke="#55585f" strokeWidth="3" fill="none" strokeLinecap="round" />
    <path d="M18 -52 q3 6 0 9 q-3 -3 0 -9z" fill="#7fc8ff" />
  </g>
);

const flag = (x: number, y: number, color = "#e5484d") => (
  <g transform={`translate(${x} ${y})`}>
    <path d="M0 0 V-70" stroke="#5b4a32" strokeWidth="4" />
    <path d="M0 -70 l42 12 l-42 12z" fill={color} />
  </g>
);

export const SCENES: Scene[] = [
  {
    id: "tug",
    title: "Tauziehen gegen Team Schlappi",
    goal: "Zieht Team Schlappi über die Linie!",
    done: "Gewonnen – Team Schlappi liegt im Matsch!",
    draw: (p, n, ids) => {
      const mx = 560 - p * 230;
      const g = fit(n, 105, mx - 80 - 45);
      return {
        back: (
          <>
            {sky(ids)}
            <path d={`M500 ${GROUND} v60`} stroke="#fff" strokeWidth="6" strokeDasharray="10 8" />
            <ellipse cx="760" cy={GROUND + 30} rx="120" ry="16" fill="#8a6a3f" opacity="0.5" />
            {[0, 1, 2, 3].map((k) => schlappi(mx + 110 + k * 80, GROUND, k))}
          </>
        ),
        front: (
          <>
            <path d={`M${mx - 120 - g * n} ${GROUND - 46} L${mx + 380} ${GROUND - 40}`} stroke="#8b5a2b" strokeWidth="9" strokeLinecap="round" />
            <path d={`M${mx - 120 - g * n} ${GROUND - 46} L${mx + 380} ${GROUND - 40}`} stroke="#c58b4a" strokeWidth="3" strokeDasharray="12 10" />
            <path d={`M${mx} ${GROUND - 48} l-8 26 h16z`} fill="#e5484d" />
          </>
        ),
        spots: Array.from({ length: n }, (_, i) => ({ x: mx - 80 - i * g, y: GROUND, cls: "is-pull" })),
      };
    },
  },
  {
    id: "boulder",
    title: "Felsbrocken auf den Gipfel",
    goal: "Rollt den Brocken ganz nach oben!",
    done: "Der Brocken liegt auf dem Gipfel!",
    draw: (p, n, ids) => {
      const slope = (x: number) => 372 - 0.27 * x;
      const bx = 340 + p * 490;
      const g = fit(n, 105, bx - 95 - 40);
      return {
        back: (
          <>
            <rect width={W} height="400" fill={`url(#${ids.sky})`} />
            <path d="M0 400 V372 L1000 102 V400z" fill="#a58a6a" />
            <path d="M0 372 L1000 102" stroke="#7b6247" strokeWidth="5" />
            <path d="M880 140 l40 -40 l40 25 v140 h-80z" fill="#fff" opacity="0.5" />
            {flag(965, slope(965) + 4)}
          </>
        ),
        front: (
          <g transform={`translate(${bx} ${slope(bx) - 58}) rotate(${p * 540})`}>
            <circle r="58" fill="#8d8f96" stroke="#4e5057" strokeWidth="5" />
            <path d="M-30 -20 l18 10 l-6 18 M14 -34 l8 22 l20 4 M-8 24 l16 -8 l14 14" stroke="#5f6168" strokeWidth="4" fill="none" strokeLinecap="round" />
          </g>
        ),
        spots: Array.from({ length: n }, (_, i) => {
          const x = bx - 95 - i * g;
          return { x, y: slope(x) + 6, cls: "is-push" };
        }),
      };
    },
  },
  {
    id: "boat",
    title: "Boot gemeinsam zum See tragen",
    goal: "Bringt das Boot ins Wasser!",
    done: "Leinen los – das Boot schwimmt!",
    draw: (p, n, ids) => {
      const g = gap(n, 92, 420);
      const width = g * (n - 1);
      const cx = 180 + width / 2 + p * (560 - width / 2);
      const xs = spread(n, cx - width / 2, cx + width / 2);
      const top = GROUND - 150;
      return {
        back: (
          <>
            {sky(ids)}
            <ellipse cx="960" cy={GROUND + 26} rx="170" ry="40" fill={`url(#${ids.water})`} />
            <path d="M40 330 q30 -60 60 0 M70 330 v-30" stroke="#3f8a3a" strokeWidth="6" fill="none" />
          </>
        ),
        front: (
          <g>
            <path
              d={`M${cx - width / 2 - 90} ${top} h${width + 180} q-20 52 -90 56 h${-(width + 0)} q-70 -4 -90 -56z`}
              fill="#d9734a"
              stroke="#6e3420"
              strokeWidth="5"
              strokeLinejoin="round"
            />
            <path d={`M${cx - width / 2 - 70} ${top + 16} h${width + 140}`} stroke="#fff3c9" strokeWidth="5" />
          </g>
        ),
        spots: xs.map((x) => ({ x, y: GROUND, cls: "is-carry" })),
      };
    },
  },
  {
    id: "kart",
    title: "Seifenkisten-Rennen",
    goal: "Schiebt die Kiste als Erste ins Ziel!",
    done: "Sieg! Erster im Ziel!",
    draw: (p, n, ids) => {
      const kx = 270 + p * 590;
      const rival = 170 + 0.55 * 690;
      const g = fit(n - 1, 100, kx - 120 - 40);
      const kart = (x: number, y: number, color: string, bolt: boolean) => (
        <g transform={`translate(${x} ${y})`}>
          <rect x="-70" y="-46" width="140" height="40" rx="10" fill={color} stroke="#3a2914" strokeWidth="4" />
          {bolt && <path d="M-6 -42 l-12 18 h10 l-6 16 l16 -20 h-10 l6 -14z" fill="#3a2914" />}
          <circle cx="-44" cy="-4" r="16" fill="#2b2b33" />
          <circle cx="44" cy="-4" r="16" fill="#2b2b33" />
          <circle cx="-44" cy="-4" r="6" fill="#b9bcc4" />
          <circle cx="44" cy="-4" r="6" fill="#b9bcc4" />
        </g>
      );
      return {
        back: (
          <>
            {sky(ids, "#8fcf62")}
            <rect y="240" width={W} height="120" fill="#5f6168" />
            <path d="M0 300 H1000" stroke="#fff" strokeWidth="5" strokeDasharray="30 22" />
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <rect key={i} x={940 + (i % 2) * 14} y={240 + i * 20} width="14" height="20" fill={i % 2 ? "#fff" : "#222"} />
            ))}
            {kart(rival, 282, "#b9bcc4", false)}
            {schlappi(rival + 8, 248, 9)}
          </>
        ),
        front: kart(kx, GROUND + 14, "#ffcf33", true),
        spots: [
          { x: kx + 4, y: GROUND - 18, scale: 0.85 },
          ...Array.from({ length: Math.max(0, n - 1) }, (_, i) => ({ x: kx - 120 - i * g, y: GROUND + 14, cls: "is-push" })),
        ],
      };
    },
  },
  {
    id: "barbell",
    title: "Riesenhantel stemmen",
    goal: "Drückt die Hantel ganz nach oben!",
    done: "Neuer Studio-Rekord!",
    draw: (p, n) => {
      const g = gap(n, 100, 520);
      const xs = spread(n, 500 - (g * (n - 1)) / 2, 500 + (g * (n - 1)) / 2);
      const y = GROUND - 120 - p * 70;
      const half = (g * (n - 1)) / 2 + 110;
      return {
        back: (
          <>
            <rect width={W} height="400" fill="#efe6d6" />
            <rect y="40" width={W} height="10" fill="#d9cdb6" />
            <rect y={GROUND - 4} width={W} height="80" fill="#4a4e57" />
            <text x="500" y="110" textAnchor="middle" fontSize="40" fontWeight="800" fill="#d9cdb6">EMS · POWER</text>
          </>
        ),
        front: (
          <g>
            <rect x={500 - half} y={y - 6} width={half * 2} height="12" rx="6" fill="#9aa0aa" stroke="#3a3d44" strokeWidth="3" />
            {[-1, 1].map((s) => (
              <g key={s}>
                <rect x={500 + s * half - (s > 0 ? 0 : 34)} y={y - 62} width="34" height="124" rx="8" fill="#2b2b33" />
                <rect x={500 + s * (half + 36) - (s > 0 ? 0 : 26)} y={y - 46} width="26" height="92" rx="7" fill="#e5484d" />
              </g>
            ))}
          </g>
        ),
        spots: xs.map((x) => ({ x, y: GROUND, cls: "is-lift" })),
      };
    },
  },
  {
    id: "dragon",
    title: "Drachenboot-Rennen",
    goal: "Paddelt bis zur Zielboje!",
    done: "Zielboje erreicht – Gold fürs Team!",
    draw: (p, n, ids) => {
      const g = gap(n, 78, 480);
      const len = g * n + 120;
      const bx = 60 + p * (900 - len - 60);
      const xs = Array.from({ length: n }, (_, i) => bx + 90 + i * g);
      return {
        back: (
          <>
            <rect width={W} height="400" fill={`url(#${ids.sky})`} />
            <rect y="250" width={W} height="150" fill={`url(#${ids.water})`} />
            {[120, 360, 640].map((x) => (
              <path key={x} d={`M${x} 300 q20 -8 40 0`} stroke="#fff" strokeWidth="3" fill="none" opacity="0.6" />
            ))}
            <circle cx="930" cy="292" r="16" fill="#e5484d" stroke="#fff" strokeWidth="4" />
          </>
        ),
        front: (
          <g>
            <path d={`M${bx} 300 h${len} q-14 34 -60 36 h${-(len - 120)} q-46 -2 -60 -36z`} fill="#e5484d" stroke="#7a1f1f" strokeWidth="5" />
            <path d={`M${bx + len} 300 q22 -36 44 -30 q-8 10 -2 16 q-16 6 -20 14z`} fill="#3fa34d" stroke="#1d5a26" strokeWidth="4" />
            <circle cx={bx + len + 30} cy="276" r="3" fill="#1d5a26" />
            {xs.map((x, i) => (
              <path key={i} d={`M${x + 10} 282 l30 ${48 + (i % 2) * 6}`} stroke="#8b5a2b" strokeWidth="6" strokeLinecap="round" />
            ))}
          </g>
        ),
        spots: xs.map((x) => ({ x, y: 304, cls: "is-row", scale: 0.85 })),
      };
    },
  },
  {
    id: "relay",
    title: "Staffellauf",
    goal: "Bringt den Staffelstab ins Ziel!",
    done: "Stab im Ziel – Staffel gewonnen!",
    draw: (p, n, ids) => {
      const xs = spread(n, 110, 840);
      const k = Math.min(n - 1, Math.floor(p * n));
      const at = p >= 1 ? 930 : xs[k] + 26;
      return {
        back: (
          <>
            {sky(ids, "#e98a4f")}
            {[GROUND + 14, GROUND + 38].map((y) => (
              <path key={y} d={`M0 ${y} H1000`} stroke="#fff" strokeWidth="3" opacity="0.8" />
            ))}
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <rect key={i} x={950 + (i % 2) * 12} y={GROUND - 4 + Math.floor(i / 2) * 22} width="12" height="22" fill={i % 2 ? "#fff" : "#222"} />
            ))}
          </>
        ),
        front: <rect x={at} y={GROUND - 72} width="12" height="34" rx="4" fill="#ffcf33" stroke="#3a2914" strokeWidth="3" />,
        spots: xs.map((x, i) => ({ x, y: GROUND, cls: i === k && p < 1 ? "is-run" : i < k || p >= 1 ? "is-cheer" : "is-wait" })),
      };
    },
  },
  {
    id: "power",
    title: "Strom fürs Studio erstrampeln",
    goal: "Ladet den Riesen-Akku voll!",
    done: "Akku voll – das Studio leuchtet!",
    draw: (p, n) => {
      const xs = spread(n, 100, 700);
      const fill = 190 * p;
      return {
        back: (
          <>
            <rect width={W} height="400" fill="#e9eef7" />
            <rect y={GROUND - 4} width={W} height="80" fill="#4a4e57" />
            <rect x="820" y="110" width="140" height="210" rx="16" fill="#fff" stroke="#3a3d44" strokeWidth="6" />
            <rect x="862" y="92" width="56" height="20" rx="5" fill="#3a3d44" />
            <rect x="832" y={310 - fill} width="116" height={fill} rx="8" fill="#ffcf33" />
            <text x="890" y="230" textAnchor="middle" fontSize="38" fontWeight="800" fill="#3a2914">{Math.round(p * 100)}%</text>
            {xs.map((x, i) => (
              <path key={i} d={`M${x + 40} ${GROUND - 30} C${x + 120} ${GROUND + 10} 760 ${GROUND - 10} 820 ${260 - i * 8}`} stroke="#24336b" strokeWidth="4" fill="none" />
            ))}
          </>
        ),
        front: (
          <g>
            {xs.map((x, i) => (
              <g key={i} transform={`translate(${x} ${GROUND})`}>
                <circle cx="-34" cy="-18" r="20" fill="none" stroke="#2b2b33" strokeWidth="6" />
                <circle cx="34" cy="-18" r="20" fill="none" stroke="#2b2b33" strokeWidth="6" />
                <path d="M-34 -18 L0 -40 L34 -18 M0 -40 v-14" stroke="#e5484d" strokeWidth="6" fill="none" strokeLinecap="round" />
              </g>
            ))}
          </g>
        ),
        spots: xs.map((x) => ({ x, y: GROUND - 34, cls: "is-pedal", scale: 0.9 })),
      };
    },
  },
  {
    id: "tower",
    title: "Turm aus Bausteinen",
    goal: "Baut den Turm bis in die Wolken!",
    done: "Der Turm steht – Fahne drauf!",
    draw: (p, n, ids) => {
      const blocks = Math.round(p * 11);
      const colors = ["#e5484d", "#3d8bfd", "#ffcf33", "#3fa34d"];
      const half = Math.ceil(n / 2);
      const left = spread(half, 140, 380);
      const right = spread(n - half, 620, 860);
      return {
        back: (
          <>
            {sky(ids)}
            {Array.from({ length: blocks }, (_, i) => (
              <rect key={i} x={460 + (i % 2 ? 6 : -6)} y={GROUND - 26 - i * 24} width="80" height="24" rx="4" fill={colors[i % 4]} stroke="#3a2914" strokeWidth="3" />
            ))}
            {p >= 1 && flag(500, GROUND - 26 - 10 * 24, "#ffcf33")}
          </>
        ),
        spots: [...left, ...right].map((x) => ({ x, y: GROUND, cls: "is-lift" })),
      };
    },
  },
  {
    id: "sled",
    title: "Schlitten durch den Schnee ziehen",
    goal: "Zieht die Kiste bis zur Hütte!",
    done: "Angekommen – heißer Kakao für alle!",
    draw: (p, n, ids) => {
      const g = gap(n, 84, 330);
      const sx = 90 + p * 260;
      const xs = Array.from({ length: n }, (_, i) => sx + 200 + i * g);
      return {
        back: (
          <>
            {sky(ids, "#f4f8fc")}
            {[70, 260, 700].map((x) => (
              <path key={x} d={`M${x} ${GROUND - 2} l30 -80 l30 80z M${x + 30} ${GROUND - 2} v14`} fill="#3f8a3a" stroke="#2c5f29" strokeWidth="4" />
            ))}
            <path d="M880 330 v-70 l50 -40 l50 40 v70z" fill="#a0603a" stroke="#5e3420" strokeWidth="4" />
            <rect x="912" y="284" width="26" height="46" fill="#5e3420" />
            {[150, 420, 610, 830].map((x, i) => (
              <circle key={x} cx={x} cy={60 + i * 30} r="5" fill="#fff" />
            ))}
          </>
        ),
        front: (
          <g>
            {xs.map((x, i) => (
              <path key={i} d={`M${sx + 80} ${GROUND - 40} L${x - 20} ${GROUND - 60}`} stroke="#8b5a2b" strokeWidth="4" />
            ))}
            <rect x={sx - 70} y={GROUND - 96} width="140" height="70" rx="6" fill="#c58b4a" stroke="#5e3420" strokeWidth="5" />
            <path d={`M${sx - 90} ${GROUND - 10} h190 q24 0 24 -22`} stroke="#3a3d44" strokeWidth="7" fill="none" strokeLinecap="round" />
          </g>
        ),
        spots: xs.map((x) => ({ x, y: GROUND, cls: "is-pull-forward" })),
      };
    },
  },
];

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
    <section className={`nk-scene${won ? " is-won" : ""}`}>
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
              <Blitzi mood={won ? "party" : "happy"} stage={t.stage} coins={0} still fluid noShadow title={t.member.name} />
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
