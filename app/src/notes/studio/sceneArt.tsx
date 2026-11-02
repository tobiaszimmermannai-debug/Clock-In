// Bühnenbilder der Team-Szene: 10 Aktionen mit Hintergrund, Requisiten und Animationen (CSS-Klassen nk-a-*).
// Animierte Elemente stecken immer in einer eigenen <g>, damit CSS-Animation und Positionierung sich nicht stören.
import type { ReactNode } from "react";

export type Spot = { x: number; y: number; cls?: string; scale?: number };
export type Frame = { back: ReactNode; front?: ReactNode; spots: Spot[] };
export type Ids = { sky: string; water: string; night?: string };
export type Scene = { id: string; title: string; goal: string; done: string; draw: (p: number, n: number, ids: Ids) => Frame };

export const W = 1000;
export const GROUND = 336;
const INK = "#3a2914";

export const spread = (n: number, from: number, to: number) =>
  n <= 0 ? [] : n === 1 ? [(from + to) / 2] : Array.from({ length: n }, (_, i) => from + ((to - from) * i) / (n - 1));
const gap = (n: number, max: number, room: number) => Math.min(max, room / Math.max(1, n));
/** Abstand, damit n Figuren hintereinander in den Platz passen (nie aus dem Bild) */
const fit = (n: number, max: number, room: number) => Math.max(18, Math.min(max, room / Math.max(1, n - 1)));
const anim = (dur: number, delay = 0) => ({ animationDuration: `${dur}s`, animationDelay: `${-delay}s` });

// ---------------- Bausteine ----------------

const cloud = (x: number, y: number, s: number, dur: number, delay: number, key: string | number) => (
  <g key={key} transform={`translate(${x} ${y}) scale(${s})`}>
    <g className="nk-a-drift" style={anim(dur, delay)}>
      <path d="M0 0 q6 -26 34 -20 q14 -22 42 -8 q26 -10 34 14 q18 4 14 20 h-128 q-14 -4 4 -6z" fill="#fff" opacity="0.92" />
    </g>
  </g>
);

const sun = (x: number, y: number) => (
  <g transform={`translate(${x} ${y})`}>
    <g className="nk-a-spin" style={anim(30)}>
      {Array.from({ length: 12 }, (_, i) => (
        <path key={i} d="M0 -46 l5 -16 l-10 0z" fill="#ffd54d" opacity="0.7" transform={`rotate(${i * 30})`} />
      ))}
    </g>
    <circle r="34" fill="#ffe680" />
    <circle r="26" fill="#fff1a8" />
  </g>
);

const bird = (x: number, y: number, delay: number, key: number) => (
  <g key={key} transform={`translate(${x} ${y})`}>
    <g className="nk-a-fly" style={anim(16, delay)}>
      <path className="nk-a-flap" d="M0 0 q6 -6 12 0 q6 -6 12 0" stroke="#4b5563" strokeWidth="2.4" fill="none" strokeLinecap="round" />
    </g>
  </g>
);

const tree = (x: number, y: number, s = 1, key: string | number = x) => (
  <g key={key} transform={`translate(${x} ${y}) scale(${s})`}>
    <rect x="-5" y="-34" width="10" height="34" rx="3" fill="#8b5a2b" />
    <g className="nk-a-sway" style={anim(4, x % 3)}>
      <circle cx="0" cy="-52" r="26" fill="#4caf50" />
      <circle cx="-16" cy="-40" r="18" fill="#43a047" />
      <circle cx="16" cy="-40" r="18" fill="#5cbf60" />
      <circle cx="-8" cy="-60" r="8" fill="#7dd87f" opacity="0.7" />
    </g>
  </g>
);

const pine = (x: number, y: number, s = 1, snow = false, key: string | number = x) => (
  <g key={key} transform={`translate(${x} ${y}) scale(${s})`}>
    <rect x="-4" y="-16" width="8" height="16" fill="#6d4c2f" />
    <path d="M0 -96 l26 40 h-12 l20 30 h-14 l18 26 h-76 l18 -26 h-14 l20 -30 h-12z" fill="#2e7d32" />
    {snow && <path d="M0 -96 l12 18 q-6 4 -12 0 q-6 4 -12 0z M-14 -58 q14 6 28 0 l6 8 q-20 6 -40 0z M-20 -28 q20 6 40 0 l6 8 q-26 6 -52 0z" fill="#fff" />}
  </g>
);

const bush = (x: number, y: number, key: string | number = x) => (
  <g key={key} transform={`translate(${x} ${y})`}>
    <circle cx="-14" cy="-10" r="14" fill="#3f9e45" />
    <circle cx="6" cy="-14" r="17" fill="#4caf50" />
    <circle cx="22" cy="-8" r="12" fill="#43a047" />
    <circle cx="2" cy="-22" r="3" fill="#ff8a8a" />
    <circle cx="16" cy="-14" r="3" fill="#fff3a0" />
  </g>
);

