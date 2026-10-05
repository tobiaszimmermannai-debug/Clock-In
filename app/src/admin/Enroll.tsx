// Gesicht erfassen: Einwilligung bestätigen → 5 Aufnahmen → Doppelungsprüfung → speichern
import { useState } from "react";
import { FaceCapture } from "../components/FaceCapture";
import { rankCandidates } from "../lib/match";
import { adminDb } from "../lib/supabase";
import type { RosterEntry } from "../lib/types";
import type { Person } from "./Staff";

// Strenger als der Erkennungs-Schwellwert: Warnung, wenn jemand anderem sehr ähnlich
const DUPLICATE_DISTANCE = 0.45;

type Phase =
  | { kind: "consent" }
  | { kind: "capture" }
  | { kind: "confirm-duplicate"; descriptors: Float32Array[]; otherName: string }
  | { kind: "saving" }
  | { kind: "done"; text: string }
  | { kind: "error"; text: string };

export function Enroll(props: { person: Person; isAdmin: boolean; hasFace: boolean; onDone: () => void }) {
  const { person } = props;
  const name = `${person.first_name} ${person.last_name}`;
  const [phase, setPhase] = useState<Phase>({ kind: "consent" });
  const [consent, setConsent] = useState(false);

  async function captured(descriptors: Float32Array[]) {
    // Doppelungsprüfung gegen alle anderen (nur Admin darf alle Embeddings lesen)
    if (props.isAdmin) {
      const { data } = await adminDb.rpc("kiosk_roster");
      const others = ((data ?? []) as RosterEntry[]).filter((r) => r.user_id !== person.id);
      const [closest] = rankCandidates(descriptors[0], others);
      if (closest && closest.distance < DUPLICATE_DISTANCE) {
        const otherName = `${closest.entry.first_name} ${closest.entry.last_name}`;
        return setPhase({ kind: "confirm-duplicate", descriptors, otherName });
      }
    }
    await save(descriptors);
  }

  async function save(descriptors: Float32Array[]) {
    setPhase({ kind: "saving" });
    // Admin ersetzt alte Aufnahmen; Studioleitung ergänzt (darf fremde Biometrie nicht lesen)
    const old = props.isAdmin ? await adminDb.from("face_embeddings").select("id").eq("user_id", person.id) : null;
    const consentAt = new Date().toISOString();
    const { error } = await adminDb.from("face_embeddings").insert(
      descriptors.map((d) => ({ user_id: person.id, descriptor: Array.from(d), consent_given_at: consentAt })),
    );
    if (error) return setPhase({ kind: "error", text: `Speichern fehlgeschlagen: ${error.message}` });
    const oldIds = (old?.data ?? []).map((r) => r.id);
    if (oldIds.length) await adminDb.from("face_embeddings").delete().in("id", oldIds);
    setPhase({ kind: "done", text: `Gesicht von ${name} gespeichert. Das Tablet kennt die Person nach dem nächsten Abgleich (spätestens 5 Min.).` });
  }

  async function remove() {
    const { error } = await adminDb.from("face_embeddings").delete().eq("user_id", person.id);
    setPhase(error ? { kind: "error", text: error.message } : { kind: "done", text: `Gesichtsdaten von ${name} gelöscht.` });
  }

  return (
    <section className="stack">
      <div className="row-between">
        <h1>Gesicht erfassen: {name}</h1>
        <button type="button" className="btn-ghost" onClick={props.onDone}>Zurück</button>
      </div>

      {phase.kind === "consent" && (
        <div className="card form">
          <p>
            Gespeichert werden nur Zahlenwerte (128 Merkmale), kein Foto. Für biometrische Daten ist eine
            schriftliche Einwilligung nötig (Art. 9 DSGVO).
          </p>
          <label className="check">
            <input id="consent" type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
            Die schriftliche Einwilligung von {name} liegt vor.
          </label>
          <div className="row">
            <button type="button" className="btn-primary" disabled={!consent} onClick={() => setPhase({ kind: "capture" })}>
              Erfassung starten
            </button>
            {props.isAdmin && props.hasFace && (
              <button type="button" className="btn-danger" onClick={remove}>Gesichtsdaten löschen</button>
            )}
          </div>
        </div>
      )}

      {phase.kind === "capture" && <FaceCapture onCaptured={(d) => void captured(d)} />}

      {phase.kind === "confirm-duplicate" && (
        <div className="card form">
          <p className="notice notice-warn">
            Diese Aufnahme ähnelt stark <b>{phase.otherName}</b>. Steht wirklich {name} vor der Kamera?
          </p>
          <div className="row">
            <button type="button" className="btn-primary" onClick={() => void save(phase.descriptors)}>
              Ja, für {person.first_name} speichern
            </button>
            <button type="button" className="btn-ghost" onClick={() => setPhase({ kind: "capture" })}>Neu aufnehmen</button>
          </div>
        </div>
      )}

      {phase.kind === "saving" && <p className="muted">Speichert …</p>}
      {(phase.kind === "done" || phase.kind === "error") && (
        <div className="card form">
          <p className={phase.kind === "error" ? "form-error" : ""}>{phase.text}</p>
          <button type="button" className="btn-primary" onClick={props.onDone}>Fertig</button>
        </div>
      )}
    </section>
  );
}
