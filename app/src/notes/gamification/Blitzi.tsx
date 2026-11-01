// Blitzi – das Maskottchen: ein gelbes Elektro-Tierchen mit schwarzer Kappe (weißer Kreis + Blitz), Blitz-Ohren
// und EMS-Kabel als Schwanz. Eigene Figur (SVG, keine fremden Vorlagen).
// Entwicklung über 30 Stufen: rund und gemütlich → sportlich → Muskelpaket; danach sitzt er auf Goldmünzen.
// Stimmungen: party, proud, happy, neutral, sleepy, sad. Als männliche und weibliche Variante.
import "./blitzi.css";
import { useId, useState, type ReactNode } from "react";
import { buffOf, MAX_STAGE, type BlitziKind } from "./evolution";
import type { Mood } from "./stats";

const OUTLINE = "#3a2914";
const YELLOW_TOP = "#ffe066";
const YELLOW_BOTTOM = "#ffbf1f";
const CREAM = "#fff3c9";
const ORANGE = "#ff8a3d";
const CAP = "#1d1d22";
const NAVY = "#24336b";
const GOLD = "#f6c544";
const GOLD_DARK = "#b9861a";
const OW = 3; // sichtbare Konturbreite

/** Wert zwischen den Eckpunkten rund (0) · normal (0,5) · Muskelpaket (1) */
const k3 = (a: number, b: number, c: number, t: number) => (t < 0.5 ? a + (b - a) * t * 2 : b + (c - b) * (t - 0.5) * 2);
const rad = (deg: number) => (deg * Math.PI) / 180;
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

type Shape =
  | { e: [number, number, number, number] } // Ellipse cx, cy, rx, ry
  | { l: [number, number, number, number, number] }; // Kapsel x1, y1, x2, y2, Breite

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
  shapes.map((s, i) => ("e" in s ? <ellipse key={i} cx={s.e[0]} cy={s.e[1]} rx={s.e[2]} ry={s.e[3]} /> : null));

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

export type BlitziProps = {
  mood: Mood;
  /** Breite in px */
  size?: number;
  /** Entwicklungsstufe 1–30 */
  stage?: number;
  /** Goldmünzen (Serien-Tage nach Stufe 30) */
  coins?: number;
  kind?: BlitziKind | null;
  onTap?: () => void;
  title?: string;
  /** Noch nicht freigeschaltet: nur als Schatten */
  locked?: boolean;
  /** Ohne Bewegung (z. B. Übersicht aller Stufen) */
  still?: boolean;
};

