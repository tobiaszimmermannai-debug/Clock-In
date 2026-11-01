// Versionsverlauf einer Seite: gespeicherte Stände ansehen und wiederherstellen
import { de } from "@blocknote/core/locales";
import { BlockNoteView } from "@blocknote/mantine";
import { useCreateBlockNote } from "@blocknote/react";
import { useEffect, useState } from "react";
import { schema } from "./editor/blocks";
import { useNotes } from "./state";
import type { Blocks, PageMeta, Version } from "./types";
import { Icon } from "./ui/Icon";
import { Modal } from "./ui/Popover";
import { formatTimestamp, relativeTime, untitled } from "./util";

export function VersionHistory(props: { page: PageMeta; theme: "light" | "dark"; onClose: () => void }) {
  const notes = useNotes();
  const { page } = props;
  const [versions, setVersions] = useState<Version[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [preview, setPreview] = useState<Version | null>(null);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const load = () =>
    notes.store
      .listVersions(page.id)
      .then((list) => {
        setVersions(list);
        setSelected((s) => s ?? list[0]?.id ?? null);
      })
      .catch((e: Error) => setError(e.message));

  useEffect(() => {
    void load();
    // Nur beim Öffnen laden
  }, [page.id]);

  useEffect(() => {
    if (!selected) return setPreview(null);
    let cancelled = false;
    setPreview(null);
    notes.store
      .getVersion(selected)
      .then((v) => !cancelled && setPreview(v))
      .catch((e: Error) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [selected, notes.store]);

  const author = (id: string | null) => notes.members.find((m) => m.id === id)?.name ?? "Unbekannt";

  const saveNow = async () => {
    setBusy(true);
    try {
      await notes.saveVersionNow(page.id, await notes.loadContent(page.id));
      setSelected(null);
      await load();
      notes.toast("Version gespeichert");
    } finally {
      setBusy(false);
    }
  };

  const restore = async () => {
    if (!preview?.content) return;
    setBusy(true);
    try {
      await notes.restoreVersion(page.id, preview);
      notes.toast(`Stand vom ${formatTimestamp(preview.createdAt)} wiederhergestellt`);
      props.onClose();
    } catch (e) {
      notes.toast(`Wiederherstellen fehlgeschlagen: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal onClose={props.onClose} label="Versionsverlauf" className="nk-history">
      <div className="nk-modal-head">
        <Icon name="history" />
        <b>Versionsverlauf: {untitled(page)}</b>
        <span className="nk-spacer" />
        <button type="button" className="nk-btn" disabled={busy} onClick={() => void saveNow()}>
          Jetzt Version speichern
        </button>
        <button type="button" className="nk-icon-btn" aria-label="Schließen" onClick={props.onClose}>
          <Icon name="close" />
        </button>
      </div>
      <div className="nk-history-body">
        <div className="nk-history-list">
          {error && <div className="nk-error">{error}</div>}
          {versions?.map((v) => (
            <button key={v.id} type="button" className={`nk-history-item${v.id === selected ? " is-active" : ""}`} onClick={() => setSelected(v.id)}>
              <b>{formatTimestamp(v.createdAt)}</b>
              <small className="nk-muted">
                {author(v.createdBy)} · {relativeTime(v.createdAt)}
              </small>
            </button>
          ))}
          {versions && !versions.length && (
            <div className="nk-empty-hint">Noch keine Versionen. Beim Bearbeiten wird höchstens alle 10 Minuten automatisch ein Stand gesichert.</div>
          )}
          {!versions && !error && <div className="nk-skeleton" />}
        </div>
        <div className="nk-history-preview">
          {preview?.content ? <Preview key={preview.id} blocks={preview.content} title={preview.title} theme={props.theme} /> : selected ? <div className="nk-skeleton" /> : null}
        </div>
      </div>
      <div className="nk-modal-foot">
        <span className="nk-muted">Der aktuelle Stand wird vor dem Wiederherstellen als Version gesichert.</span>
        <span className="nk-spacer" />
        <button type="button" className="nk-btn" onClick={props.onClose}>
          Abbrechen
        </button>
        <button type="button" className="nk-btn is-primary" disabled={!preview?.content || busy} onClick={() => void restore()}>
          Diese Version wiederherstellen
        </button>
      </div>
    </Modal>
  );
}

function Preview(props: { blocks: Blocks; title: string; theme: "light" | "dark" }) {
  const editor = useCreateBlockNote({ schema, dictionary: de, initialContent: props.blocks.length ? (props.blocks as never) : undefined });
  return (
    <div className="nk-history-doc">
      <h1 className="nk-history-title">{props.title || "Ohne Titel"}</h1>
      <BlockNoteView editor={editor} editable={false} theme={props.theme} className="nk-editor" />
    </div>
  );
}
