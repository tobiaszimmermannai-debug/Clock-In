// Blitzi – das Maskottchen: ein gelbes Elektro-Mäuschen mit schwarzer Kappe (weißer Kreis + Blitz), Blitz-Ohren
// und EMS-Kabel als Schwanz. Eigene Figur (SVG, keine fremden Vorlagen).
// Entwicklung über 30 Stufen: klein und kugelrund → sportlich → übertriebenes Muskelpaket mit Adern;
// danach sitzt er auf Goldmünzen. Stimmungen: party, proud, happy, neutral, sleepy, sad.
import "./blitzi.css";
import { useId, useState, type ReactNode } from "react";
import { atStage, detailOf, MAX_STAGE } from "./evolution";
import { type Anchors, itemLayer } from "./items";
import type { Mood } from "./stats";

const OUTLINE = "#3a2914";
const YELLOW_TOP = "#ffe14d";
const YELLOW_BOTTOM = "#ffbd14";
const CREAM = "#fff3c9";
const MUSCLE = "#d4901a"; // Muskel-Linien
const VEIN = "#b65d08";
const CHEEK = "#ff5a3c";
const CAP = "#1d1d22";
const NAVY = "#24336b";
const GOLD = "#f6c544";
const GOLD_DARK = "#b9861a";
const OW = 3; // sichtbare Konturbreite
const VB_W = 280;

const rad = (deg: number) => (deg * Math.PI) / 180;

type Ellipse = [number, number, number, number];
type Shape = { e: Ellipse } | { l: [number, number, number, number, number] };

/** Mehrere Formen als eine Fläche mit gemeinsamer Kontur zeichnen */
function Blob(props: { shapes: Shape[]; fill: string }) {
  const draw = (outline: boolean) =>
    props.shapes.map((s, i) =>
      "e" in s ? (
        <ellipse
          key={i}
          cx={s.e[0]}
          cy={s.e[1]}
          rx={s.e[2]}
          ry={s.e[3]}
          fill={outline ? OUTLINE : props.fill}
          stroke={outline ? OUTLINE : "none"}
          strokeWidth={outline ? OW * 2 : 0}
        />
      ) : (
        <line
          key={i}
          x1={s.l[0]}
          y1={s.l[1]}
          x2={s.l[2]}
          y2={s.l[3]}
          stroke={outline ? OUTLINE : props.fill}
          strokeWidth={s.l[4] + (outline ? OW * 2 : 0)}
          strokeLinecap="round"
        />
      ),
    );
  return (
    <g>
      {draw(true)}
      {draw(false)}
    </g>
  );
}

const asClip = (shapes: Shape[]) =>
  shapes.map((s, i) =>
    "e" in s ? (
      <ellipse key={i} cx={s.e[0]} cy={s.e[1]} rx={s.e[2]} ry={s.e[3]} />
    ) : (
      <path
        key={i}
        d={capsulePath(s.l)}
      />
    ),
  );

/** Kapsel als Fläche (für Ausschnitte) */
function capsulePath([x1, y1, x2, y2, w]: [number, number, number, number, number]): string {
  const len = Math.hypot(x2 - x1, y2 - y1) || 1;
  const nx = (-(y2 - y1) / len) * (w / 2);
  const ny = ((x2 - x1) / len) * (w / 2);
  const r = w / 2;
  return `M${x1 + nx} ${y1 + ny} L${x2 + nx} ${y2 + ny} A${r} ${r} 0 0 0 ${x2 - nx} ${y2 - ny} L${x1 - nx} ${y1 - ny} A${r} ${r} 0 0 0 ${x1 + nx} ${y1 + ny} Z`;
}

/** Münzstapel: hügelförmig verteilt, die Mitte am höchsten */
export function coinColumns(coins: number): number[] {
  const cols = 9;
  const heights = new Array<number>(cols).fill(0);
  const center = (cols - 1) / 2;
  for (let n = 0; n < coins; n++) {
    let best = 0;
    let bestScore = Infinity;
    for (let i = 0; i < cols; i++) {
      const score = heights[i] + Math.abs(i - center) * 2.2 + (i < center ? 0.01 : 0);
      if (score < bestScore) {
        bestScore = score;
        best = i;
      }
    }
    heights[best]++;
  }
  return heights;
}

const VISIBLE_COINS = 90;

/** Ader als Schlangenlinie von (x, y) in Richtung (dx, dy) */
const vein = (x: number, y: number, dx: number, dy: number, wiggle = 3) => {
  const len = Math.hypot(dx, dy) || 1;
  const px = (-dy / len) * wiggle;
  const py = (dx / len) * wiggle;
  return `M${x} ${y} q${dx * 0.25 + px} ${dy * 0.25 + py} ${dx * 0.5} ${dy * 0.5} t${dx * 0.5} ${dy * 0.5}`;
};