export function Blitzi(props: BlitziProps) {
  const [jump, setJump] = useState(0);
  const uid = useId().replace(/[^a-zA-Z0-9]/g, "");
  const { mood } = props;
  const stage = Math.min(MAX_STAGE, Math.max(1, Math.round(props.stage ?? 12)));
  const t = buffOf(stage);
  const kind = props.kind ?? null;
  const coins = Math.max(0, Math.floor(props.coins ?? 0));

  // Münzhaufen
  const cols = coinColumns(Math.min(coins, VISIBLE_COINS));
  const COIN_STEP = 4.2;
  const pileTop = Math.max(0, ...cols) * COIN_STEP;
  const GROUND = 0;
  const seat = GROUND - (pileTop ? pileTop + 3 : 0); // Sitzhöhe
  const TOP = -236;
  const vbTop = seat + TOP;
  const vbHeight = GROUND + 12 - vbTop;
  const size = props.size ?? 112;

  // ---------------- Maße je Stufe ----------------
  const head = { cy: k3(-112, -126, -146, t), rx: k3(41, 36, 33, t), ry: k3(34, 33, 30, t) };
  const belly = { cy: k3(-52, -55, -52, t), rx: k3(76, 35, 30, t), ry: k3(54, 41, 33, t) };
  const chest = { cy: k3(-84, -88, -100, t), rx: k3(52, 28, 52, t), ry: k3(32, 24, 30, t) };
  const sh = { x: k3(44, 26, 55, t), y: k3(-90, -94, -110, t), r: k3(15, 11, 21, t) };
  const traps = { rx: k3(0, 12, 34, t), ry: k3(0, 8, 16, t) };
  const thigh = { x: k3(40, 17, 26, t), y: k3(-16, -14, -16, t), rx: k3(28, 13, 22, t), ry: k3(18, 13, 18, t) };
  const foot = { x: k3(56, 24, 34, t), y: k3(-5, -3, -3, t), rx: k3(22, 13, 16, t), ry: k3(16, 8, 10, t) };
  const arm = { w: k3(17, 11, 20, t), up: k3(24, 26, 34, t), fore: k3(24, 24, 30, t), biceps: k3(0, 0, 15, t) };
  const patch = { cy: k3(-48, -52, -56, t), rx: k3(54, 20, 19, t), ry: k3(40, 26, 27, t) };

  // ---------------- Haltung ----------------
  const strong = stage >= 23;
  type Pose = "rest" | "cheer" | "flex" | "droop";
  const pose: Pose =
    mood === "sad" || mood === "sleepy"
      ? "droop"
      : mood === "party"
        ? t >= 0.55
          ? "flex"
          : "cheer"
        : mood === "proud"
          ? t >= 0.45
            ? "flex"
            : "cheer"
          : strong
            ? "flex"
            : "rest";
  const angles: Record<Pose, [number, number]> = {
    rest: [k3(52, 78, 68, t), k3(150, 96, 100, t)],
    cheer: [-38, -72],
    flex: [-6, -98],
    droop: [k3(60, 84, 76, t), k3(128, 92, 92, t)],
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
    return { sx, sy: sh.y, ex, ey, hx, hy, bx: (sx + ex) / 2 + nx * arm.w * 0.32, by: (sh.y + ey) / 2 + ny * arm.w * 0.32 };
  };
  const arms = [armPts(-1), armPts(1)];
  const armShapes = (p: ReturnType<typeof armPts>): Shape[] => [
    { l: [p.sx, p.sy, p.ex, p.ey, arm.w] },
    { l: [p.ex, p.ey, p.hx, p.hy, arm.w * k3(1, 1, 0.9, t)] },
    ...(arm.biceps > 1 ? [{ e: [p.bx, p.by, arm.biceps, arm.biceps * 0.82] as [number, number, number, number] }] : []),
    { e: [p.hx, p.hy, arm.w * 0.62, arm.w * 0.6] as [number, number, number, number] },
  ];

  const torso: Shape[] = [
    { e: [0, belly.cy, belly.rx, belly.ry] },
    { e: [0, chest.cy, chest.rx, chest.ry] },
    { e: [-sh.x, sh.y, sh.r, sh.r] },
    { e: [sh.x, sh.y, sh.r, sh.r] },
    ...(traps.rx > 1 ? [{ e: [0, head.cy + head.ry * 0.75, traps.rx, traps.ry] as [number, number, number, number] }] : []),
  ];
  const legs: Shape[] = [
    { e: [-thigh.x, thigh.y, thigh.rx, thigh.ry] },
    { e: [thigh.x, thigh.y, thigh.rx, thigh.ry] },
    { e: [-foot.x, foot.y, foot.rx, foot.ry] },
    { e: [foot.x, foot.y, foot.rx, foot.ry] },
  ];

  // ---------------- Kappe ----------------
  const capBase = head.cy - head.ry * 0.3;
  const capRx = head.rx * 1.04;
  const capRy = head.ry * 1.07;
  const capHalf = capRx * Math.sqrt(1 - ((capBase - head.cy) / capRy) ** 2);
  const logo = { y: head.cy - head.ry * 0.66, r: head.rx * 0.25 };

  // ---------------- Gesicht ----------------
  const eye = { x: head.rx * 0.37, y: head.cy + 2, rx: 6.4, ry: mood === "sad" ? 6.6 : 8 };
  const lid = mood === "sleepy" || mood === "party" ? 0 : clamp01((0.32 - t) / 0.32) * 0.5; // schwere Lider bei den runden Stufen
  const sweat = stage >= 10;
  const belt = stage >= 12;
  const beltY = k3(-36, -40, -47, t);
  const gold = stage >= MAX_STAGE;
  const abs = clamp01((stage - 17) / 6);
  const pecs = clamp01((t - 0.55) / 0.3);
  const veins = stage >= 26 && arm.biceps > 1;
  const donut = stage <= 4;
  const soles = clamp01((0.4 - t) / 0.25);
  const bandColor = kind === "w" ? "#ff5fa2" : "#e5484d";

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
        <ellipse cx={cx} cy={eye.y} rx={eye.rx} ry={eye.ry} fill="#fff" stroke={OUTLINE} strokeWidth="2" />
        <g clipPath={`url(#${clip})`}>
          <circle cx={cx + side * 0.6} cy={eye.y + (mood === "sad" ? 1.8 : 0.8)} r="4.4" fill="#22160a" />
          <circle cx={cx + 1.6} cy={eye.y - 1.6} r="1.5" fill="#fff" />
          {lid > 0 && <rect x={cx - 8} y={eye.y - eye.ry - 1} width="16" height={eye.ry * 2 * lid + 1} fill={YELLOW_TOP} />}
        </g>
        {lid > 0 && (
          <path
            d={`M${cx - eye.rx} ${eye.y - eye.ry + eye.ry * 2 * lid} q${eye.rx} 2 ${eye.rx * 2} 0`}
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
    const y = head.cy + 16;
    if (mood === "party" || mood === "proud")
      return (
        <g>
          <path d={`M-9 ${y - 1} q9 15 18 0 z`} fill="#6a1f12" stroke={OUTLINE} strokeWidth="2" strokeLinejoin="round" />
          <path d={`M-4.5 ${y + 6} q4.5 -4 9 0 q-4.5 3 -9 0z`} fill="#ff7b8a" />
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
    <g transform={`translate(${side * head.rx * 0.6} ${head.cy - head.ry * 0.72}) scale(${side} 1) rotate(16)`}>
      <path
        d="M-9 6 L4 -20 L-3 -20 L12 -46 L15 -44 L9 -24 L17 -24 L6 6 Z"
        fill={`url(#${uid}-ear)`}
        stroke={OUTLINE}
        strokeWidth={OW}
        strokeLinejoin="round"
      />
    </g>
  );

  // Nur zur Ansicht (Auswahl, Übersicht): kein eigener Knopf – darf in anderen Knöpfen stehen
  const Tag = props.still ? "span" : "button";
  return (
    <Tag
      {...(props.still ? { role: "img" } : { type: "button" as const, onClick: tap })}
      className={`blitzi is-${mood}${props.locked ? " is-locked" : ""}${props.still ? " is-still" : ""}`}
      aria-label={props.title ?? "Blitzi"}
      title={props.title ?? "Blitzi antippen"}
      style={{ width: size, height: (size * vbHeight) / 200 }}
    >
      <svg key={jump} className={jump ? "blitzi-svg is-jump" : "blitzi-svg"} viewBox={`-100 ${vbTop} 200 ${vbHeight}`} aria-hidden>
        <defs>
          <linearGradient id={`${uid}-body`} gradientUnits="userSpaceOnUse" x1="0" y1={head.cy - head.ry} x2="0" y2="0">
            <stop offset="0" stopColor={YELLOW_TOP} />
            <stop offset="1" stopColor={YELLOW_BOTTOM} />
          </linearGradient>
          <linearGradient id={`${uid}-ear`} x1="0" y1="1" x2="0" y2="0">
            <stop offset="0.55" stopColor={YELLOW_TOP} />
            <stop offset="0.56" stopColor={ORANGE} />
          </linearGradient>
          <radialGradient id={`${uid}-glow`}>
            <stop offset="0" stopColor="#fff2a8" stopOpacity="0.95" />
            <stop offset="1" stopColor="#ffd84a" stopOpacity="0" />
          </radialGradient>
          <clipPath id={`${uid}-torso`}>{asClip(torso)}</clipPath>
        </defs>

        {/* Boden */}
        <ellipse cx="0" cy={GROUND + 4} rx={Math.max(60, k3(84, 50, 70, t)) + (pileTop ? 20 : 0)} ry="7" fill="#000" opacity="0.1" />

        {/* Leuchten ab Stufe 30 */}
        {gold && !props.locked && <ellipse className="blitzi-glow" cx="0" cy={seat - 110} rx="100" ry="118" fill={`url(#${uid}-glow)`} />}

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
            <path
              d={`M${belly.rx * 0.55} -12 C${Math.min(belly.rx + 30, 92)} -4 ${Math.min(belly.rx + 30, 92)} -40 ${Math.min(belly.rx + 16, 84)} -58`}
              stroke={OUTLINE}
              strokeWidth="6"
              fill="none"
              strokeLinecap="round"
            />
            <path
              d={`M${belly.rx * 0.55} -12 C${Math.min(belly.rx + 30, 92)} -4 ${Math.min(belly.rx + 30, 92)} -40 ${Math.min(belly.rx + 16, 84)} -58`}
              stroke="#5b6478"
              strokeWidth="2.6"
              fill="none"
              strokeLinecap="round"
            />
            <g transform={`translate(${Math.min(belly.rx + 16, 84)} -62) rotate(-30)`}>
              <rect x="-7" y="-9" width="14" height="13" rx="4" fill={NAVY} stroke={OUTLINE} strokeWidth="2" />
              <circle cx="0" cy="-2.5" r="3" fill="#7fd3ff" />
            </g>
          </g>

          {ear(-1)}
          {ear(1)}

          {/* Körper: Rumpf, Beine, Kopf, Arme */}
          <Blob shapes={torso} fill={`url(#${uid}-body)`} />

          {/* Bauch */}
          <ellipse cx="0" cy={patch.cy} rx={patch.rx} ry={patch.ry} fill={CREAM} />
          {abs > 0 && (
            <g fill="none" stroke="#dca744" strokeWidth="2" strokeLinecap="round" opacity={abs}>
              <path d={`M0 ${patch.cy - patch.ry * 0.7} V${patch.cy + patch.ry * 0.62}`} />
              {[-0.38, 0.02, 0.4].map((f) => (
                <g key={f}>
                  <path d={`M-3 ${patch.cy + patch.ry * f} q-6 2.5 -12 0`} />
                  <path d={`M3 ${patch.cy + patch.ry * f} q6 2.5 12 0`} />
                </g>
              ))}
            </g>
          )}
          {pecs > 0 && (
            <g stroke="#d99a1c" strokeWidth="2.4" fill="none" strokeLinecap="round" opacity={pecs}>
              <path d={`M-2 ${chest.cy - 6} q-14 16 -36 6`} />
              <path d={`M2 ${chest.cy - 6} q14 16 36 6`} />
            </g>
          )}

          {/* EMS-Gurt */}
          {belt && (
            <g clipPath={`url(#${uid}-torso)`}>
              <g>
                <rect x="-120" y={beltY} width="240" height="11" fill={gold ? GOLD : NAVY} stroke={OUTLINE} strokeWidth="2" />
                {gold ? (
                  <g>
                    <rect x="-13" y={beltY - 4} width="26" height="19" rx="5" fill={GOLD} stroke={GOLD_DARK} strokeWidth="2" />
                    {bolt(0, beltY + 5.5, 1.3, "#fff6c9", GOLD_DARK, 1.2)}
                  </g>
                ) : (
                  <g fill="#7fd3ff" stroke={OUTLINE} strokeWidth="1.2">
                    <circle cx="-10" cy={beltY + 5.5} r="3.2" />
                    <circle cx="10" cy={beltY + 5.5} r="3.2" />
                  </g>
                )}
              </g>
            </g>
          )}

          <Blob shapes={legs} fill={`url(#${uid}-body)`} />
          {soles > 0 && (
            <g opacity={soles}>
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

          {/* Pferdeschwanz (weiblich): kommt hinten aus der Kappe */}
          {kind === "w" && (
            <g>
              <path
                d={`M${head.rx * 0.35} ${head.cy - head.ry * 0.62} C${head.rx + 26} ${head.cy - head.ry * 0.9} ${head.rx + 30} ${head.cy + head.ry * 0.3} ${head.rx + 16} ${head.cy + head.ry * 1.15} C${head.rx + 12} ${head.cy + head.ry * 0.7} ${head.rx * 0.95} ${head.cy + head.ry * 0.1} ${head.rx * 0.55} ${head.cy}  Z`}
                fill={`url(#${uid}-body)`}
                stroke={OUTLINE}
                strokeWidth={OW}
                strokeLinejoin="round"
              />
              <path d={`M${head.rx + 14} ${head.cy - head.ry * 0.2} q6 10 2 22`} stroke="#e0a21a" strokeWidth="2" fill="none" strokeLinecap="round" />
              <ellipse cx={head.rx * 0.98} cy={head.cy - head.ry * 0.5} rx="5" ry="6.5" fill="#ff5fa2" stroke={OUTLINE} strokeWidth="2" transform={`rotate(-30 ${head.rx * 0.98} ${head.cy - head.ry * 0.5})`} />
            </g>
          )}

          {/* Kopf */}
          <Blob shapes={[{ e: [0, head.cy, head.rx, head.ry] }]} fill={`url(#${uid}-body)`} />

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
            {kind === "w" && mood !== "sleepy" && mood !== "party" && (
              <g stroke={OUTLINE} strokeWidth="2" strokeLinecap="round">
                {[-1, 1].map((s) => (
                  <g key={s}>
                    <path d={`M${s * (eye.x + eye.rx * 0.55)} ${eye.y - eye.ry * 0.7} l${s * 4} -3`} />
                    <path d={`M${s * (eye.x + eye.rx * 0.95)} ${eye.y - eye.ry * 0.2} l${s * 4.5} -1`} />
                  </g>
                ))}
              </g>
            )}
            {mood === "sad" && (
              <g stroke={OUTLINE} strokeWidth="2.2" strokeLinecap="round">
                {[-1, 1].map((s) => (
                  <path key={s} d={`M${s * (eye.x + 7)} ${eye.y - 12} L${s * (eye.x - 5)} ${eye.y - 15}`} />
                ))}
              </g>
            )}
            {/* Bäckchen als kleine Blitze */}
            {bolt(-head.rx * 0.68, head.cy + 12, 1.25, ORANGE, "#d9601f", 1)}
            {bolt(head.rx * 0.68, head.cy + 12, 1.25, ORANGE, "#d9601f", 1)}
            <path d={`M-2.6 ${head.cy + 9} h5.2 l-2.6 3 z`} fill={OUTLINE} stroke={OUTLINE} strokeWidth="1.2" strokeLinejoin="round" />
            {mouth}
            {mood === "sad" && <path className="blitzi-tear" d={`M${-eye.x - 3} ${eye.y + 9} q-3 6 0 8 q3 -2 0 -8z`} fill="#7fc8ff" />}
          </g>

          {/* Arme */}
          {arms.map((p, i) => (
            <g key={i}>
              <Blob shapes={armShapes(p)} fill={`url(#${uid}-body)`} />
              {sweat && (
                <line
                  x1={p.hx + (p.ex - p.hx) * 0.28}
                  y1={p.hy + (p.ey - p.hy) * 0.28}
                  x2={p.hx + (p.ex - p.hx) * 0.46}
                  y2={p.hy + (p.ey - p.hy) * 0.46}
                  stroke={bandColor}
                  strokeWidth={arm.w + 1}
                />
              )}
              {veins && (
                <path
                  d={`M${p.bx - 6} ${p.by + 2} q3 -5 6 -2 q3 3 6 -3`}
                  stroke="#e08a1e"
                  strokeWidth="1.6"
                  fill="none"
                  strokeLinecap="round"
                  opacity="0.8"
                />
              )}
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
              <path d="M-84 -150 l3 8 8 3 -8 3 -3 8 -3 -8 -8 -3 8 -3z" />
              <path d="M80 -176 l2 6 6 2 -6 2 -2 6 -2 -6 -6 -2 6 -2z" />
              <path d="M86 -96 l2.5 7 7 2.5 -7 2.5 -2.5 7 -2.5 -7 -7 -2.5 7 -2.5z" />
              {mood === "party" && <path d="M-88 -70 l2 5 5 2 -5 2 -2 5 -2 -5 -5 -2 5 -2z" />}
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
        </g>
      </svg>
    </Tag>
  );
}
