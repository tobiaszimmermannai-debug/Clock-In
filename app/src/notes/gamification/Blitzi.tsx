// Blitzi – das Maskottchen: ein kleiner Blitz mit EMS-Gurt. Lädt sich mit erledigten Aufgaben auf.
// Eigene Figur (SVG), Stimmungen: party, proud, happy, neutral, sleepy, sad.
import "./blitzi.css";
import { useState } from "react";
import type { Mood } from "./stats";

// Blitz-Umriss (abgerundet über breite Kontur)
const BOLT = "M66 8 L26 78 H56 L45 142 L99 62 H69 L84 8 Z";

export function Blitzi(props: { mood: Mood; size?: number; onTap?: () => void; title?: string }) {
  const [jump, setJump] = useState(0);
  const { mood } = props;
  const size = props.size ?? 112;
  const low = mood === "sad";
  const fill = low ? "url(#bz-low)" : "url(#bz-body)";
  const eyesClosed = mood === "sleepy";
  const tap = () => {
    setJump((j) => j + 1);
    props.onTap?.();
  };

  return (
    <button
      type="button"
      className={`blitzi is-${mood}`}
      onClick={tap}
      aria-label={props.title ?? "Blitzi"}
      title={props.title ?? "Blitzi antippen"}
      style={{ width: size, height: size * 1.2 }}
    >
      <svg key={jump} className={jump ? "blitzi-svg is-jump" : "blitzi-svg"} viewBox="0 0 125 150" aria-hidden>
        <defs>
          <linearGradient id="bz-body" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#ffe36e" />
            <stop offset="0.55" stopColor="#ffc928" />
            <stop offset="1" stopColor="#ff9f1c" />
          </linearGradient>
          <linearGradient id="bz-low" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#e9e2bf" />
            <stop offset="1" stopColor="#c9bd8d" />
          </linearGradient>
          <clipPath id="bz-clip">
            <path d={BOLT} />
          </clipPath>
        </defs>

        {/* Funken bei guter Laune */}
        {(mood === "party" || mood === "proud") && (
          <g className="blitzi-sparks" fill="#ffcf33">
            <path d="M14 30 l3 8 8 3 -8 3 -3 8 -3 -8 -8 -3 8 -3z" />
            <path d="M108 22 l2 6 6 2 -6 2 -2 6 -2 -6 -6 -2 6 -2z" />
            <path d="M112 104 l2.5 7 7 2.5 -7 2.5 -2.5 7 -2.5 -7 -7 -2.5 7 -2.5z" />
            {mood === "party" && <path d="M10 110 l2 5 5 2 -5 2 -2 5 -2 -5 -5 -2 5 -2z" />}
          </g>
        )}

        {/* Arme */}
        <g className="blitzi-arms" stroke="#e68a00" strokeWidth="5" strokeLinecap="round" fill="none">
          {mood === "party" || mood === "proud" ? (
            <>
              <path d="M32 70 L16 50" />
              <path d="M96 64 L112 44" />
            </>
          ) : mood === "sad" || mood === "sleepy" ? (
            <>
              <path d="M32 72 L20 90" />
              <path d="M95 66 L106 86" />
            </>
          ) : (
            <>
              <path d="M32 72 L16 76" />
              <path d="M96 66 L112 60" />
            </>
          )}
        </g>

        {/* Körper */}
        <path d={BOLT} fill={fill} stroke={low ? "#a89a62" : "#e68a00"} strokeWidth="7" strokeLinejoin="round" />
        {/* Glanz */}
        {!low && <path d="M68 16 L44 58" stroke="#fff6c4" strokeWidth="5" strokeLinecap="round" opacity="0.8" />}

        {/* EMS-Gurt mit zwei Elektroden */}
        <g clipPath="url(#bz-clip)">
          <rect x="20" y="93" width="90" height="13" fill="#24336b" transform="rotate(-8 64 99)" />
          <circle cx="56" cy="100" r="3.6" fill="#7fd3ff" />
          <circle cx="68" cy="98.5" r="3.6" fill="#7fd3ff" />
        </g>

        {/* Gesicht */}
        <g className="blitzi-face">
          {eyesClosed ? (
            <g stroke="#3b2a12" strokeWidth="3" strokeLinecap="round" fill="none">
              <path d="M44 69 q6 4 12 0" />
              <path d="M66 69 q6 4 12 0" />
            </g>
          ) : (
            <g className="blitzi-eyes">
              <ellipse cx="50" cy="68" rx="7.5" ry={mood === "sad" ? 6.5 : 8.5} fill="#fff" />
              <ellipse cx="72" cy="68" rx="7.5" ry={mood === "sad" ? 6.5 : 8.5} fill="#fff" />
              <circle cx={mood === "sad" ? 50 : 51} cy={mood === "sad" ? 70 : 69} r="4" fill="#2b1d0b" />
              <circle cx={mood === "sad" ? 72 : 73} cy={mood === "sad" ? 70 : 69} r="4" fill="#2b1d0b" />
              <circle cx="52.5" cy="67" r="1.4" fill="#fff" />
              <circle cx="74.5" cy="67" r="1.4" fill="#fff" />
            </g>
          )}
          {/* Augenbrauen */}
          {mood === "sad" && (
            <g stroke="#6b5520" strokeWidth="2.5" strokeLinecap="round">
              <path d="M43 58 L55 61" />
              <path d="M79 58 L67 61" />
            </g>
          )}
          {/* Wangen */}
          {(mood === "happy" || mood === "proud" || mood === "party") && (
            <g fill="#ff8a5c" opacity="0.55">
              <ellipse cx="42" cy="79" rx="4.5" ry="3" />
              <ellipse cx="82" cy="76" rx="4.5" ry="3" />
            </g>
          )}
          {/* Mund */}
          {mood === "party" || mood === "proud" ? (
            <path d="M54 79 q8 10 16 0 z" fill="#5a2a0c" />
          ) : mood === "happy" ? (
            <path d="M55 80 q7 6 14 0" stroke="#5a2a0c" strokeWidth="3" fill="none" strokeLinecap="round" />
          ) : mood === "sad" ? (
            <path d="M56 84 q6 -5 12 0" stroke="#5a4312" strokeWidth="3" fill="none" strokeLinecap="round" />
          ) : mood === "sleepy" ? (
            <ellipse cx="62" cy="82" rx="3" ry="2.5" fill="#5a2a0c" />
          ) : (
            <path d="M56 81 h12" stroke="#5a2a0c" strokeWidth="3" strokeLinecap="round" />
          )}
          {mood === "sad" && <path className="blitzi-tear" d="M45 77 q-3 6 0 8 q3 -2 0 -8z" fill="#7fc8ff" />}
        </g>

        {mood === "sleepy" && (
          <g className="blitzi-zzz" fill="#8a7fb8" fontFamily="system-ui, sans-serif" fontWeight="700">
            <text x="92" y="40" fontSize="13">z</text>
            <text x="102" y="28" fontSize="10">z</text>
            <text x="110" y="18" fontSize="8">z</text>
          </g>
        )}
      </svg>
    </button>
  );
}
