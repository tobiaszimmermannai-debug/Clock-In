// Prestige: Blitzi hat Stufe 30 → ein Item aus 100 wählen (bleibt für immer), Blitzi startet wieder bei Stufe 1.
// Beim ersten Mal zusätzlich ein Spitzname (Pflicht, 2–20 Zeichen) – danach heißt Blitzi „Spitzname (Name)“.
import { useMemo, useState } from "react";
import { useNotes } from "../state";
import type { Member } from "../types";
import { Modal } from "../ui/Popover";
import { Blitzi } from "./Blitzi";
import { MAX_PRESTIGE } from "./evolution";
import { ITEM_CATS, ITEMS, type ItemCat } from "./items";

export const NICK_RE = /^[\p{L}\p{N} .\-_]{2,20}$/u;
export const nicknameProblem = (nick: string) =>
  NICK_RE.test(nick.trim()) ? null : "Spitzname: 2–20 Zeichen (Buchstaben, Zahlen, Leerzeichen, - . _).";

export function PrestigeModal(props: { member: Member; onClose: () => void }) {
  const notes = useNotes();
  const info = notes.blitzi(props.member.id);
  const first = info.prestige === 0;
  const [cat, setCat] = useState<ItemCat>("pet");
  const [item, setItem] = useState<string | null>(null);
  const [nick, setNick] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const owned = useMemo(() => new Set(info.items), [info.items]);
  const problem = !item ? "Bitte ein Item wählen." : first ? nicknameProblem(nick) : null;

  const save = async () => {
    if (problem || !item) return setError(problem ?? undefined);
    setBusy(true);
    try {
      await notes.prestige(props.member.id, item, first ? nick.trim() : undefined);
      notes.toast(`Prestige ${info.prestige + 1}! Blitzi startet wieder bei Stufe 1 – mit neuem Item.`);
      props.onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal label="Prestige" onClose={props.onClose} className="nk-prestige-modal">
      <div className="nk-modal-head">
        <b>🏅 Stufe 30 – Prestige {info.prestige + 1}</b>
        <button type="button" className="nk-btn is-ghost nk-evo-close" onClick={props.onClose} aria-label="Schließen">✕</button>
      </div>
      <div className="nk-prestige-body">
        <div className="nk-prestige-preview">
          <Blitzi mood="party" stage={30} items={item ? [...info.items, item] : info.items} size={150} still />
          <p className="nk-muted">Wähle 1 Item – es bleibt für immer. Danach fängt Blitzi wieder bei Stufe 1 an.</p>
          {first && (
            <label className="nk-prestige-nick">
              <span>Spitzname für Blitzi (Pflicht)</span>
              <input value={nick} maxLength={20} placeholder="z. B. Stromi" onChange={(e) => (setNick(e.target.value), setError(undefined))} />
            </label>
          )}
          {error && <p className="nk-prestige-error">{error}</p>}
          <button type="button" className="nk-btn is-primary" disabled={busy || Boolean(problem)} onClick={() => void save()}>
            {busy ? "…" : "Item übernehmen"}
          </button>
          <small className="nk-muted">{owned.size}/{MAX_PRESTIGE} Items gesammelt</small>
        </div>
        <div className="nk-prestige-shop">
          <nav className="nk-prestige-cats">
            {ITEM_CATS.map((c) => (
              <button key={c.id} type="button" aria-pressed={cat === c.id} onClick={() => setCat(c.id)}>
                {c.label}
              </button>
            ))}
          </nav>
          <div className="nk-prestige-grid">
            {ITEMS.filter((i) => i.cat === cat).map((i) => (
              <button key={i.id} type="button" className="nk-prestige-item" aria-pressed={item === i.id} disabled={owned.has(i.id)}
                title={owned.has(i.id) ? `${i.name} – schon vorhanden` : i.name} onClick={() => (setItem(i.id), setError(undefined))}>
                <Blitzi mood="happy" stage={14} items={[i.id]} size={56} still noShadow />
                <span>{i.name}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
    </Modal>
  );
}
