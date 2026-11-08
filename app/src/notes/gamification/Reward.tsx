// Belohnung beim Abhaken und beim Stufenaufstieg: kurze Overlay-Animation (ca. 2,5 Sek., Tippen schließt sofort)
// mit dem Blitzi DER Person, die gerade abhakt – Stufe, Items, Spitzname. Zufällig aus 23 Animationen;
// beim echten Stufenaufstieg bevorzugt die Level-up-Lichtsäule.
import "./reward.css";
import { useEffect, useMemo } from "react";
import { Blitzi } from "./Blitzi";
import type { Mood } from "./stats";

export type RewardKind =
  | "bolt" | "flex" | "discoball" | "disco" | "confetti" | "fireworks" | "backflip" | "landing" | "highfive" | "breakdance"
  | "micdrop" | "trophy" | "coinrain" | "dumbbellsurf" | "rainbow" | "boxbell" | "rocket" | "polaroid" | "balloons" | "lightpillar"
  | "smoothie" | "pixel" | "drumroll";

/** Animation: Titel, Deko (Emojis, die die CSS-Klasse bewegt) */
export const REWARDS: Record<RewardKind, { title: string; fx: string[] }> = {
  bolt: { title: "Volltreffer – Blitz eingeschlagen!", fx: ["⚡", "⚡", "✨"] },
  flex: { title: "Muskeln zeigen!", fx: ["💪", "💪"] },
  discoball: { title: "Disco-Time!", fx: ["🪩"] },
  disco: { title: "Kurzer Discotanz!", fx: ["🎶", "🎵", "🎶"] },
  confetti: { title: "Konfetti-Kanone!", fx: ["🎉", "🎊", "🎉", "🎊", "🎉", "🎊"] },
  fireworks: { title: "Feuerwerk!", fx: ["🎆", "🎇", "🎆", "🎇"] },
  backflip: { title: "Backflip!", fx: ["💨"] },
  landing: { title: "Heldenlandung!", fx: ["💥", "☁️", "☁️"] },
  highfive: { title: "High-Five!", fx: ["🙌", "✋"] },
  breakdance: { title: "Breakdance!", fx: ["🌀", "🎧"] },
  micdrop: { title: "Mic-Drop.", fx: ["🎤"] },
  trophy: { title: "Pokal abgestellt!", fx: ["🏆", "✨"] },
  coinrain: { title: "Funkenregen!", fx: ["🪙", "✨", "🪙", "✨", "🪙", "✨"] },
  dumbbellsurf: { title: "Hantel-Surfen!", fx: ["🏋️", "🌊"] },
  rainbow: { title: "Regenbogen-Sprint!", fx: ["🌈"] },
  boxbell: { title: "Ding ding – Sieg!", fx: ["🔔", "🥊"] },
  rocket: { title: "Raketenstart!", fx: ["🚀", "🔥"] },
  polaroid: { title: "Klick – für die Ewigkeit!", fx: ["📸"] },
  balloons: { title: "Herzluftballons!", fx: ["🎈", "💖", "🎈", "💖"] },
  lightpillar: { title: "Level up!", fx: ["✨", "⭐", "✨"] },
  smoothie: { title: "Smoothie-Prost!", fx: ["🥤", "🥤"] },
  pixel: { title: "Pixel-Explosion!", fx: ["🟨", "🟧", "🟦", "🟩", "🟪", "🟥"] },
  drumroll: { title: "Trommelwirbel …", fx: ["🥁", "🥁"] },
};

export const REWARD_KINDS = Object.keys(REWARDS) as RewardKind[];

/** Zufällige Animation; beim Stufenaufstieg meist die Lichtsäule */
export function pickReward(levelUp: boolean, rnd = Math.random): RewardKind {
  if (levelUp && rnd() < 0.75) return "lightpillar";
  const pool = REWARD_KINDS.filter((k) => k !== "lightpillar");
  return pool[Math.floor(rnd() * pool.length) % pool.length];
}

export function RewardOverlay(props: {
  stage: number;
  items?: string[];
  name: string;
  /** Kopfzeile (z. B. „Erledigt!“ oder „Stufe 12!“), sonst Titel der Animation */
  headline?: string;
  line?: string;
  levelUp?: boolean;
  kind?: RewardKind;
  mood?: Mood;
  /** Dauer in ms (Standard 2600) */
  duration?: number;
  onClose: () => void;
}) {
  const kind = useMemo(() => props.kind ?? pickReward(Boolean(props.levelUp)), [props.kind, props.levelUp]);
  const anim = REWARDS[kind];
  const { onClose } = props;
  useEffect(() => {
    const t = setTimeout(onClose, props.duration ?? 2600);
    return () => clearTimeout(t);
  }, [onClose, props.duration]);

  return (
    <div className={`nk-rw is-${kind}`} role="status" aria-label={anim.title} onClick={onClose}>
      <div className="nk-rw-stage">
        <div className="nk-rw-back" aria-hidden />
        <div className="nk-rw-fx" aria-hidden>
          {anim.fx.map((f, i) => (
            <span key={i} style={{ ["--i" as string]: i }}>
              {f}
            </span>
          ))}
        </div>
        {kind === "highfive" && (
          <div className="nk-rw-twin" aria-hidden>
            <Blitzi mood="party" stage={props.stage} still size={120} noShadow />
          </div>
        )}
        <div className="nk-rw-hero">
          <Blitzi mood={props.mood ?? "party"} stage={props.stage} items={props.items} still size={150} />
        </div>
      </div>
      <div className="nk-rw-text">
        <b>{props.headline ?? anim.title}</b>
        <span className="nk-rw-name">{props.name}</span>
        {props.line && <span className="nk-rw-line">{props.line}</span>}
        <small>Tippen zum Schließen</small>
      </div>
    </div>
  );
}
