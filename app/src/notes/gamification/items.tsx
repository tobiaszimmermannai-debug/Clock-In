// Blitzis Items: 100 Stück, je Prestige (Stufe 30 erreicht) wählt man eines – es bleibt für immer.
// Jedes Item sitzt an einem Ankerpunkt, den Blitzi je Stufe neu berechnet (Kopf, Augen, Hand, Brust, Füße …):
// so wachsen die Items vom kugelrunden Sofa-Blitzi bis zum Legenden-Blitzi mit und sitzen immer richtig.
import type { ReactNode } from "react";

export type ItemCat = "pet" | "glasses" | "hat" | "tattoo" | "prop" | "outfit" | "shoes" | "effect" | "face";

export const ITEM_CATS: { id: ItemCat; label: string }[] = [
  { id: "pet", label: "Haustiere" },
  { id: "glasses", label: "Brillen" },
  { id: "hat", label: "Kopfbedeckung" },
  { id: "tattoo", label: "Tattoos" },
  { id: "prop", label: "Props" },
  { id: "outfit", label: "Kleidung & Accessoires" },
  { id: "shoes", label: "Schuhe" },
  { id: "effect", label: "Effekte" },
  { id: "face", label: "Gesicht & Extras" },
];

/** Wo das Item sitzt */
type Spot = "side" | "head" | "eyes" | "hand" | "arm" | "chest" | "neck" | "wrist" | "feet" | "around" | "above" | "mouth" | "cheek" | "back";
type Draw =
  | { glyph: string; spot: Spot; size?: number }
  | { torso: string; opacity?: number; stripe?: string }
  | { custom: "cape" | "wings" | "aura" | "halo" | "belt" | "chain" | "mustache" | "beard" | "bands" | "socks" | "rainbow" | "shield"; color: string };

export type Item = { id: string; name: string; cat: ItemCat } & { draw: Draw };

const g = (glyph: string, spot: Spot, size = 1): Draw => ({ glyph, spot, size });