const flowers = (xs: number[], y: number) =>
  xs.map((x, i) => (
    <g key={`f${x}`} transform={`translate(${x} ${y})`}>
      <path d="M0 0 v-12" stroke="#2e7d32" strokeWidth="2" />
      <circle cy="-14" r="4" fill={["#ff8a8a", "#fff3a0", "#b39dff", "#ffb74d"][i % 4]} />
      <circle cy="-14" r="1.6" fill="#fff" />
    </g>
  ));

const grassTufts = (xs: number[], y: number, color = "#5aa83f") =>
  xs.map((x) => <path key={`g${x}`} d={`M${x} ${y} l3 -10 l2 10 l3 -8 l2 8`} stroke={color} strokeWidth="2" fill="none" strokeLinejoin="round" />);

const hills = (far: string, near: string) => (
  <>
    <path d={`M0 ${GROUND - 40} C140 ${GROUND - 120} 260 ${GROUND - 70} 380 ${GROUND - 100} S640 ${GROUND - 140} 760 ${GROUND - 90} S940 ${GROUND - 110} 1000 ${GROUND - 80} V400 H0z`} fill={far} />
    <path d={`M0 ${GROUND - 14} C180 ${GROUND - 60} 320 ${GROUND - 20} 520 ${GROUND - 46} S860 ${GROUND - 20} 1000 ${GROUND - 50} V400 H0z`} fill={near} />
  </>
);

/** Himmel mit Sonne, ziehenden Wolken, Vögeln und Hügeln */
const outdoor = (ids: Ids, ground = "#8fd16b", hillsFar = "#b9e3a0", hillsNear = "#a3d98a") => (
  <>
    <rect width={W} height="400" fill={`url(#${ids.sky})`} />
    {sun(880, 70)}
    {cloud(0, 70, 1, 70, 10, "c1")}
    {cloud(0, 120, 0.7, 95, 50, "c2")}
    {cloud(0, 46, 0.55, 120, 85, "c3")}
    {bird(0, 96, 2, 1)}
    {bird(0, 110, 9, 2)}
    {hills(hillsFar, hillsNear)}
    <rect y={GROUND - 4} width={W} height={400 - GROUND + 4} fill={ground} />
    <rect y={GROUND - 4} width={W} height="6" fill="#000" opacity="0.06" />
  </>
);

/** Staubwölkchen an den Füßen */
const dust = (x: number, y: number, k: number) => (
  <g key={`d${k}`} transform={`translate(${x} ${y})`}>
    <g className="nk-a-puff" style={anim(1.4, k * 0.35)}>
      <circle r="9" fill="#d8c3a0" opacity="0.8" />
      <circle cx="10" cy="3" r="6" fill="#e4d3b5" opacity="0.8" />
    </g>
  </g>
);

const flag = (x: number, y: number, color = "#e5484d", key: string | number = x) => (
  <g key={key} transform={`translate(${x} ${y})`}>
    <path d="M0 0 V-74" stroke="#5b4a32" strokeWidth="4" strokeLinecap="round" />
    <circle cy="-76" r="4" fill="#ffcf33" />
    <g transform="translate(0 -72)">
      <g className="nk-a-flag">
        <path d="M0 0 q22 -6 44 4 q-6 10 0 20 q-22 -10 -44 -4z" fill={color} />
      </g>
    </g>
  </g>
);

const checkered = (x: number, y: number, rows: number, cols = 2, size = 12) =>
  Array.from({ length: rows * cols }, (_, i) => {
    const r = Math.floor(i / cols);
    const c = i % cols;
    return <rect key={`ck${i}`} x={x + c * size} y={y + r * size} width={size} height={size} fill={(r + c) % 2 ? "#fff" : "#222"} />;
  });

/** Team Schlappi (Gegner): müde graue Kugeln */
const schlappi = (x: number, y: number, k: number, arms = true) => (
  <g key={`s${k}`} transform={`translate(${x} ${y})`}>
    <g className="nk-a-wobble" style={anim(1.6, k * 0.3)}>
      <ellipse cx="0" cy="-4" rx="20" ry="5" fill="#000" opacity="0.12" />
      <ellipse cx="0" cy="-36" rx="30" ry="34" fill="#c3c6cd" stroke="#55585f" strokeWidth="3" />
      <ellipse cx="-8" cy="-50" rx="10" ry="6" fill="#fff" opacity="0.35" />
      <path d="M-13 -44 q4 3 8 0 M5 -44 q4 3 8 0" stroke="#55585f" strokeWidth="3" fill="none" strokeLinecap="round" />
      <path d="M-7 -26 q7 -5 14 0" stroke="#55585f" strokeWidth="3" fill="none" strokeLinecap="round" />
      {arms && <path d="M-28 -34 l-18 2 M28 -34 l14 6" stroke="#55585f" strokeWidth="5" strokeLinecap="round" />}
      <g className="nk-a-drip" style={anim(1.8, k * 0.5)}>
        <path d="M20 -56 q4 7 0 10 q-4 -3 0 -10z" fill="#7fc8ff" />
      </g>
    </g>
  </g>
);

