// Studios verwalten (nur Admin): anlegen, ausblenden/einblenden, löschen.
// Ausblenden behält alle Schichten und Stempelzeiten; löschen geht nur bei unbenutzten Studios.
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { Field, Icon, Notice, Pill, Row, Section, Sheet } from "../components/ui";
import { registerStudios, studioCode, studioColor } from "../lib/studios";
import { adminDb } from "../lib/supabase";
import { type Location, studioShort } from "../lib/types";

type Studio = Location & { is_active: boolean };

export function StudiosSection(props: { onChanged: () => void }) {
  const [studios, setStudios] = useState<Studio[]>([]);
  const [selected, setSelected] = useState<Studio | null>(null);
  const [creating, setCreating] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string }>();

  const load = useCallback(async () => {
    const { data, error } = await adminDb.from("locations").select("id, code, name, is_active").order("name");
    if (error) return setMessage({ tone: "error", text: error.message });
    registerStudios(data as Studio[]);
    setStudios(data as Studio[]);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const changed = (text: string) => {
    setSelected(null);
    setCreating(false);
    setMessage({ tone: "ok", text });
    void load();
    props.onChanged();
  };

  return (
    <>
      {message && <Notice tone={message.tone}>{message.text}</Notice>}
      <Section
        title="Studios"
        aside={<button type="button" className="btn btn-plain btn-sm" onClick={() => setCreating(true)}><Icon name="plus" size={16} /> Neues Studio</button>}
        footer="Ausgeblendete Studios erscheinen nirgends mehr – Schichten und Stempelzeiten bleiben gespeichert."
      >
        {studios.map((s) => (
          <Row
            key={s.id}
            leading={<span className="studio-swatch" style={{ background: studioColor(s.id) }} aria-hidden="true" />}
            title={studioShort(s.name)}
            subtitle={s.is_active ? "Aktiv" : "Ausgeblendet"}
            trailing={!s.is_active && <Pill>ausgeblendet</Pill>}
            chevron
            onClick={() => setSelected(s)}
          />
        ))}
      </Section>
      {selected && <StudioSheet studio={selected} onClose={() => setSelected(null)} onDone={changed} />}
      {creating && <NewStudio onClose={() => setCreating(false)} onDone={changed} />}
    </>
  );
}

function StudioSheet(props: { studio: Studio; onClose: () => void; onDone: (text: string) => void }) {
  const s = props.studio;
  const name = studioShort(s.name);
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  async function toggle() {
    setBusy(true);
    const { error } = await adminDb.from("locations").update({ is_active: !s.is_active }).eq("id", s.id);
    setBusy(false);
    if (error) return setError(error.message);
    props.onDone(s.is_active ? `${name} ist ausgeblendet.` : `${name} ist wieder aktiv.`);
  }

  async function remove() {
    setBusy(true);
    const { error } = await adminDb.from("locations").delete().eq("id", s.id);
    setBusy(false);
    if (error) {
      setConfirm(false);
      return setError(
        error.code === "23503"
          ? `${name} hat schon Schichten oder Stempelzeiten und kann deshalb nicht gelöscht werden – bitte ausblenden.`
          : error.message,
      );
    }
    props.onDone(`${name} wurde gelöscht.`);
  }

  return (
    <Sheet
      title={name}
      subtitle={s.is_active ? "Aktiv" : "Ausgeblendet"}
      onClose={props.onClose}
      footer={
        <>
          <button type="button" className={confirm ? "btn btn-danger-solid" : "btn btn-danger"} disabled={busy}
            onClick={() => (confirm ? void remove() : setConfirm(true))}>
            {confirm ? "Wirklich löschen" : "Löschen"}
          </button>
          <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void toggle()}>
            {s.is_active ? "Ausblenden" : "Wieder einblenden"}
          </button>
        </>
      }
    >
      <p className="muted">
        <b>Ausblenden:</b> {name} verschwindet aus Dienstplan, Auswahllisten und am Tablet. Schichten und Stempelzeiten
        bleiben gespeichert, und du kannst es jederzeit wieder einblenden.
      </p>
      <p className="muted">
        <b>Löschen:</b> nur möglich, solange es dort noch keine Schichten oder Stempelzeiten gibt.
      </p>
      {error && <Notice tone="error">{error}</Notice>}
    </Sheet>
  );
}

function NewStudio(props: { onClose: () => void; onDone: (text: string) => void }) {
  const [name, setName] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const code = studioCode(name);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const clean = name.trim().replace(/^Studio\s+/i, "");
    if (code.length < 2) return setError("Bitte einen Namen mit mindestens 2 Buchstaben eingeben.");
    setBusy(true);
    const { error } = await adminDb.from("locations").insert({ code, name: `Studio ${clean}` });
    setBusy(false);
    if (error) return setError(error.code === "23505" ? "Ein Studio mit diesem Namen gibt es schon." : error.message);
    props.onDone(`Studio ${clean} angelegt.`);
  }

  return (
    <Sheet
      title="Neues Studio"
      onClose={props.onClose}
      footer={<button type="submit" form="new-studio" className="btn btn-primary" disabled={busy || !name.trim()}>Anlegen</button>}
    >
      <form id="new-studio" className="form" onSubmit={submit}>
        <Field label="Name" hint="z. B. Fürstenfeldbruck – ohne „Studio“ davor">
          <input id="studio-name" value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" required />
        </Field>
        {error && <Notice tone="error">{error}</Notice>}
      </form>
    </Sheet>
  );
}