export const ITEMS: Item[] = [
  // Haustiere (1–15) – sitzen neben Blitzi
  { id: "pet-dog", name: "Hund", cat: "pet", draw: g("🐕", "side", 1.1) },
  { id: "pet-cat", name: "Katze", cat: "pet", draw: g("🐈", "side", 1.05) },
  { id: "pet-fish", name: "Fisch im Glas", cat: "pet", draw: g("🐠", "side", 0.9) },
  { id: "pet-hamster", name: "Hamster", cat: "pet", draw: g("🐹", "side", 0.8) },
  { id: "pet-rabbit", name: "Kaninchen", cat: "pet", draw: g("🐇", "side", 1) },
  { id: "pet-parrot", name: "Papagei", cat: "pet", draw: g("🦜", "side", 1) },
  { id: "pet-turtle", name: "Schildkröte", cat: "pet", draw: g("🐢", "side", 0.95) },
  { id: "pet-frog", name: "Frosch", cat: "pet", draw: g("🐸", "side", 0.85) },
  { id: "pet-snake", name: "Schlange", cat: "pet", draw: g("🐍", "side", 1) },
  { id: "pet-gecko", name: "Gecko", cat: "pet", draw: g("🦎", "side", 0.95) },
  { id: "pet-budgie", name: "Wellensittich", cat: "pet", draw: g("🐦", "side", 0.8) },
  { id: "pet-axolotl", name: "Axolotl", cat: "pet", draw: g("🦎", "side", 0.8) },
  { id: "pet-dragon", name: "Mini-Drache", cat: "pet", draw: g("🐉", "side", 1.15) },
  { id: "pet-chick", name: "Küken", cat: "pet", draw: g("🐤", "side", 0.75) },
  { id: "pet-hedgehog", name: "Igel", cat: "pet", draw: g("🦔", "side", 0.85) },
  // Brillen (16–25)
  { id: "glasses-sun", name: "Klassische Sonnenbrille", cat: "glasses", draw: g("🕶️", "eyes") },
  { id: "glasses-sport", name: "Sportbrille", cat: "glasses", draw: g("🥽", "eyes", 0.95) },
  { id: "glasses-heart", name: "Herzbrille", cat: "glasses", draw: g("💕", "eyes", 0.9) },
  { id: "glasses-pixel", name: "Pixelbrille", cat: "glasses", draw: g("⬛⬛", "eyes", 0.55) },
  { id: "glasses-rimless", name: "Randlose Brille", cat: "glasses", draw: g("👓", "eyes", 0.95) },
  { id: "glasses-swim", name: "Schwimmbrille", cat: "glasses", draw: g("🥽", "eyes", 0.9) },
  { id: "glasses-aviator", name: "Aviator", cat: "glasses", draw: g("🕶️", "eyes", 1.05) },
  { id: "glasses-night", name: "Nachtsichtbrille", cat: "glasses", draw: g("🔭", "eyes", 0.8) },
  { id: "glasses-monocle", name: "Monokel", cat: "glasses", draw: g("🧐", "eyes", 0.6) },
  { id: "glasses-3d", name: "3D-Brille", cat: "glasses", draw: g("🟥🟦", "eyes", 0.5) },
  // Kopfbedeckung (26–40)
  { id: "hat-cap", name: "Cap vorwärts", cat: "hat", draw: g("🧢", "head") },
  { id: "hat-cap-back", name: "Cap rückwärts", cat: "hat", draw: g("🧢", "head", -1) },
  { id: "hat-beanie", name: "Beanie", cat: "hat", draw: g("👲", "head", 0.9) },
  { id: "hat-headband", name: "Stirnband", cat: "hat", draw: { custom: "bands", color: "#e5484d" } },
  { id: "hat-sweatband", name: "Schweißband", cat: "hat", draw: { custom: "bands", color: "#2f80ed" } },
  { id: "hat-crown", name: "Krone", cat: "hat", draw: g("👑", "head") },
  { id: "hat-cowboy", name: "Cowboyhut", cat: "hat", draw: g("🤠", "head", 0.9) },
  { id: "hat-chef", name: "Kochmütze", cat: "hat", draw: g("👨‍🍳", "head", 0.9) },
  { id: "hat-santa", name: "Weihnachtsmütze", cat: "hat", draw: g("🎅", "head", 0.9) },
  { id: "hat-mask", name: "Superheldenmaske", cat: "hat", draw: g("🦸", "eyes", 0.7) },
  { id: "hat-lamp", name: "Stirnlampe", cat: "hat", draw: g("🔦", "head", 0.7) },
  { id: "hat-bolt", name: "Blitz-Haarreif", cat: "hat", draw: g("⚡⚡", "head", 0.65) },
  { id: "hat-bucket", name: "Bucket Hat", cat: "hat", draw: g("👒", "head") },
  { id: "hat-beret", name: "Barett", cat: "hat", draw: g("🎨", "head", 0.75) },
  { id: "hat-helmet", name: "Fahrradhelm", cat: "hat", draw: g("⛑️", "head") },
  // Tattoos (41–50) – auf Arm bzw. Brust
  { id: "tattoo-bolt", name: "Blitz am Arm", cat: "tattoo", draw: g("⚡", "arm", 0.55) },
  { id: "tattoo-heart", name: "Herz", cat: "tattoo", draw: g("❤️", "arm", 0.5) },
  { id: "tattoo-star", name: "Stern", cat: "tattoo", draw: g("⭐", "arm", 0.5) },
  { id: "tattoo-dragon", name: "Kleiner Drache", cat: "tattoo", draw: g("🐲", "arm", 0.55) },
  { id: "tattoo-wave", name: "Welle", cat: "tattoo", draw: g("🌊", "arm", 0.5) },
  { id: "tattoo-ems", name: "EMS-Blitz auf der Brust", cat: "tattoo", draw: g("⚡", "chest", 0.8) },
  { id: "tattoo-banner", name: "Banner", cat: "tattoo", draw: g("🎗️", "chest", 0.6) },
  { id: "tattoo-tribal", name: "Tribal-Armband", cat: "tattoo", draw: g("〰️", "arm", 0.6) },
  { id: "tattoo-kiss", name: "Kussmund", cat: "tattoo", draw: g("💋", "cheek", 0.45) },
  { id: "tattoo-dumbbell", name: "Hantel-Tattoo", cat: "tattoo", draw: g("🏋️", "arm", 0.5) },
  // Props (51–62) – in der Hand
  { id: "prop-dumbbell", name: "Kurzhantel", cat: "prop", draw: g("🏋️", "hand", 0.75) },
  { id: "prop-kettlebell", name: "Kettlebell", cat: "prop", draw: g("🪨", "hand", 0.7) },
  { id: "prop-rope", name: "Springseil", cat: "prop", draw: g("🪢", "hand", 0.8) },
  { id: "prop-bottle", name: "Trinkflasche", cat: "prop", draw: g("🧴", "hand", 0.7) },
  { id: "prop-shake", name: "Proteinshake", cat: "prop", draw: g("🥤", "hand", 0.75) },
  { id: "prop-towel", name: "Handtuch", cat: "prop", draw: g("🧻", "hand", 0.7) },
  { id: "prop-clipboard", name: "Klemmbrett", cat: "prop", draw: g("📋", "hand", 0.75) },
  { id: "prop-phone", name: "Handy", cat: "prop", draw: g("📱", "hand", 0.65) },
  { id: "prop-coffee", name: "Kaffeebecher", cat: "prop", draw: g("☕", "hand", 0.7) },
  { id: "prop-trophy", name: "Siegerpokal", cat: "prop", draw: g("🏆", "hand", 0.85) },
  { id: "prop-gymbag", name: "Gymbag", cat: "prop", draw: g("👜", "hand", 0.8) },
  { id: "prop-bands", name: "Widerstandsbänder", cat: "prop", draw: g("➰", "hand", 0.7) },
  // Kleidung & Accessoires (63–80)
  { id: "outfit-hoodie", name: "Hoodie", cat: "outfit", draw: { torso: "#7d8597", opacity: 0.85 } },
  { id: "outfit-tank", name: "Tanktop", cat: "outfit", draw: { torso: "#ffffff", opacity: 0.7 } },
  { id: "outfit-cape", name: "Cape", cat: "outfit", draw: { custom: "cape", color: "#2f80ed" } },
  { id: "outfit-bow", name: "Fliege", cat: "outfit", draw: g("🎀", "neck", 0.55) },
  { id: "outfit-ems-vest", name: "EMS-Weste", cat: "outfit", draw: { torso: "#24336b", opacity: 0.85, stripe: "#ffd84a" } },
  { id: "outfit-tracksuit", name: "Trainingsanzug", cat: "outfit", draw: { torso: "#1f6feb", opacity: 0.8, stripe: "#ffffff" } },
  { id: "outfit-hero-cape", name: "Superheldenumhang", cat: "outfit", draw: { custom: "cape", color: "#e5484d" } },
  { id: "outfit-disco", name: "Discojacke", cat: "outfit", draw: { torso: "#a855f7", opacity: 0.8, stripe: "#f5d0fe" } },
  { id: "outfit-studio", name: "Studio-Shirt", cat: "outfit", draw: { torso: "#1d1d22", opacity: 0.85, stripe: "#ffd84a" } },
  { id: "outfit-chain", name: "Goldkette", cat: "outfit", draw: { custom: "chain", color: "#f6c544" } },
  { id: "outfit-headphones", name: "Kopfhörer", cat: "outfit", draw: g("🎧", "head", 1.05) },
  { id: "outfit-watch", name: "Smartwatch", cat: "outfit", draw: g("⌚", "wrist", 0.45) },
  { id: "outfit-wristbands", name: "Schweißbänder an den Handgelenken", cat: "outfit", draw: g("🟥", "wrist", 0.35) },
  { id: "outfit-goldbelt", name: "Goldgürtel", cat: "outfit", draw: { custom: "belt", color: "#f6c544" } },
  { id: "outfit-scarf", name: "Schal", cat: "outfit", draw: g("🧣", "neck", 0.8) },
  { id: "outfit-raincoat", name: "Regenmantel", cat: "outfit", draw: { torso: "#facc15", opacity: 0.75, stripe: "#a16207" } },
  { id: "outfit-hawaii", name: "Hawaii-Hemd", cat: "outfit", draw: { torso: "#f97316", opacity: 0.75, stripe: "#22c55e" } },
  { id: "outfit-suit", name: "Anzug", cat: "outfit", draw: { torso: "#111827", opacity: 0.85, stripe: "#e5e7eb" } },
  // Schuhe (81–85)
  { id: "shoes-sneaker", name: "Sneaker", cat: "shoes", draw: g("👟", "feet", 0.7) },
  { id: "shoes-boots", name: "Stiefel", cat: "shoes", draw: g("🥾", "feet", 0.7) },
  { id: "shoes-bolt-socks", name: "Blitz-Socken", cat: "shoes", draw: { custom: "socks", color: "#ffd84a" } },
  { id: "shoes-gold", name: "Goldene Schuhe", cat: "shoes", draw: { custom: "socks", color: "#f6c544" } },
  { id: "shoes-anklets", name: "Fußbänder", cat: "shoes", draw: { custom: "socks", color: "#e5484d" } },
  // Effekte (86–93)
  { id: "fx-sparks", name: "Funken-Aura", cat: "effect", draw: { custom: "aura", color: "#ffcf33" } },
  { id: "fx-rainbow", name: "Regenbogen-Glitzer", cat: "effect", draw: { custom: "rainbow", color: "#ffffff" } },
  { id: "fx-sweat", name: "Schweißtropfen", cat: "effect", draw: g("💦", "above", 0.6) },
  { id: "fx-stars", name: "Sternchen", cat: "effect", draw: g("✨", "around", 0.55) },
  { id: "fx-disco", name: "Disco-Licht", cat: "effect", draw: { custom: "aura", color: "#a855f7" } },
  { id: "fx-rain", name: "Kleiner Regen", cat: "effect", draw: g("🌧️", "above", 0.9) },
  { id: "fx-hearts", name: "Herzen", cat: "effect", draw: g("💖", "around", 0.5) },
  { id: "fx-shield", name: "Blitzschild", cat: "effect", draw: { custom: "shield", color: "#7fd3ff" } },
  // Gesicht & Extras (94–100)
  { id: "face-mustache", name: "Schnurrbart", cat: "face", draw: { custom: "mustache", color: "#3a2914" } },
  { id: "face-beard", name: "Vollbart", cat: "face", draw: { custom: "beard", color: "#5b3a1a" } },
  { id: "face-plaster", name: "Pflaster", cat: "face", draw: g("🩹", "cheek", 0.45) },
  { id: "face-blush", name: "Rouge", cat: "face", draw: g("🌸", "cheek", 0.4) },
  { id: "face-wreath", name: "Siegerkranz", cat: "face", draw: g("🌿", "head", 0.9) },
  { id: "face-wings", name: "Flügel", cat: "face", draw: { custom: "wings", color: "#ffffff" } },
  { id: "face-halo", name: "Heiligenschein", cat: "face", draw: { custom: "halo", color: "#ffd84a" } },
];