const wheel = (cx: number, cy: number, r: number, key: string | number) => (
  <g key={key} transform={`translate(${cx} ${cy})`}>
    <circle r={r} fill="#2b2b33" />
    <g className="nk-a-wheel">
      <circle r={r * 0.45} fill="#b9bcc4" />
      <path d={`M${-r * 0.42} 0 H${r * 0.42} M0 ${-r * 0.42} V${r * 0.42}`} stroke="#6b6f78" strokeWidth="2.5" />
    </g>
  </g>
);

const speedLines = (x: number, y: number) => (
  <g transform={`translate(${x} ${y})`} className="nk-a-dash">
    {[0, 14, 28].map((dy, i) => (
      <path key={i} d={`M0 ${dy} h-${46 - i * 10}`} stroke="#fff" strokeWidth="4" strokeLinecap="round" opacity="0.8" />
    ))}
  </g>
);

const crowd = (y: number, from: number, to: number, seed = 1) =>
  Array.from({ length: Math.floor((to - from) / 16) }, (_, i) => {
    const x = from + i * 16 + ((i * 7 * seed) % 5);
    const colors = ["#ef9a9a", "#90caf9", "#ffe082", "#a5d6a7", "#ce93d8", "#ffcc80"];
    return (
      <g key={`cr${i}`} transform={`translate(${x} ${y})`}>
        <g className="nk-a-cheer" style={anim(0.9 + (i % 3) * 0.2, i * 0.13)}>
          <rect x="-6" y="-8" width="12" height="14" rx="5" fill={colors[i % colors.length]} />
          <circle cy="-13" r="5.5" fill="#f2c9a0" />
        </g>
      </g>
    );
  });

// ---------------- Die 10 Aktionen ----------------