export type BlitziProps = {
  mood: Mood;
  /** Breite in px */
  size?: number;
  /** Entwicklungsstufe 1–30 */
  stage?: number;
  /** Goldmünzen (Serien-Tage nach Stufe 30) */
  coins?: number;
  onTap?: () => void;
  title?: string;
  /** Noch nicht freigeschaltet: nur als Schatten */
  locked?: boolean;
  /** Ohne Bewegung und ohne eigenen Knopf (z. B. Übersicht aller Stufen) */
  still?: boolean;
  /** Breite vom umgebenden Element übernehmen (Team-Szene) */
  fluid?: boolean;
  /** Ohne Boden-Schatten (Szenen mit eigenem Boden) */
  noShadow?: boolean;
  /** Ausgerüstete Items (Prestige) – wachsen mit der Stufe mit */
  items?: string[];
};

export function Blitzi(props: BlitziProps) {
  const [jump, setJump] = useState(0);
  const uid = useId().replace(/[^a-zA-Z0-9]/g, "");
  const { mood } = props;
  const stage = Math.min(MAX_STAGE, Math.max(1, Math.round(props.stage ?? 12)));
  const at = (...values: number[]) => atStage(stage, values);
  const detail = detailOf(stage);
  const coins = Math.max(0, Math.floor(props.coins ?? 0));

  // Münzhaufen
  const cols = coinColumns(Math.min(coins, VISIBLE_COINS));
  const COIN_STEP = 4.2;
  const pileTop = Math.max(0, ...cols) * COIN_STEP;
  const GROUND = 0;
  const seat = GROUND - (pileTop ? pileTop + 3 : 0);
  const vbTop = seat - 262;
  const vbHeight = GROUND + 12 - vbTop;
  const size = props.size ?? 124;

  // ---------------- Maße je Stufe (Eckpunkte 1 · 4 · 8 · 14 · 20 · 27 · 30) ----------------
  const fat = at(1, 0.6, 0, 0, 0, 0, 0);
  const head = { cy: at(-90, -96, -108, -126, -150, -166, -176), rx: at(40, 39, 38, 35, 33, 31, 31), ry: at(33, 33, 33, 31, 29, 28, 28) };
  const jowl = at(17, 10, 0, 0, 0, 0, 0);
  const belly = { cy: at(-46, -46, -46, -50, -52, -54, -55), rx: at(86, 62, 33, 31, 31, 31, 30), ry: at(50, 45, 38, 38, 36, 35, 35) };
  const chest = { cy: at(-66, -74, -76, -92, -106, -116, -120), rx: at(56, 44, 27, 38, 56, 70, 78), ry: at(26, 26, 22, 26, 32, 38, 42) };
  const sh = { x: at(48, 38, 24, 36, 58, 72, 80), y: at(-66, -74, -80, -100, -118, -128, -132), r: at(14, 13, 10, 15, 22, 28, 31) };
  const traps = { rx: at(0, 0, 0, 18, 38, 52, 58), ry: at(0, 0, 0, 9, 18, 24, 27) };
  const lats = at(0, 0, 0, 10, 22, 32, 38);
  const thigh = { x: at(44, 34, 17, 21, 28, 34, 38), y: at(-14, -14, -12, -14, -18, -21, -23), rx: at(30, 24, 13, 17, 24, 30, 34), ry: at(17, 15, 12, 15, 22, 27, 30) };
  const foot = { x: at(60, 48, 23, 28, 36, 42, 46), y: at(-4, -4, -3, -3, -3, -3, -3), rx: at(24, 19, 13, 14, 16, 18, 20), ry: at(16, 13, 8, 9, 10, 11, 12) };
  const arm = { w: at(18, 15, 11, 15, 22, 28, 32), up: at(22, 22, 22, 28, 34, 36, 38), fore: at(22, 22, 20, 26, 30, 33, 35), biceps: at(0, 0, 0, 9, 18, 25, 29) };
  const patch = { cy: at(-46, -46, -48, -54, -58, -61, -62), rx: at(64, 44, 20, 20, 24, 26, 26), ry: at(40, 34, 26, 29, 32, 35, 36) };
  const beltY = at(-36, -38, -38, -40, -44, -46, -47);
  const earScale = at(1, 1.05, 1.15, 1.15, 1.1, 1.05, 1.05);

  // ---------------- Haltung ----------------
  type Pose = "rest" | "cheer" | "flex" | "droop";
  const down = mood === "sad" || mood === "sleepy";
  const pose: Pose = down
    ? "droop"
    : stage >= 20 || (stage >= 14 && (mood === "party" || mood === "proud"))
      ? "flex"
      : mood === "party" || mood === "proud"
        ? "cheer"
        : "rest";
  const angles: Record<Pose, [number, number]> = {
    rest: [at(50, 60, 78, 70, 66, 62, 60), at(150, 130, 96, 100, 96, 94, 92)],
    cheer: [-38, -72],
    flex: [-15, -100],
    droop: [at(58, 64, 84, 76, 70, 64, 62), at(128, 118, 92, 92, 92, 92, 92)],
  };
  const [a1, a2] = angles[pose];
  const armPts = (side: 1 | -1) => {
    const sx = side * sh.x;
    const ex = sx + side * arm.up * Math.cos(rad(a1));
    const ey = sh.y + arm.up * Math.sin(rad(a1));
    const hx = ex + side * arm.fore * Math.cos(rad(a2));
    const hy = ey + arm.fore * Math.sin(rad(a2));
    // Bizeps sitzt außen bzw. oben auf dem Oberarm
    const nx = side * Math.sin(rad(a1));
    const ny = -Math.cos(rad(a1));
    return {
      side,
      sx,
      sy: sh.y,
      ex,
      ey,
      hx,
      hy,
      nx,
      ny,
      bx: sx + (ex - sx) * 0.55 + nx * arm.w * 0.3,
      by: sh.y + (ey - sh.y) * 0.55 + ny * arm.w * 0.3,
    };
  };
  const arms = [armPts(-1), armPts(1)];
  const armShapes = (p: ReturnType<typeof armPts>): Shape[] => [
    { l: [p.sx, p.sy, p.ex, p.ey, arm.w] },
    { l: [p.ex, p.ey, p.hx, p.hy, arm.w * 0.92] },
    ...(arm.biceps > 1 ? [{ e: [p.bx, p.by, arm.biceps, arm.biceps * 0.8] as Ellipse }] : []),
    // Unterarm-Muskel nahe am Ellbogen
    ...(stage >= 14 ? [{ e: [p.ex + (p.hx - p.ex) * 0.3, p.ey + (p.hy - p.ey) * 0.3, arm.w * 0.62, arm.w * 0.62] as Ellipse }] : []),
    { e: [p.hx, p.hy, arm.w * 0.64, arm.w * 0.6] as Ellipse },
  ];

  const torso: Shape[] = [
    { e: [0, belly.cy, belly.rx, belly.ry] },
    { e: [0, chest.cy, chest.rx, chest.ry] },
    ...(lats > 1
      ? ([-1, 1].map((s) => ({ l: [s * (sh.x - sh.r * 0.4), sh.y + sh.r * 0.7, s * belly.rx * 0.78, belly.cy - belly.ry * 0.25, lats] })) as Shape[])
      : []),
    { e: [-sh.x, sh.y, sh.r, sh.r] },
    { e: [sh.x, sh.y, sh.r, sh.r] },
    ...(traps.rx > 1 ? [{ e: [0, head.cy + head.ry * 0.8, traps.rx, traps.ry] as Ellipse }] : []),
  ];
  const legs: Shape[] = [
    { e: [-thigh.x, thigh.y, thigh.rx, thigh.ry] },
    { e: [thigh.x, thigh.y, thigh.rx, thigh.ry] },
    { e: [-foot.x, foot.y, foot.rx, foot.ry] },
    { e: [foot.x, foot.y, foot.rx, foot.ry] },
  ];
  const headShapes: Shape[] = [
    { e: [0, head.cy, head.rx, head.ry] },
    ...(jowl > 1
      ? ([-1, 1].map((s) => ({ e: [s * head.rx * 0.55, head.cy + head.ry * 0.55, jowl * 1.25, jowl] })) as Shape[])
      : []),
  ];

  // ---------------- Kappe ----------------
  const capBase = head.cy - head.ry * 0.3;
  const capRx = head.rx * 1.04;
  const capRy = head.ry * 1.07;
  const capHalf = capRx * Math.sqrt(1 - ((capBase - head.cy) / capRy) ** 2);
  const logo = { y: head.cy - head.ry * 0.66, r: head.rx * 0.25 };

  // ---------------- Gesicht ----------------
  const eye = { x: head.rx * 0.38, y: head.cy + 3, rx: 6, ry: mood === "sad" ? 6.2 : 7.4 };
  const lid = mood === "sleepy" || mood === "party" ? 0 : fat * 0.48; // schwere Lider bei den runden Stufen
  const sweat = stage >= 10;
  const belt = stage >= 12;
  const gold = stage >= MAX_STAGE;
  const donut = stage <= 3;
  const grin = stage >= 20;

  // Ankerpunkte für Items (wachsen mit der Stufe mit)
  const anchors: Anchors = {
    head: { cy: head.cy, rx: head.rx, ry: head.ry },
    eye: { x: eye.x, y: eye.y },
    mouthY: head.cy + 15,
    neckY: head.cy + head.ry * 0.85,
    chest: { cy: chest.cy, rx: chest.rx },
    beltY,
    bellyRx: Math.max(belly.rx, chest.rx * 0.8),
    hands: arms.map((p) => ({ x: p.hx, y: p.hy })),
    arms: arms.map((p) => ({ x: (p.sx + p.ex) / 2, y: (p.sy + p.ey) / 2, w: arm.w })),
    feet: [-1, 1].map((s) => ({ x: s * foot.x, y: foot.y, rx: foot.rx })),
    torsoClip: `${uid}-torso`,
  };

  const tap = () => {
    setJump((j) => j + 1);
    props.onTap?.();
  };

  const eyesFor = (side: 1 | -1): ReactNode => {
    const cx = side * eye.x;
    if (mood === "sleepy")
      return <path d={`M${cx - 6} ${eye.y} q6 5 12 0`} stroke={OUTLINE} strokeWidth="3" fill="none" strokeLinecap="round" />;
    if (mood === "party")
      return <path d={`M${cx - 6} ${eye.y + 2} q6 -9 12 0`} stroke={OUTLINE} strokeWidth="3.4" fill="none" strokeLinecap="round" />;
    const clip = `${uid}-eye${side}`;
    return (
      <g>
        <clipPath id={clip}>
          <ellipse cx={cx} cy={eye.y} rx={eye.rx} ry={eye.ry} />
        </clipPath>
        <ellipse cx={cx} cy={eye.y} rx={eye.rx} ry={eye.ry} fill="#1c1209" stroke={OUTLINE} strokeWidth="1.6" />
        <g clipPath={`url(#${clip})`}>
          <circle cx={cx + 1.8} cy={eye.y - 2.4} r="2.3" fill="#fff" />
          <circle cx={cx - 2} cy={eye.y + 2.6} r="1" fill="#fff" opacity="0.8" />
          {lid > 0 && <rect x={cx - 8} y={eye.y - eye.ry - 1} width="16" height={eye.ry * 2 * lid + 1} fill={YELLOW_TOP} />}
        </g>
        {lid > 0 && (
          <path
            d={`M${cx - eye.rx - 0.5} ${eye.y - eye.ry + eye.ry * 2 * lid} q${eye.rx} 2.5 ${eye.rx * 2 + 1} 0`}
            stroke={OUTLINE}
            strokeWidth="2"
            fill="none"
            strokeLinecap="round"
          />
        )}
      </g>
    );
  };

  const mouth = (() => {
    const y = head.cy + 15;
    if (mood === "party" || mood === "proud" || (grin && !down))
      return (
        <g>
          <path d={`M-9 ${y - 1} q9 15 18 0 z`} fill="#6a1f12" stroke={OUTLINE} strokeWidth="2" strokeLinejoin="round" />
          <path d={`M-4.5 ${y + 6} q4.5 -4 9 0 q-4.5 3 -9 0z`} fill="#ff7b8a" />
          {grin && <path d={`M-7 ${y} h14`} stroke="#fff" strokeWidth="2.4" strokeLinecap="round" />}
        </g>
      );
    if (mood === "sad") return <path d={`M-6 ${y + 4} q6 -6 12 0`} stroke={OUTLINE} strokeWidth="2.6" fill="none" strokeLinecap="round" />;
    if (mood === "sleepy") return <ellipse cx="0" cy={y + 2} rx="3" ry="2.6" fill="#6a1f12" />;
    const wide = mood === "happy" ? 1 : 0.7;
    return (
      <path
        d={`M${-8 * wide} ${y} q${4 * wide} ${5 * wide} ${8 * wide} 0 q${4 * wide} ${5 * wide} ${8 * wide} 0`}
        stroke={OUTLINE}
        strokeWidth="2.6"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    );
  })();

  const bolt = (x: number, y: number, s: number, fill: string, stroke = OUTLINE, sw = 1.4) => (
    <path
      d={`M${x + 1.5 * s} ${y - 5 * s} L${x - 2.6 * s} ${y + 0.6 * s} H${x + 0.2 * s} L${x - 1.4 * s} ${y + 5 * s} L${x + 2.8 * s} ${y - 0.8 * s} H${x}  Z`}
      fill={fill}
      stroke={stroke}
      strokeWidth={sw}
      strokeLinejoin="round"
    />
  );

  // Ohr als Blitz (rechte Seite; links gespiegelt)
  const ear = (side: 1 | -1) => (
    <g transform={`translate(${side * head.rx * 0.58} ${head.cy - head.ry * 0.72}) scale(${side * earScale} ${earScale}) rotate(14)`}>
      <path
        d="M-9 6 L4 -20 L-3 -20 L12 -46 L15 -44 L9 -24 L17 -24 L6 6 Z"
        fill={`url(#${uid}-ear)`}
        stroke={OUTLINE}
        strokeWidth={OW / earScale}
        strokeLinejoin="round"
      />
    </g>
  );

  // ---------------- Muskel-Details ----------------
  const absRows = detail.abs >= 4 ? 4 : detail.abs >= 2 ? 3 : 2;
  const absStroke = detail.abs >= 3 ? 2.6 : 2;
  const absGap = 3;
  const absBlock = { w: patch.rx * 0.74, h: (patch.ry * 1.6) / absRows - absGap };
  const absTop = patch.cy - patch.ry * 0.8;

  const veinsFor = (p: ReturnType<typeof armPts>) => {
    if (!detail.veins || arm.biceps < 1) return null;
    const out: string[] = [];
    // Bizeps
    out.push(vein(p.bx - p.side * arm.biceps * 0.55, p.by + 2, p.side * arm.biceps * 1.1, -arm.biceps * 0.2, 2.6));
    if (detail.veins >= 3) out.push(vein(p.bx - p.side * arm.biceps * 0.1, p.by + 1, p.side * arm.biceps * 0.4, -arm.biceps * 0.65, 2));
    if (detail.veins >= 2) {
      // Unterarm
      const fx = p.ex + (p.hx - p.ex) * 0.25;
      const fy = p.ey + (p.hy - p.ey) * 0.25;
      out.push(vein(fx, fy, (p.hx - p.ex) * 0.5, (p.hy - p.ey) * 0.5, 2.4));
      out.push(vein(p.bx, p.by - arm.biceps * 0.35, p.side * arm.biceps * 0.7, arm.biceps * 0.4, 2));
    }
    if (detail.veins >= 4) {
      // Schulter
      out.push(vein(p.sx - p.side * sh.r * 0.3, p.sy - sh.r * 0.5, p.side * sh.r * 0.9, sh.r * 0.6, 2));
      out.push(vein(fx2(p), fy2(p), (p.hx - p.ex) * 0.35, (p.hy - p.ey) * 0.35, 1.8));
    }
    return out;
  };
  const fx2 = (p: ReturnType<typeof armPts>) => p.ex + (p.hx - p.ex) * 0.5 + p.side * 3;
  const fy2 = (p: ReturnType<typeof armPts>) => p.ey + (p.hy - p.ey) * 0.5;

  const Tag = props.still ? "span" : "button";
  return (
    <Tag
      {...(props.still ? { role: "img" } : { type: "button" as const, onClick: tap })}
      className={`blitzi is-${mood}${props.locked ? " is-locked" : ""}${props.still ? " is-still" : ""}`}
      aria-label={props.title ?? "Blitzi"}
      title={props.title ?? "Blitzi antippen"}
      style={props.fluid ? { width: "100%", aspectRatio: `${VB_W} / ${vbHeight}` } : { width: size, height: (size * vbHeight) / VB_W }}
    >
      <svg key={jump} className={jump ? "blitzi-svg is-jump" : "blitzi-svg"} viewBox={`${-VB_W / 2} ${vbTop} ${VB_W} ${vbHeight}`} aria-hidden>
        <defs>
          <linearGradient id={`${uid}-body`} gradientUnits="userSpaceOnUse" x1="0" y1={head.cy - head.ry} x2="0" y2="0">
            <stop offset="0" stopColor={YELLOW_TOP} />
            <stop offset="1" stopColor={YELLOW_BOTTOM} />
          </linearGradient>
          <linearGradient id={`${uid}-ear`} x1="0" y1="1" x2="0" y2="0">
            <stop offset="0.6" stopColor={YELLOW_TOP} />
            <stop offset="0.61" stopColor="#ff8a3d" />
          </linearGradient>
          <radialGradient id={`${uid}-glow`}>
            <stop offset="0" stopColor="#fff2a8" stopOpacity="0.95" />
            <stop offset="1" stopColor="#ffd84a" stopOpacity="0" />
          </radialGradient>
          <clipPath id={`${uid}-torso`}>{asClip(torso)}</clipPath>
        </defs>

        {/* Boden */}
        {!props.noShadow && <ellipse cx="0" cy={GROUND + 4} rx={at(92, 72, 46, 56, 70, 82, 88) + (pileTop ? 20 : 0)} ry="7" fill="#000" opacity="0.1" />}

        {/* Leuchten ab Stufe 30 */}
        {gold && !props.locked && <ellipse className="blitzi-glow" cx="0" cy={seat - 120} rx="135" ry="140" fill={`url(#${uid}-glow)`} />}

        {/* Goldmünzen */}
        {pileTop > 0 && (
          <g className="blitzi-coins">
            {cols.map((h, i) =>
              Array.from({ length: h }, (_, j) => {
                const x = (i - (cols.length - 1) / 2) * 19.5;
                const y = GROUND - j * COIN_STEP;
                return (
                  <g key={`${i}-${j}`}>
                    <ellipse cx={x} cy={y} rx="10.5" ry="4" fill={GOLD_DARK} stroke={OUTLINE} strokeWidth="1.2" />
                    <ellipse cx={x} cy={y - 1.6} rx="10.5" ry="4" fill={GOLD} stroke={GOLD_DARK} strokeWidth="1" />
                    {j === h - 1 && <ellipse cx={x - 2.5} cy={y - 2.4} rx="4" ry="1.2" fill="#fff6c9" opacity="0.9" />}
                  </g>
                );
              }),
            )}
          </g>
        )}

        <g transform={`translate(0 ${seat})`}>
          {/* EMS-Kabel als Schwanz */}
          <g className="blitzi-tail">
            {(() => {
              const x0 = belly.rx * 0.55;
              const xe = Math.min(belly.rx + 18, 112);
              const xc = Math.min(belly.rx + 32, 122);
              const d = `M${x0} -12 C${xc} -4 ${xc} -40 ${xe} -58`;
              return (
                <>
                  <path d={d} stroke={OUTLINE} strokeWidth="6" fill="none" strokeLinecap="round" />
                  <path d={d} stroke="#5b6478" strokeWidth="2.6" fill="none" strokeLinecap="round" />
                  <g transform={`translate(${xe} -62) rotate(-30)`}>
                    <rect x="-7" y="-9" width="14" height="13" rx="4" fill={NAVY} stroke={OUTLINE} strokeWidth="2" />
                    <circle cx="0" cy="-2.5" r="3" fill="#7fd3ff" />
                  </g>
                </>
              );
            })()}
          </g>

          {itemLayer(props.items, anchors, "back")}
          {ear(-1)}
          {ear(1)}

          {/* Rumpf */}
          <Blob shapes={torso} fill={`url(#${uid}-body)`} />

          {/* Bauch */}
          <ellipse cx="0" cy={patch.cy} rx={patch.rx} ry={patch.ry} fill={CREAM} />
          {detail.abs > 0 && (
            <g opacity={detail.abs === 1 ? 0.55 : 1}>
              {Array.from({ length: absRows }, (_, r) =>
                [-1, 1].map((s) => (
                  <rect
                    key={`${r}${s}`}
                    x={s < 0 ? -absBlock.w - absGap / 2 : absGap / 2}
                    y={absTop + r * (absBlock.h + absGap)}
                    width={absBlock.w}
                    height={absBlock.h}
                    rx={Math.min(4, absBlock.h / 3)}
                    fill={detail.abs >= 3 ? "#ffd977" : detail.abs >= 2 ? "#ffe9a8" : "none"}
                    stroke={MUSCLE}
                    strokeWidth={absStroke}
                  />
                )),
              )}
            </g>
          )}
          {detail.abs >= 5 && (
            <g stroke={MUSCLE} strokeWidth="2.2" strokeLinecap="round" fill="none">
              {[-1, 1].map((s) =>
                [0, 1, 2].map((i) => (
                  <path key={`${s}${i}`} d={`M${s * (patch.rx + 3)} ${patch.cy - patch.ry * 0.55 + i * 9} q${s * 6} -2 ${s * 10} -7`} />
                )),
              )}
            </g>
          )}

          {/* Brust */}
          {detail.pecs > 0 && (
            <g stroke={MUSCLE} strokeWidth={detail.pecs >= 2 ? 2.8 : 2.2} fill="none" strokeLinecap="round">
              <path d={`M0 ${chest.cy - chest.ry * 0.55} V${chest.cy + chest.ry * 0.45}`} />
              <path d={`M-2 ${chest.cy + chest.ry * 0.45} q${-chest.rx * 0.45} ${chest.ry * 0.25} ${-chest.rx * 0.82} ${-chest.ry * 0.3}`} />
              <path d={`M2 ${chest.cy + chest.ry * 0.45} q${chest.rx * 0.45} ${chest.ry * 0.25} ${chest.rx * 0.82} ${-chest.ry * 0.3}`} />
              {detail.pecs >= 2 &&
                [-1, 1].map((s) =>
                  [0, 1, 2].map((i) => (
                    <path
                      key={`${s}${i}`}
                      strokeWidth="1.6"
                      d={`M${s * (chest.rx * 0.18 + i * 7)} ${chest.cy + chest.ry * 0.28 - i * 3} q${s * chest.rx * 0.18} ${-chest.ry * 0.3} ${s * chest.rx * 0.36} ${-chest.ry * 0.62}`}
                    />
                  )),
                )}
            </g>
          )}
          {detail.lats && (
            <g stroke={MUSCLE} strokeWidth="2.4" fill="none" strokeLinecap="round">
              {[-1, 1].map((s) => (
                <path key={s} d={`M${s * (sh.x - sh.r * 0.2)} ${sh.y + sh.r * 1.1} Q${s * (sh.x - 4)} ${belly.cy - 30} ${s * (belly.rx + 2)} ${belly.cy - belly.ry * 0.2}`} />
              ))}
            </g>
          )}
          {detail.veins >= 2 && (
            <g stroke={VEIN} strokeWidth="1.8" fill="none" strokeLinecap="round" opacity="0.85">
              <path d={vein(-chest.rx * 0.55, chest.cy - chest.ry * 0.2, chest.rx * 0.3, -chest.ry * 0.35, 2)} />
              {detail.veins >= 4 && <path d={vein(chest.rx * 0.5, chest.cy - chest.ry * 0.3, -chest.rx * 0.25, -chest.ry * 0.3, 2)} />}
              {detail.veins >= 4 && <path d={vein(-traps.rx * 0.55, head.cy + head.ry * 0.85, traps.rx * 0.25, traps.ry * 0.5, 1.6)} />}
            </g>
          )}

          {/* EMS-Gurt */}
          {belt && (
            <g clipPath={`url(#${uid}-torso)`}>
              <rect x="-150" y={beltY} width="300" height="11" fill={gold ? GOLD : NAVY} stroke={OUTLINE} strokeWidth="2" />
              {gold ? (
                <g>
                  <rect x="-14" y={beltY - 5} width="28" height="21" rx="5" fill={GOLD} stroke={GOLD_DARK} strokeWidth="2" />
                  {bolt(0, beltY + 5.5, 1.4, "#fff6c9", GOLD_DARK, 1.2)}
                </g>
              ) : (
                <g fill="#7fd3ff" stroke={OUTLINE} strokeWidth="1.2">
                  <circle cx="-10" cy={beltY + 5.5} r="3.2" />
                  <circle cx="10" cy={beltY + 5.5} r="3.2" />
                </g>
              )}
            </g>
          )}

          {itemLayer(props.items, anchors, "body")}

          {/* Beine */}
          <Blob shapes={legs} fill={`url(#${uid}-body)`} />
          {fat > 0 && (
            <g opacity={fat}>
              {[-1, 1].map((s) => (
                <g key={s}>
                  <ellipse cx={s * foot.x} cy={foot.y + 2} rx={foot.rx * 0.62} ry={foot.ry * 0.6} fill={CREAM} />
                  {[-1, 0, 1].map((i) => (
                    <circle key={i} cx={s * foot.x + i * foot.rx * 0.42} cy={foot.y - foot.ry * 0.62} r="2.6" fill={CREAM} />
                  ))}
                </g>
              ))}
            </g>
          )}
          {detail.quads > 0 && (
            <g stroke={MUSCLE} strokeWidth="2.2" fill="none" strokeLinecap="round">
              {[-1, 1].map((s) => (
                <g key={s}>
                  <path d={`M${s * (thigh.x - thigh.rx * 0.2)} ${thigh.y - thigh.ry * 0.9} Q${s * (thigh.x - thigh.rx * 0.75)} ${thigh.y} ${s * (thigh.x - thigh.rx * 0.15)} ${thigh.y + thigh.ry * 0.85}`} />
                  {detail.quads >= 2 && (
                    <path d={`M${s * (thigh.x + thigh.rx * 0.15)} ${thigh.y - thigh.ry * 0.9} Q${s * (thigh.x + thigh.rx * 0.75)} ${thigh.y - thigh.ry * 0.1} ${s * (thigh.x + thigh.rx * 0.3)} ${thigh.y + thigh.ry * 0.8}`} />
                  )}
                  {detail.veins >= 3 && (
                    <path stroke={VEIN} strokeWidth="1.8" opacity="0.85" d={vein(s * (thigh.x - thigh.rx * 0.2), thigh.y - thigh.ry * 0.7, s * thigh.rx * 0.4, thigh.ry * 1.1, 2)} />
                  )}
                </g>
              ))}
            </g>
          )}

          {/* Kopf */}
          <Blob shapes={headShapes} fill={`url(#${uid}-body)`} />

          {/* Kappe */}
          <g className="blitzi-cap">
            <path
              d={`M${-capHalf} ${capBase} A${capRx} ${capRy} 0 0 1 ${capHalf} ${capBase} Z`}
              fill={CAP}
              stroke={OUTLINE}
              strokeWidth={OW}
              strokeLinejoin="round"
            />
            <path d={`M${-capHalf * 0.55} ${head.cy - head.ry * 0.92} q${capHalf * 0.3} -6 ${capHalf * 0.7} -4`} stroke="#4a4a55" strokeWidth="3" fill="none" strokeLinecap="round" />
            <path
              d={`M${-capHalf - 4} ${capBase} Q0 ${capBase + 17} ${capHalf + 4} ${capBase} Q0 ${capBase + 5} ${-capHalf - 4} ${capBase} Z`}
              fill="#2c2c34"
              stroke={OUTLINE}
              strokeWidth="2.4"
              strokeLinejoin="round"
            />
            <circle cx="0" cy={logo.y} r={logo.r} fill="#fff" stroke="#d9d9de" strokeWidth="1.2" />
            {bolt(0, logo.y, logo.r / 6.2, gold ? GOLD : YELLOW_BOTTOM, OUTLINE, 1.3)}
          </g>

          {/* Gesicht */}
          <g className="blitzi-face">
            <g className="blitzi-eyes">
              {eyesFor(-1)}
              {eyesFor(1)}
            </g>
            {mood === "sad" && (
              <g stroke={OUTLINE} strokeWidth="2.2" strokeLinecap="round">
                {[-1, 1].map((s) => (
                  <path key={s} d={`M${s * (eye.x + 7)} ${eye.y - 11} L${s * (eye.x - 5)} ${eye.y - 14}`} />
                ))}
              </g>
            )}
            {/* Bäckchen als kleine Blitze */}
            {bolt(-head.rx * 0.7, head.cy + 12, 1.5, CHEEK, "#c8361f", 1)}
            {bolt(head.rx * 0.7, head.cy + 12, 1.5, CHEEK, "#c8361f", 1)}
            <ellipse cx="0" cy={head.cy + 9.5} rx="2.4" ry="1.6" fill={OUTLINE} />
            {mouth}
            {mood === "sad" && <path className="blitzi-tear" d={`M${-eye.x - 3} ${eye.y + 9} q-3 6 0 8 q3 -2 0 -8z`} fill="#7fc8ff" />}
          </g>

          {/* Arme */}
          {arms.map((p, i) => (
            <g key={i}>
              <Blob shapes={armShapes(p)} fill={`url(#${uid}-body)`} />
              {sweat && (
                <line
                  x1={p.hx + (p.ex - p.hx) * 0.3}
                  y1={p.hy + (p.ey - p.hy) * 0.3}
                  x2={p.hx + (p.ex - p.hx) * 0.46}
                  y2={p.hy + (p.ey - p.hy) * 0.46}
                  stroke="#e5484d"
                  strokeWidth={arm.w * 0.92 + 1}
                />
              )}
              {arm.biceps > 8 && (
                <path
                  d={`M${p.bx - p.side * arm.biceps * 0.2 - p.nx * arm.biceps * 0.5} ${p.by - p.ny * arm.biceps * 0.5} q${-p.nx * 3} ${-p.ny * 3 + 6} ${p.side * arm.biceps * 0.5} ${arm.biceps * 0.15}`}
                  stroke={MUSCLE}
                  strokeWidth="2"
                  fill="none"
                  strokeLinecap="round"
                  opacity="0.7"
                />
              )}
              {veinsFor(p)?.map((d, j) => (
                <path key={j} d={d} stroke={VEIN} strokeWidth={detail.veins >= 3 ? 2.6 : 2} fill="none" strokeLinecap="round" opacity="0.9" />
              ))}
            </g>
          ))}

          {/* Donut in der Hand (nur ganz am Anfang) */}
          {donut && (
            <g transform={`translate(${arms[0].hx - 4} ${arms[0].hy - 6})`}>
              <path d="M0 -10 a10 10 0 1 0 0.01 0 Z M0 -3.5 a3.5 3.5 0 1 1 -0.01 0 Z" fillRule="evenodd" fill="#c98b4a" stroke={OUTLINE} strokeWidth="1.6" />
              <path d="M0 -8.4 a8.4 8.4 0 1 0 0.01 0 Z M0 -4.5 a4.5 4.5 0 1 1 -0.01 0 Z" fillRule="evenodd" fill="#ff8fb8" />
              <g stroke="#fff" strokeWidth="1.4" strokeLinecap="round">
                <path d="M-5 -5 l1.5 1" />
                <path d="M4 -6 l1 1.5" />
                <path d="M5 3 l-1.5 1" />
              </g>
            </g>
          )}

          {/* Funken bei guter Laune */}
          {(mood === "party" || mood === "proud") && (
            <g className="blitzi-sparks" fill="#ffcf33" stroke={OUTLINE} strokeWidth="1">
              <path d={`M-104 ${head.cy - 20} l3 8 8 3 -8 3 -3 8 -3 -8 -8 -3 8 -3z`} />
              <path d={`M100 ${head.cy - 44} l2 6 6 2 -6 2 -2 6 -2 -6 -6 -2 6 -2z`} />
              <path d="M110 -96 l2.5 7 7 2.5 -7 2.5 -2.5 7 -2.5 -7 -7 -2.5 7 -2.5z" />
              {mood === "party" && <path d="M-112 -70 l2 5 5 2 -5 2 -2 5 -2 -5 -5 -2 5 -2z" />}
            </g>
          )}

          {mood === "sleepy" && (
            <g className="blitzi-zzz" fill="#8a7fb8" fontFamily="system-ui, sans-serif" fontWeight="700">
              <text x={head.rx + 6} y={head.cy - head.ry - 4} fontSize="16">
                z
              </text>
              <text x={head.rx + 18} y={head.cy - head.ry - 18} fontSize="12">
                z
              </text>
              <text x={head.rx + 28} y={head.cy - head.ry - 30} fontSize="9">
                z
              </text>
            </g>
          )}

          {itemLayer(props.items, anchors, "front")}
        </g>
      </svg>
    </Tag>
  );
}
