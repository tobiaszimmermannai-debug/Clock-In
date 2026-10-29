// Symbol-Auswahl für Seiten und Hinweis-Blöcke
import { useMemo, useState } from "react";
import { type Anchor, Popover } from "./Popover";

const GROUPS: { name: string; emojis: string }[] = [
  { name: "Häufig", emojis: "📄 📝 ✅ 📌 💡 🚀 📚 🗓️ 📅 📊 📈 🎯 ⭐ 🔥 ❤️ 👋 👥 🏠 💼 🧠 ⚙️ 🔒 📣 🎉" },
  { name: "Smileys", emojis: "😀 😃 😄 😁 😆 😊 🙂 😉 😍 🤩 😎 🤓 🧐 🤔 😴 😅 😂 🥲 😇 🥳 😬 😮 😢 😡 🤯 🥶 🤗 🙃" },
  { name: "Menschen", emojis: "👍 👎 👏 🙌 🤝 🙏 💪 ✌️ 👌 ✍️ 👀 🧑‍💻 👩‍💼 👨‍💼 🧑‍🏫 🧑‍🍳 🧑‍🔧 🏃 🧘 🏋️ 🚴 🤸 💃 🕺" },
  { name: "Natur", emojis: "🌱 🌿 🍀 🌳 🌲 🌵 🌸 🌻 🌼 🍁 🍂 🌊 🌙 ☀️ ⛅ 🌧️ ❄️ ⚡ 🌈 🐶 🐱 🦊 🐻 🐼 🦁 🐸 🐝 🦋" },
  { name: "Essen", emojis: "🍎 🍌 🍇 🍓 🍑 🥑 🥦 🥕 🌽 🍞 🧀 🥚 🍳 🥗 🍕 🍔 🌮 🍜 🍣 🍰 🍪 ☕ 🍵 🥤 🍺 🍷 💧" },
  { name: "Aktivität", emojis: "⚽ 🏀 🏈 🎾 🏐 🏓 🥊 🎳 ⛳ 🏆 🥇 🎮 🎲 🧩 🎨 🎬 🎤 🎧 🎸 🎹 📷 🎟️ 🏖️ ⛰️ 🏕️" },
  { name: "Reisen", emojis: "🚗 🚕 🚌 🚲 🛴 🚆 ✈️ 🚀 🛳️ ⛵ 🏙️ 🏛️ 🏰 🗼 🗽 🗺️ 🧭 🏢 🏬 🏥 🏫 ⛪ 🏟️" },
  { name: "Objekte", emojis: "💻 🖥️ 📱 ⌨️ 🖨️ 💾 📀 🔋 🔌 💡 🔦 🕯️ 📦 📫 ✉️ 📎 📐 ✂️ 🖊️ 🖍️ 📒 📓 📔 📕 📗 📘 📙 🗂️ 🗃️ 🗄️ 🧾 💰 💳 🧰 🔧 🔨 🧪 🧲 🔑 🗝️ 🛒 🎁" },
  { name: "Symbole", emojis: "❗ ❓ ⚠️ ⛔ 🚫 ✔️ ❌ ➕ ➖ 🔁 🔄 ⏳ ⌛ ⏰ 🔔 🔕 💬 💭 🗨️ 🏷️ 🔖 🔗 ♻️ 🟥 🟧 🟨 🟩 🟦 🟪 ⬛ ⬜ 🔴 🟠 🟡 🟢 🔵 🟣 ⚫ ⚪" },
];

const ALL = GROUPS.flatMap((g) => g.emojis.split(" "));

export const randomEmoji = () => ALL[Math.floor(Math.random() * 60)];

export function EmojiPicker(props: { anchor: Anchor; onPick: (emoji: string | null) => void; onClose: () => void; removable?: boolean }) {
  const [query, setQuery] = useState("");
  const groups = useMemo(() => GROUPS.map((g) => ({ ...g, list: g.emojis.split(" ") })), []);
  const custom = query.trim();
  return (
    <Popover anchor={props.anchor} onClose={props.onClose} width={352} className="nk-emoji">
      <div className="nk-emoji-head">
        <input
          autoFocus
          className="nk-input"
          placeholder="Emoji einfügen oder Gruppe suchen …"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            // Eigenes Emoji eintippen/einfügen und mit Enter übernehmen
            if (e.key === "Enter" && custom && /\p{Extended_Pictographic}/u.test(custom)) props.onPick(custom);
          }}
        />
        <button type="button" className="nk-btn is-ghost" onClick={() => props.onPick(randomEmoji())}>
          Zufällig
        </button>
        {props.removable && (
          <button type="button" className="nk-btn is-ghost" onClick={() => props.onPick(null)}>
            Entfernen
          </button>
        )}
      </div>
      <div className="nk-emoji-body">
        {groups
          .filter((g) => !custom || g.name.toLowerCase().includes(custom.toLowerCase()) || g.list.includes(custom))
          .map((g) => (
            <div key={g.name}>
              <div className="nk-menu-section">{g.name}</div>
              <div className="nk-emoji-grid">
                {g.list.map((e, i) => (
                  <button key={e + i} type="button" className="nk-emoji-btn" onClick={() => props.onPick(e)}>
                    {e}
                  </button>
                ))}
              </div>
            </div>
          ))}
      </div>
    </Popover>
  );
}

// ---------------- Titelbilder ----------------

export const COVER_PRESETS: { id: string; css: string }[] = [
  { id: "gradient:sunrise", css: "linear-gradient(120deg, #f6d365 0%, #fda085 100%)" },
  { id: "gradient:ocean", css: "linear-gradient(120deg, #89f7fe 0%, #66a6ff 100%)" },
  { id: "gradient:forest", css: "linear-gradient(120deg, #a8e063 0%, #56ab2f 100%)" },
  { id: "gradient:dusk", css: "linear-gradient(120deg, #a18cd1 0%, #fbc2eb 100%)" },
  { id: "gradient:night", css: "linear-gradient(120deg, #232526 0%, #414345 100%)" },
  { id: "gradient:candy", css: "linear-gradient(120deg, #ff9a9e 0%, #fecfef 100%)" },
  { id: "gradient:sea", css: "linear-gradient(120deg, #2193b0 0%, #6dd5ed 100%)" },
  { id: "gradient:ember", css: "linear-gradient(120deg, #f12711 0%, #f5af19 100%)" },
  { id: "color:red", css: "#e16259" },
  { id: "color:yellow", css: "#dfab01" },
  { id: "color:blue", css: "#337ea9" },
  { id: "color:green", css: "#4d8c5d" },
  { id: "color:purple", css: "#9065b0" },
  { id: "color:gray", css: "#9b9a97" },
];

export const coverCss = (cover: string) => COVER_PRESETS.find((c) => c.id === cover)?.css;