export const ITEM_BY_ID = new Map(ITEMS.map((i) => [i.id, i]));

/** Ankerpunkte, die Blitzi je Stufe liefert (Koordinaten im Blitzi-SVG, Boden bei y = 0) */
export type Anchors = {
  head: { cy: number; rx: number; ry: number };
  eye: { x: number; y: number };
  mouthY: number;
  neckY: number;
  chest: { cy: number; rx: number };
  beltY: number;
  bellyRx: number;
  hands: { x: number; y: number }[];
  arms: { x: number; y: number; w: number }[];
  feet: { x: number; y: number; rx: number }[];
  torsoClip: string;
};

const emoji = (key: string, x: number, y: number, size: number, flip = false): ReactNode => (
  <text key={key} x={x} y={y} fontSize={size} textAnchor="middle" dominantBaseline="central"
    transform={flip ? `translate(${2 * x} 0) scale(-1 1)` : undefined} style={{ userSelect: "none" }}>
    {key.split("|")[0]}
  </text>
);

/** Ebenen: hinter dem Körper, auf dem Körper (Kleidung), vor allem (Kopf, Hand, Haustiere …) */
export function itemLayer(ids: string[] | undefined, a: Anchors, layer: "back" | "body" | "front"): ReactNode[] {
  const out: ReactNode[] = [];
  const unit = a.head.rx; // Maßstab: Kopfbreite – wächst mit der Stufe mit
  (ids ?? []).forEach((id, n) => {
    const item = ITEM_BY_ID.get(id);
    if (!item) return;
    const d = item.draw;
    const k = `${id}-${n}`;
    if ("torso" in d) {
      if (layer !== "body") return;
      out.push(
        <g key={k} clipPath={`url(#${a.torsoClip})`} opacity={d.opacity ?? 0.8}>
          <rect x={-160} y={a.neckY} width={320} height={a.beltY - a.neckY + 6} fill={d.torso} />
          {d.stripe && <rect x={-3} y={a.neckY} width={6} height={a.beltY - a.neckY} fill={d.stripe} />}
        </g>,
      );
      return;
    }
    if ("custom" in d) {
      const c = d.color;
      switch (d.custom) {
        case "cape":
          if (layer === "back")
            out.push(<path key={k} d={`M${-a.chest.rx * 0.9} ${a.neckY} Q0 ${a.neckY - 8} ${a.chest.rx * 0.9} ${a.neckY} L${a.chest.rx * 1.5} -4 Q0 8 ${-a.chest.rx * 1.5} -4 Z`} fill={c} stroke="#3a2914" strokeWidth="2.5" />);
          return;
        case "wings":
          if (layer === "back")
            for (const s of [-1, 1])
              out.push(<path key={`${k}${s}`} d={`M${s * a.chest.rx * 0.6} ${a.chest.cy} q${s * 70} -60 ${s * 105} -30 q${s * -25} 15 ${s * -30} 25 q${s * 20} 5 ${s * 18} 20 q${s * -40} -5 ${s * -93} -15z`} fill={c} stroke="#9aa4b2" strokeWidth="2" />);
          return;
        case "aura":
          if (layer === "back") out.push(<ellipse key={k} cx={0} cy={(a.head.cy - a.head.ry) / 2} rx={125} ry={(a.head.ry - a.head.cy) / 2 + 30} fill={c} opacity={0.22} />);
          return;
        case "rainbow":
          if (layer === "back")
            ["#ef4444", "#f59e0b", "#22c55e", "#3b82f6", "#a855f7"].forEach((col, i) =>
              out.push(<path key={`${k}${i}`} d={`M-120 0 A120 ${-a.head.cy + 40} 0 0 1 120 0`} transform={`scale(${1 - i * 0.07})`} stroke={col} strokeWidth="5" fill="none" opacity="0.55" />),
            );
          return;
        case "halo":
          if (layer === "front") out.push(<ellipse key={k} cx={0} cy={a.head.cy - a.head.ry - 14} rx={unit * 0.75} ry={unit * 0.16} fill="none" stroke={c} strokeWidth="5" />);
          return;
        case "shield":
          if (layer === "front") out.push(<ellipse key={k} cx={0} cy={(a.head.cy - a.head.ry) / 2} rx={118} ry={(a.head.ry - a.head.cy) / 2 + 24} fill={c} opacity={0.14} stroke={c} strokeWidth="3" />);
          return;
        case "belt":
          if (layer === "body") out.push(<rect key={k} x={-a.bellyRx - 4} y={a.beltY - 1} width={(a.bellyRx + 4) * 2} height={13} rx={3} fill={c} stroke="#b9861a" strokeWidth="2" />);
          return;
        case "chain":
          if (layer === "front") out.push(<path key={k} d={`M${-unit * 0.6} ${a.neckY} Q0 ${a.neckY + unit * 0.7} ${unit * 0.6} ${a.neckY}`} fill="none" stroke={c} strokeWidth="4" strokeDasharray="3 2" />);
          return;
        case "bands":
          if (layer === "front") out.push(<rect key={k} x={-a.head.rx} y={a.head.cy - a.head.ry * 0.42} width={a.head.rx * 2} height={a.head.ry * 0.22} rx={4} fill={c} stroke="#3a2914" strokeWidth="1.5" />);
          return;
        case "socks":
          if (layer === "front") for (const f of a.feet) out.push(<ellipse key={`${k}${f.x}`} cx={f.x} cy={f.y} rx={f.rx * 1.02} ry={f.rx * 0.5} fill={c} stroke="#3a2914" strokeWidth="2" opacity="0.92" />);
          return;
        case "mustache":
          if (layer === "front") out.push(<path key={k} d={`M0 ${a.mouthY - 6} q-10 -6 -18 2 q8 -2 18 3 q10 -5 18 -3 q-8 -8 -18 -2z`} fill={c} />);
          return;
        case "beard":
          if (layer === "front") out.push(<path key={k} d={`M${-a.head.rx * 0.8} ${a.head.cy + 4} Q0 ${a.head.cy + a.head.ry * 1.5} ${a.head.rx * 0.8} ${a.head.cy + 4} Q0 ${a.mouthY + 2} ${-a.head.rx * 0.8} ${a.head.cy + 4}`} fill={c} opacity="0.9" />);
          return;
      }
      return;
    }
    if (layer !== (d.spot === "back" ? "back" : "front")) return;
    const size = unit * 1.2 * Math.abs(d.size ?? 1);
    const flip = (d.size ?? 1) < 0;
    const glyph = (x: number, y: number, s = size, f = flip, extra = "") => out.push(emoji(`${d.glyph}|${k}${extra}`, x, y, s, f));
    switch (d.spot) {
      case "side":
        // Haustiere neben Blitzi am Boden – größer bei kleinen Stufen nicht nötig: feste Größe
        glyph(-a.bellyRx - 30, -18, 44 * (d.size ?? 1));
        break;
      case "head":
        glyph(0, a.head.cy - a.head.ry * 0.95, size);
        break;
      case "eyes":
        glyph(0, a.eye.y, unit * 1.25 * (d.size ?? 1));
        break;
      case "hand":
        glyph(a.hands[1]?.x ?? 40, (a.hands[1]?.y ?? -60) - 4, size * 0.8);
        break;
      case "wrist":
        for (const [i, h] of a.hands.entries()) glyph(h.x, h.y + 2, size, false, `w${i}`);
        break;
      case "arm":
        glyph(a.arms[0]?.x ?? -40, a.arms[0]?.y ?? -70, Math.max(12, (a.arms[0]?.w ?? 14) * 1.1 * (d.size ?? 1) * 1.6));
        break;
      case "chest":
        glyph(0, a.chest.cy, size);
        break;
      case "neck":
        glyph(0, a.neckY + 4, size);
        break;
      case "cheek":
        glyph(a.eye.x + 6, a.eye.y + 12, size);
        break;
      case "mouth":
        glyph(0, a.mouthY, size);
        break;
      case "feet":
        for (const [i, f] of a.feet.entries()) glyph(f.x, f.y - 4, Math.max(14, f.rx * 1.6), f.x < 0, `f${i}`);
        break;
      case "above":
        glyph(a.head.rx * 0.9, a.head.cy - a.head.ry - 18, size);
        break;
      case "around":
        glyph(-a.bellyRx - 14, a.head.cy, size, false, "a");
        glyph(a.bellyRx + 14, a.chest.cy, size, false, "b");
        glyph(a.head.rx + 18, a.head.cy - a.head.ry, size * 0.8, false, "c");
        break;
    }
  });
  return out;
}

/** Spitzname vor dem Namen: „Stromi (Mia Lang)“ */
export const blitziName = (personName: string, nickname: string | null | undefined) =>
  nickname ? `${nickname} (${personName})` : personName;
