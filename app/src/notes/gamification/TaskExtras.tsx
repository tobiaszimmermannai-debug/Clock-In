// Fotonachweis-Dialog, Aufgaben-Optionen (Wiederholen, Fotonachweis) und Nachweis-Anzeige
import { useEffect, useState } from "react";
import { useNotes } from "../state";
import type { PageMeta, PropValue } from "../types";
import { Modal } from "../ui/Popover";
import { PinButton } from "./PinTask";
import { movesOf, needsPhoto, PHOTO_AFTER_MOVES, PHOTO_KEY, proofOf, REPEAT_KEY, REPEAT_LABELS, repeatOf } from "./recur";

/** Erscheint, wenn eine Aufgabe mit Fotonachweis abgehakt wird */
export function PhotoProofModal() {
  const notes = useNotes();
  const req = notes.photoRequest;
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!file) return setPreview(null);
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);
  if (!req) return null;
  const close = () => {
    setFile(null);
    void notes.resolvePhoto(null);
  };
  return (
    <Modal label="Fotonachweis" onClose={close} className="nk-photo-modal">
      <div className="nk-modal-head">
        <b>📷 Fotonachweis für „{req.title || "Ohne Titel"}“</b>
      </div>
      <div className="nk-photo-body">
        <p className="nk-muted">
          {req.reason === "lead"
            ? "Die Studioleitung möchte für diese Aufgabe ein Foto sehen."
            : `Diese Aufgabe wurde ${PHOTO_AFTER_MOVES}× oder öfter verschoben – bitte ein Foto als Nachweis.`}{" "}
          Erst mit Foto gilt sie als erledigt.
        </p>
        <label className="nk-photo-pick">
          {preview ? <img src={preview} alt="Vorschau" /> : <span>📸 Foto aufnehmen oder auswählen</span>}
          <input type="file" accept="image/*" capture="environment" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        </label>
      </div>
      <div className="nk-modal-foot">
        <span className="nk-spacer" />
        <button type="button" className="nk-btn is-ghost" onClick={close}>
          Abbrechen
        </button>
        <button
          type="button"
          className="nk-btn is-primary"
          disabled={!file || busy}
          onClick={async () => {
            setBusy(true);
            await notes.resolvePhoto(file);
            setBusy(false);
            setFile(null);
          }}
        >
          {busy ? "Lädt hoch …" : "Hochladen & erledigt"}
        </button>
      </div>
    </Modal>
  );
}

/** Kleines Kennzeichen in Aufgabenlisten: Nachweis ansehen bzw. „Foto nötig“ */
export function ProofBadge(props: { row: PageMeta; done: boolean }) {
  const notes = useNotes();
  const proof = proofOf(props.row);
  const need = needsPhoto(props.row);
  if (proof)
    return (
      <button
        type="button"
        className="nk-proof is-done"
        title={`Fotonachweis vom ${new Date(proof.at).toLocaleString("de-DE")}`}
        onClick={async (e) => {
          e.stopPropagation();
          window.open(await notes.store.resolveUrl(proof.url), "_blank", "noopener");
        }}
      >
        📷 Nachweis
      </button>
    );
  if (need.required && !props.done)
    return (
      <span className="nk-proof" title={need.reason === "lead" ? "Die Leitung möchte ein Foto" : `${movesOf(props.row)}× verschoben`}>
        📷 Foto nötig
      </span>
    );
  return null;
}

/** Optionen einer Aufgabe (in der Seitenansicht über dem Inhalt) */
export function TaskOptions(props: { row: PageMeta; studioTask?: boolean }) {
  const notes = useNotes();
  const { row } = props;
  const lead = notes.access.oversee;
  const repeat = repeatOf(row);
  const moves = movesOf(row);
  const set = (key: string, value: PropValue | undefined) => {
    const next = { ...row.props };
    if (value === undefined) delete next[key];
    else next[key] = value;
    notes.updatePage(row.id, { props: next }, { delay: 0 });
  };
  return (
    <div className="nk-task-options">
      <div className="nk-task-option-row">
        <span>📌 Tagesaufgabe</span>
        <PinButton row={row} full />
      </div>
      <label>
        <span>🔁 Wiederholen</span>
        {props.studioTask ? (
          <input type="checkbox" checked={repeat === "period"} onChange={(e) => set(REPEAT_KEY, e.target.checked ? "period" : undefined)} />
        ) : (
          <select value={repeat && repeat !== "period" ? repeat : ""} onChange={(e) => set(REPEAT_KEY, e.target.value || undefined)}>
            <option value="">nie</option>
            {Object.entries(REPEAT_LABELS).map(([k, label]) => (
              <option key={k} value={k}>
                {label}
              </option>
            ))}
          </select>
        )}
        {props.studioTask && <small>jede Woche bzw. jeden Monat neu</small>}
      </label>
      <label title={lead ? "" : "Nur Studioleitung und Geschäftsführung"}>
        <span>📷 Fotonachweis</span>
        <input type="checkbox" checked={row.props[PHOTO_KEY] === true} disabled={!lead} onChange={(e) => set(PHOTO_KEY, e.target.checked ? true : undefined)} />
        {moves > 0 && (
          <small className={moves >= PHOTO_AFTER_MOVES ? "is-warn" : ""}>
            {moves}× verschoben{moves >= PHOTO_AFTER_MOVES ? " – Foto nötig" : ""}
          </small>
        )}
      </label>
      <ProofBadge row={row} done={false} />
    </div>
  );
}