export const SCENES: Scene[] = [
  {
    id: "tug",
    title: "Tauziehen gegen Team Schlappi",
    goal: "Zieht Team Schlappi über die Linie!",
    done: "Gewonnen – Team Schlappi liegt im Matsch!",
    draw: (p, n, ids) => {
      const mx = 560 - p * 230;
      const g = fit(n, 105, mx - 80 - 45);
      const ropeY = (x: number) => GROUND - 46 + ((x - (mx - 120)) / 500) * 6;
      return {
        back: (
          <>
            {outdoor(ids)}
            {tree(70, GROUND - 6, 0.9)}
            {tree(950, GROUND - 8, 1.1)}
            {bush(180, GROUND - 2)}
            <g transform="translate(500 196)">
              <rect x="-74" y="-30" width="148" height="44" rx="6" fill="#c58b4a" stroke="#6e4a22" strokeWidth="4" />
              <text y="-2" textAnchor="middle" fontSize="16" fontWeight="800" fill="#4a2f12">BLITZI vs. SCHLAPPI</text>
              <path d="M-50 14 v120 M50 14 v120" stroke="#6e4a22" strokeWidth="6" />
            </g>
            <ellipse cx="500" cy={GROUND + 26} rx="70" ry="14" fill="#7a5530" />
            <ellipse cx="500" cy={GROUND + 24} rx="52" ry="8" fill="#8f6639" />
            <path d={`M500 ${GROUND + 6} v54`} stroke="#fff" strokeWidth="5" strokeDasharray="9 7" />
            {grassTufts([60, 240, 300, 640, 720, 880], GROUND + 30)}
            {flowers([120, 270, 690, 830], GROUND + 48)}
            {[0, 1, 2, 3].map((k) => schlappi(mx + 110 + k * 80, GROUND, k))}
            {[0, 1, 2].map((k) => dust(mx - 70 - k * g, GROUND - 2, k))}
          </>
        ),
        front: (
          <>
            <path d={`M${mx - 130 - g * n} ${ropeY(mx - 130 - g * n)} L${mx + 380} ${ropeY(mx + 380)}`} stroke="#8b5a2b" strokeWidth="10" strokeLinecap="round" />
            <path d={`M${mx - 130 - g * n} ${ropeY(mx - 130 - g * n)} L${mx + 380} ${ropeY(mx + 380)}`} stroke="#d6a463" strokeWidth="3" strokeDasharray="10 8" className="nk-a-rope" />
            <g transform={`translate(${mx} ${ropeY(mx)})`}>
              <g className="nk-a-flag">
                <path d="M0 0 l-10 30 h20z" fill="#e5484d" stroke="#8b1e22" strokeWidth="2" />
              </g>
            </g>
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
            {sun(130, 70)}
            {cloud(0, 60, 0.8, 80, 20, "c1")}
            {cloud(0, 120, 0.6, 110, 70, "c2")}
            {bird(0, 90, 5, 1)}
            <path d="M380 400 L640 130 L760 220 L880 90 L1000 180 V400z" fill="#b8c4d6" opacity="0.6" />
            <path d="M840 130 l40 -40 l34 32 q-20 10 -36 0 q-18 12 -38 8z" fill="#fff" opacity="0.8" />
            <path d="M0 400 V372 L1000 102 V400z" fill="#a8896a" />
            <path d="M0 400 V388 L1000 128 V400z" fill="#94775a" opacity="0.6" />
            <path d="M0 372 L1000 102" stroke="#6f5640" strokeWidth="5" />
            <path d="M40 368 L980 116" stroke="#cdb38f" strokeWidth="3" strokeDasharray="4 14" />
            {[[120, 0.7], [520, 0.8], [700, 0.75]].map(([x, s]) => pine(x, slope(x) + 26, s, false, `p${x}`))}
            {[[260, 12], [430, 9], [610, 11], [790, 8]].map(([x, r]) => (
              <ellipse key={`r${x}`} cx={x} cy={slope(x) + 16} rx={r} ry={r * 0.6} fill="#857055" />
            ))}
            {flag(965, slope(965) + 4)}
            {[0, 1].map((k) => dust(bx - 70 - k * 40, slope(bx - 70 - k * 40) + 2, k))}
          </>
        ),
        front: (
          <g transform={`translate(${bx} ${slope(bx) - 58})`}>
            <g transform={`rotate(${p * 540})`}>
              <circle r="58" fill="#8d8f96" stroke="#4e5057" strokeWidth="5" />
              <circle cx="-16" cy="-18" r="22" fill="#a2a4ab" opacity="0.6" />
              <path d="M-30 -20 l18 10 l-6 18 M14 -34 l8 22 l20 4 M-8 24 l16 -8 l14 14" stroke="#5f6168" strokeWidth="4" fill="none" strokeLinecap="round" />
              <circle cx="22" cy="20" r="5" fill="#6d6f76" />
            </g>
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
            {outdoor(ids)}
            {tree(60, GROUND - 6, 1)}
            {tree(130, GROUND - 4, 0.75)}
            <ellipse cx="960" cy={GROUND + 30} rx="190" ry="48" fill={`url(#${ids.water})`} />
            <g clipPath="none">
              {[0, 1, 2].map((i) => (
                <g key={`w${i}`} transform={`translate(${880 + i * 30} ${GROUND + 18 + i * 10})`}>
                  <g className="nk-a-wave" style={anim(3, i)}>
                    <path d="M0 0 q10 -6 20 0 q10 6 20 0" stroke="#e3f4ff" strokeWidth="3" fill="none" />
                  </g>
                </g>
              ))}
            </g>
            <path d="M790 352 v-30 M802 354 v-38 M814 352 v-26" stroke="#5a8f3a" strokeWidth="4" strokeLinecap="round" />
            <ellipse cx="796" cy="318" rx="4" ry="10" fill="#7a4a2a" />
            <g transform={`translate(930 ${GROUND + 12})`}>
              <g className="nk-a-bob" style={anim(2.4)}>
                <ellipse cx="0" cy="0" rx="12" ry="7" fill="#ffe082" />
                <circle cx="9" cy="-7" r="5" fill="#ffe082" />
                <path d="M13 -7 l6 2 l-6 2z" fill="#ff9800" />
              </g>
            </g>
            {grassTufts([220, 330, 470, 610], GROUND + 34)}
            {flowers([260, 400, 560], GROUND + 50)}
            {xs.map((x, i) => dust(x - 26, GROUND - 2, i))}
          </>
        ),
        front: (
          <g>
            <path
              d={`M${cx - width / 2 - 96} ${top} h${width + 192} q-20 56 -96 60 h${-width} q-76 -4 -96 -60z`}
              fill="#d9734a"
              stroke="#6e3420"
              strokeWidth="5"
              strokeLinejoin="round"
            />
            {[14, 30, 44].map((dy) => (
              <path key={dy} d={`M${cx - width / 2 - 80 + dy / 2} ${top + dy} h${width + 160 - dy}`} stroke="#b85c38" strokeWidth="2.5" />
            ))}
            <path d={`M${cx - width / 2 - 86} ${top + 4} h${width + 172}`} stroke="#fff3c9" strokeWidth="5" strokeLinecap="round" />
            <text x={cx} y={top + 40} textAnchor="middle" fontSize="18" fontWeight="800" fill="#fff3c9" opacity="0.9">
              ⚡ BLITZI
            </text>
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
      const kart = (x: number, y: number, color: string, ours: boolean) => (
        <g transform={`translate(${x} ${y})`}>
          <path d="M-74 -10 q0 -38 30 -40 h86 q30 0 34 26 l0 14z" fill={color} stroke={INK} strokeWidth="4" strokeLinejoin="round" />
          <rect x="-58" y="-40" width="30" height="16" rx="4" fill="#fff" opacity="0.5" />
          {ours && <path d="M6 -40 l-12 18 h10 l-6 16 l16 -20 h-10 l6 -14z" fill={INK} />}
          {ours && <text x="40" y="-18" fontSize="13" fontWeight="800" fill={INK}>1</text>}
          {wheel(-44, -4, 16, "w1")}
          {wheel(44, -4, 16, "w2")}
        </g>
      );
      return {
        back: (
          <>
            <rect width={W} height="400" fill={`url(#${ids.sky})`} />
            {cloud(0, 50, 0.7, 70, 30, "c1")}
            <rect x="40" y="120" width="560" height="84" rx="8" fill="#9aa3b5" />
            <rect x="40" y="110" width="560" height="14" rx="4" fill="#c62828" />
            {crowd(178, 60, 590, 1)}
            {crowd(152, 70, 590, 2)}
            <rect y="204" width={W} height="36" fill="#8fd16b" />
            <rect y="236" width={W} height="10" fill="#fff" />
            {Array.from({ length: 34 }, (_, i) => (
              <rect key={`cb${i}`} x={i * 30} y="236" width="15" height="10" fill="#e53935" />
            ))}
            <rect y="246" width={W} height="114" fill="#5f6168" />
            <path d="M0 302 H1000" stroke="#fff" strokeWidth="5" strokeDasharray="30 22" />
            <rect y="360" width={W} height="40" fill="#8fd16b" />
            <g transform="translate(940 150)">
              <path d="M0 0 v210 M60 0 v210" stroke="#5b4a32" strokeWidth="6" />
              <rect x="-6" y="-6" width="72" height="30" fill="#fff" stroke={INK} strokeWidth="3" />
              {checkered(-4, -4, 2, 6, 11)}
            </g>
            {kart(rival, 288, "#b9bcc4", false)}
            {schlappi(rival + 4, 256, 9, false)}
          </>
        ),
        front: (
          <>
            {p > 0.02 && speedLines(kx - 92, GROUND - 26)}
            {kart(kx, GROUND + 14, "#ffcf33", true)}
          </>
        ),
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
      const bend = 10 - p * 4;
      return {
        back: (
          <>
            <rect width={W} height="400" fill="#f3ead9" />
            <rect y="0" width={W} height="40" fill="#e6dac3" />
            {[110, 380, 650].map((x) => (
              <g key={`win${x}`} transform={`translate(${x} 60)`}>
                <rect width="200" height="120" rx="6" fill="#cfe9ff" stroke="#c8b99c" strokeWidth="6" />
                <path d="M100 0 v120 M0 60 h200" stroke="#c8b99c" strokeWidth="4" />
                <path d="M20 110 L80 10 M60 110 L120 10" stroke="#fff" strokeWidth="10" opacity="0.5" />
              </g>
            ))}
            <path d="M0 196 H1000" stroke="#d9cdb6" strokeWidth="6" />
            <g transform="translate(905 110)">
              <circle r="26" fill="#fff" stroke="#8d7f66" strokeWidth="5" />
              <g className="nk-a-spin" style={anim(60)}>
                <path d="M0 0 v-16" stroke={INK} strokeWidth="3" strokeLinecap="round" />
              </g>
              <path d="M0 0 h11" stroke={INK} strokeWidth="3" strokeLinecap="round" />
            </g>
            <g transform="translate(60 240)">
              <rect x="-20" y="0" width="40" height="94" rx="6" fill="#7b8794" />
              {[10, 34, 58].map((dy, i) => (
                <rect key={dy} x={-26 + i * 2} y={dy} width={52 - i * 4} height="12" rx="6" fill={["#e5484d", "#3d8bfd", "#ffcf33"][i]} />
              ))}
            </g>
            <g transform="translate(950 330)">
              <rect x="-22" y="-34" width="44" height="34" rx="6" fill="#c58b4a" />
              <g className="nk-a-sway" style={anim(5)}>
                <path d="M0 -34 q-26 -30 -8 -58 M0 -34 q22 -30 10 -62 M0 -34 q2 -36 0 -70" stroke="#3f9e45" strokeWidth="8" fill="none" strokeLinecap="round" />
              </g>
            </g>
            <rect y={GROUND - 4} width={W} height="80" fill="#4a4e57" />
            {Array.from({ length: 10 }, (_, i) => (
              <path key={`t${i}`} d={`M${i * 100} ${GROUND - 4} v80`} stroke="#3d4148" strokeWidth="3" />
            ))}
            {xs.map((x, i) => (
              <g key={`ch${i}`} transform={`translate(${x} ${GROUND - 8})`}>
                <g className="nk-a-puff" style={anim(2.2, i * 0.4)}>
                  <circle r="6" fill="#fff" opacity="0.6" />
                </g>
              </g>
            ))}
          </>
        ),
        front: (
          <g>
            <path d={`M${500 - half} ${y} Q500 ${y + bend} ${500 + half} ${y}`} stroke="#3a3d44" strokeWidth="16" fill="none" strokeLinecap="round" />
            <path d={`M${500 - half} ${y} Q500 ${y + bend} ${500 + half} ${y}`} stroke="#b9bfc9" strokeWidth="10" fill="none" strokeLinecap="round" />
            {[-1, 1].map((s) => (
              <g key={s} transform={`translate(${500 + s * half} ${y})`}>
                <rect x={s > 0 ? 0 : -36} y="-66" width="36" height="132" rx="9" fill="#2b2b33" />
                <rect x={s > 0 ? 38 : -66} y="-50" width="28" height="100" rx="8" fill="#e5484d" />
                <rect x={s > 0 ? 68 : -88} y="-34" width="20" height="68" rx="6" fill="#ffcf33" />
                <rect x={s > 0 ? 8 : -28} y="-58" width="8" height="116" rx="3" fill="#fff" opacity="0.15" />
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
            {sun(860, 64)}
            {cloud(0, 70, 0.9, 75, 15, "c1")}
            {cloud(0, 40, 0.6, 105, 60, "c2")}
            {bird(0, 100, 4, 1)}
            <path d="M0 250 C120 200 240 230 360 214 S620 190 760 220 S940 210 1000 222 V260 H0z" fill="#7cc576" />
            {[90, 210, 640, 820].map((x, i) => tree(x, 238 - (i % 2) * 6, 0.55, `t${x}`))}
            <rect y="250" width={W} height="150" fill={`url(#${ids.water})`} />
            {Array.from({ length: 9 }, (_, i) => (
              <g key={`wv${i}`} transform={`translate(${(i * 117) % 980} ${270 + (i % 4) * 30})`}>
                <g className="nk-a-wave" style={anim(3 + (i % 3), i * 0.7)}>
                  <path d="M0 0 q10 -6 20 0 q10 6 20 0" stroke="#e3f4ff" strokeWidth="3" fill="none" opacity="0.8" />
                </g>
              </g>
            ))}
            {[300, 520, 740].map((x) => (
              <circle key={`bu${x}`} cx={x} cy="372" r="7" fill="#ffcf33" stroke="#fff" strokeWidth="3" />
            ))}
            <g transform="translate(930 292)">
              <g className="nk-a-bob" style={anim(2)}>
                <circle r="16" fill="#e5484d" stroke="#fff" strokeWidth="4" />
                <path d="M0 -16 v-34" stroke="#5b4a32" strokeWidth="3" />
                <path d="M0 -50 l24 7 l-24 7z" fill="#ffcf33" />
              </g>
            </g>
          </>
        ),
        front: (
          <g>
            {p > 0.02 && (
              <g transform={`translate(${bx - 10} 320)`}>
                <g className="nk-a-wave" style={anim(1.2)}>
                  <path d="M0 0 q-20 -10 -40 0 q-20 10 -40 0" stroke="#fff" strokeWidth="4" fill="none" opacity="0.8" />
                </g>
              </g>
            )}
            <path d={`M${bx} 300 h${len} q-14 34 -60 36 h${-(len - 120)} q-46 -2 -60 -36z`} fill="#e5484d" stroke="#7a1f1f" strokeWidth="5" />
            <path d={`M${bx + 10} 310 h${len - 20}`} stroke="#ffcf33" strokeWidth="5" strokeDasharray="14 10" />
            <path d={`M${bx + len} 300 q22 -40 50 -34 q-6 12 0 18 q-18 8 -24 16z`} fill="#3fa34d" stroke="#1d5a26" strokeWidth="4" />
            <path d={`M${bx + len + 30} 274 l10 -10 l2 12 z`} fill="#ffcf33" />
            <circle cx={bx + len + 30} cy="278" r="3" fill="#1d5a26" />
            <path d={`M${bx} 300 q-26 -14 -34 -36 q16 6 34 20z`} fill="#3fa34d" stroke="#1d5a26" strokeWidth="3" />
            {xs.map((x, i) => (
              <g key={i} transform={`translate(${x + 10} 282)`}>
                <g className="nk-a-paddle" style={anim(1.1, (i % 2) * 0.55)}>
                  <path d="M0 0 l30 50" stroke="#8b5a2b" strokeWidth="6" strokeLinecap="round" />
                  <ellipse cx="32" cy="54" rx="6" ry="11" fill="#8b5a2b" transform="rotate(-30 32 54)" />
                </g>
              </g>
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
            <rect width={W} height="400" fill={`url(#${ids.sky})`} />
            {cloud(0, 60, 0.8, 85, 25, "c1")}
            <rect x="0" y="130" width={W} height="100" fill="#9aa3b5" />
            <rect x="0" y="122" width={W} height="12" fill="#3d8bfd" />
            {crowd(206, 10, 990, 3)}
            {crowd(180, 18, 990, 4)}
            {crowd(154, 10, 990, 5)}
            <rect y="230" width={W} height="20" fill="#8fd16b" />
            <rect y="250" width={W} height="150" fill="#e98a4f" />
            {[GROUND - 50, GROUND - 16, GROUND + 18, GROUND + 52].map((ly) => (
              <path key={ly} d={`M0 ${ly} H1000`} stroke="#fff" strokeWidth="3" opacity="0.85" />
            ))}
            {[1, 2, 3].map((l) => (
              <text key={l} x="30" y={GROUND - 26 + (l - 1) * 34} fontSize="16" fontWeight="800" fill="#fff" opacity="0.8">
                {l}
              </text>
            ))}
            <g transform="translate(948 250)">
              {checkered(0, 0, 12, 2, 12)}
            </g>
            <path d={`M940 ${GROUND - 60} v96`} stroke="#fff" strokeWidth="4" />
            {[300, 560].map((x) => (
              <path key={`co${x}`} d={`M${x} ${GROUND + 44} l10 -24 l10 24z`} fill="#ff7043" stroke="#fff" strokeWidth="2" />
            ))}
          </>
        ),
        front: (
          <>
            {p < 1 && speedLines(xs[k] - 46, GROUND - 60)}
            <g transform={`translate(${at} ${GROUND - 72})`}>
              <g className="nk-a-glow">
                <rect width="12" height="36" rx="4" fill="#ffcf33" stroke={INK} strokeWidth="3" />
              </g>
            </g>
          </>
        ),
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
      const bulbs = Math.round(p * 6);
      return {
        back: (
          <>
            <rect width={W} height="400" fill="#e9eef7" />
            <rect width={W} height="44" fill="#dde4f0" />
            {Array.from({ length: 6 }, (_, i) => (
              <g key={`bl${i}`} transform={`translate(${120 + i * 110} 44)`}>
                <path d="M0 0 v26" stroke="#7b8794" strokeWidth="3" />
                <circle cy="40" r="14" fill={i < bulbs ? "#fff59d" : "#cfd8dc"} stroke="#7b8794" strokeWidth="3" />
                {i < bulbs && (
                  <g className="nk-a-glow">
                    <circle cy="40" r="26" fill="#fff59d" opacity="0.35" />
                  </g>
                )}
              </g>
            ))}
            <g transform="translate(540 150)">
              <circle r="44" fill="#fff" stroke="#3a3d44" strokeWidth="5" />
              <path d="M-32 12 A34 34 0 0 1 32 12" stroke="#e0e0e0" strokeWidth="8" fill="none" />
              <path d={`M0 0 L${Math.cos(Math.PI * (1 - p)) * -30} ${-Math.sin(Math.PI * p) * 30 + 0}`} stroke="#e5484d" strokeWidth="4" strokeLinecap="round" />
              <circle r="5" fill="#3a3d44" />
              <text y="30" textAnchor="middle" fontSize="11" fontWeight="700" fill="#3a3d44">kW</text>
            </g>
            <rect y={GROUND - 4} width={W} height="80" fill="#4a4e57" />
            <rect x="820" y="110" width="140" height="210" rx="16" fill="#fff" stroke="#3a3d44" strokeWidth="6" />
            <rect x="862" y="92" width="56" height="20" rx="5" fill="#3a3d44" />
            <rect x="832" y={310 - fill} width="116" height={fill} rx="8" fill="#ffcf33" />
            <g className="nk-a-charge">
              <rect x="832" y={310 - fill} width="116" height={Math.min(fill, 24)} rx="8" fill="#fff" opacity="0.4" />
            </g>
            <text x="890" y="226" textAnchor="middle" fontSize="38" fontWeight="800" fill={INK}>
              {Math.round(p * 100)}%
            </text>
            <g transform="translate(890 180)">
              <g className="nk-a-blink">
                <path d="M6 -24 l-14 22 h12 l-8 20 l20 -26 h-12 l8 -16z" fill="#ff9f1c" />
              </g>
            </g>
            {xs.map((x, i) => (
              <g key={`ca${i}`}>
                <path d={`M${x + 40} ${GROUND - 30} C${x + 120} ${GROUND + 10} 760 ${GROUND - 10} 820 ${260 - i * 8}`} stroke="#24336b" strokeWidth="5" fill="none" />
                <path d={`M${x + 40} ${GROUND - 30} C${x + 120} ${GROUND + 10} 760 ${GROUND - 10} 820 ${260 - i * 8}`} stroke="#7fd3ff" strokeWidth="3" fill="none" className="nk-a-flow" />
              </g>
            ))}
          </>
        ),
        front: (
          <g>
            {xs.map((x, i) => (
              <g key={i} transform={`translate(${x} ${GROUND})`}>
                {wheel(-34, -18, 20, "a")}
                {wheel(34, -18, 20, "b")}
                <circle cx="-34" cy="-18" r="20" fill="none" stroke="#2b2b33" strokeWidth="6" />
                <circle cx="34" cy="-18" r="20" fill="none" stroke="#2b2b33" strokeWidth="6" />
                <path d="M-34 -18 L-4 -40 L34 -18 M-4 -40 h-10 M18 -44 l-6 26" stroke="#e5484d" strokeWidth="6" fill="none" strokeLinecap="round" strokeLinejoin="round" />
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
      const topY = GROUND - 26 - blocks * 24;
      return {
        back: (
          <>
            {outdoor(ids, "#c9b28a", "#c8e6c9", "#b5dbb0")}
            <g transform="translate(760 0)">
              <path d="M0 330 V60 M-8 330 V60 M-8 60 h220 M-8 80 h-60" stroke="#f9a825" strokeWidth="8" />
              <path d="M-4 60 l30 -30 l30 30 M60 60 l30 -30 l30 30" stroke="#f9a825" strokeWidth="4" fill="none" />
              <g transform="translate(-260 60)">
                <g className="nk-a-bob" style={anim(3)}>
                  <path d="M0 0 V90" stroke="#5b4a32" strokeWidth="2" />
                  <rect x="-40" y="90" width="80" height="24" rx="4" fill={colors[blocks % 4]} stroke={INK} strokeWidth="3" />
                </g>
              </g>
              <path d="M-8 60 H-260" stroke="#f9a825" strokeWidth="5" />
            </g>
            <rect x="100" y={GROUND - 30} width="120" height="26" rx="4" fill="#8d6e63" />
            {Array.from({ length: blocks }, (_, i) => (
              <g key={i}>
                <rect x={460 + (i % 2 ? 6 : -6)} y={GROUND - 26 - i * 24} width="80" height="24" rx="4" fill={colors[i % 4]} stroke={INK} strokeWidth="3" />
                <circle cx={480 + (i % 2 ? 6 : -6)} cy={GROUND - 20 - i * 24} r="3" fill="#fff" opacity="0.5" />
                <circle cx={520 + (i % 2 ? 6 : -6)} cy={GROUND - 20 - i * 24} r="3" fill="#fff" opacity="0.5" />
              </g>
            ))}
            {p >= 1 && flag(500, topY + 24, "#ffcf33")}
            {grassTufts([60, 300, 700, 920], GROUND + 32, "#8a7552")}
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
            <rect width={W} height="400" fill={`url(#${ids.sky})`} />
            {cloud(0, 60, 0.9, 90, 30, "c1")}
            <path d={`M0 ${GROUND - 60} C200 ${GROUND - 140} 380 ${GROUND - 80} 560 ${GROUND - 120} S880 ${GROUND - 90} 1000 ${GROUND - 130} V400 H0z`} fill="#dfe9f5" />
            <path d={`M0 ${GROUND - 20} C220 ${GROUND - 70} 420 ${GROUND - 30} 640 ${GROUND - 56} S900 ${GROUND - 26} 1000 ${GROUND - 40} V400 H0z`} fill="#eef4fb" />
            <rect y={GROUND - 4} width={W} height="80" fill="#f8fbff" />
            {[[60, 1], [250, 0.8], [700, 0.9], [790, 0.7]].map(([x, s]) => pine(x, GROUND - 2, s, true, `pn${x}`))}
            <path d={`M20 ${GROUND + 10} H${sx - 80}`} stroke="#d5e1ee" strokeWidth="4" />
            <path d={`M20 ${GROUND + 22} H${sx - 80}`} stroke="#d5e1ee" strokeWidth="4" />
            <g transform="translate(880 330)">
              <path d="M0 0 v-72 l50 -42 l50 42 v72z" fill="#a0603a" stroke="#5e3420" strokeWidth="4" />
              <path d="M-6 -70 l56 -48 l56 48" stroke="#fff" strokeWidth="10" fill="none" strokeLinecap="round" />
              <rect x="32" y="-46" width="26" height="46" fill="#5e3420" />
              <rect x="66" y="-56" width="22" height="20" fill="#ffe082" />
              <rect x="70" y="-122" width="14" height="30" fill="#5e3420" />
              {[0, 1, 2].map((i) => (
                <g key={`sm${i}`} transform="translate(77 -124)">
                  <g className="nk-a-smoke" style={anim(3, i)}>
                    <circle r="7" fill="#cfd8dc" />
                  </g>
                </g>
              ))}
            </g>
            {Array.from({ length: 24 }, (_, i) => (
              <g key={`sn${i}`} transform={`translate(${(i * 41) % 1000} -10)`}>
                <g className="nk-a-fall" style={anim(6 + (i % 5), i * 0.7)}>
                  <circle r={2 + (i % 3)} fill="#fff" />
                </g>
              </g>
            ))}
          </>
        ),
        front: (
          <g>
            {xs.map((x, i) => (
              <path key={i} d={`M${sx + 80} ${GROUND - 40} L${x - 20} ${GROUND - 56}`} stroke="#8b5a2b" strokeWidth="4" />
            ))}
            <rect x={sx - 70} y={GROUND - 100} width="140" height="74" rx="6" fill="#c58b4a" stroke="#5e3420" strokeWidth="5" />
            <path d={`M${sx - 70} ${GROUND - 70} h140 M${sx - 10} ${GROUND - 100} v74`} stroke="#8b5a2b" strokeWidth="5" />
            <path d={`M${sx - 70} ${GROUND - 100} h140 l-10 -8 h-120z`} fill="#fff" />
            <path d={`M${sx - 92} ${GROUND - 10} h194 q26 0 26 -24`} stroke="#3a3d44" strokeWidth="7" fill="none" strokeLinecap="round" />
            {xs.map((x, i) => dust(x - 20, GROUND - 2, i))}
          </g>
        ),
        spots: xs.map((x) => ({ x, y: GROUND, cls: "is-pull-forward" })),
      };
    },
  },
];
