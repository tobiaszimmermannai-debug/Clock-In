// Schnell eine Aufgabe für eine Person anlegen (landet in der Team-Liste ihres Studios – auch am Studio-PC sichtbar)
import { useState } from "react";
import { useNotes } from "../state";
import type { Member, PageMeta } from "../types";
import { createTaskFor } from "./teamList";

export function QuickAdd(props: { member: Member; placeholder?: string; onCreated?: (row: PageMeta) => void; autoFocus?: boolean }) {
  const notes = useNotes();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const first = props.member.name.split(" ")[0];
  const submit = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    try {
      const row = await createTaskFor(notes, props.member, text, notes.access.studioLocationId);
      if (row) {
        setText("");
        props.onCreated?.(row);
      }
    } catch {
      // Fehlermeldung zeigt createPage bereits an
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="nk-quickadd"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <span aria-hidden>＋</span>
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={props.placeholder ?? `Neue Aufgabe für ${first} …`}
        aria-label={`Neue Aufgabe für ${first}`}
        autoFocus={props.autoFocus}
      />
      <button type="submit" className="nk-btn is-primary" disabled={!text.trim() || busy}>
        {busy ? "…" : "Anlegen"}
      </button>
    </form>
  );
}
