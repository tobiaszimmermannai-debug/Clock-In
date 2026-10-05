// Gesicht erfassen: Einwilligung (digital unterschrieben) → 5 Aufnahmen → Doppelungsprüfung → speichern
import { useCallback, useEffect, useState } from "react";
import { FaceCapture } from "../components/FaceCapture";
import { rankCandidates } from "../lib/match";
import { adminDb } from "../lib/supabase";
import type { RosterEntry } from "../lib/types";
import { type ConsentRecord, ConsentForm, ConsentProof } from "./Consent";
import type { Person } from "./Staff";

// Strenger als der Erkennungs-Schwellwert: Warnung, wenn jemand anderem sehr ähnlich
const DUPLICATE_DISTANCE = 0.45;

type Phase =
  | { kind: "loading" }
  | { kind: "consent" }
  | { kind: "ready"; consent: ConsentRecord; confirmRevoke?: boolean }
  | { kind: "capture" }
  | { kind: "confirm-duplicate"; descriptors: Float32Array[]; otherName: string }
  | { kind: "saving" }
  | { kind: "done"; text: string }
  | { kind: "error"; text: string };

export function Enroll(props: { person: Person; isAdmin: boolean; onDone: () => void }) {
  const { person } = props;
  const name = `${person.first_name} ${person.last_name}`;
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });

  const load = useCallback(async () => {
    const { data, error } = await adminDb
      .from("biometric_consents")
      .select("id, given_at, signed_name, consent_text, signature_svg, version")
      .eq("user_id", person.id)
      .is("revoked_at", null)
      .maybeSingle<ConsentRecord>();
    if (error) return setPhase({ kind: "error", text: error.message });
    setPhase(data ? { kind: "ready", consent: data } : { kind: "consent" });
  }, [person.id]);

  useEffect(() => {
    void load();
  }, [load]);

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
    // Einwilligung & Zeitpunkt verknüpft die Datenbank selbst
    const { error } = await adminDb
      .from("face_embeddings")
      .insert(descriptors.map((d) => ({ user_id: person.id, descriptor: Array.from(d) })));
    if (error) return setPhase({ kind: "error", text: `Speichern fehlgeschlagen: ${error.message}` });
    const oldIds = (old?.data ?? []).map((r) => r.id);
    if (oldIds.length) await adminDb.from("face_embeddings").delete().in("id", oldIds);
    setPhase({
      kind: "done",
      text: `Gesicht von ${name} gespeichert. Die Tablets kennen die Person nach dem nächsten Abgleich (spätestens 5 Min.).`,
    });
  }

  async function revoke(consentId: string) {
    const { error } = await adminDb
      .from("biometric_consents")
      .update({ revoked_at: new Date().toISOString() })
      .eq("id", consentId);
    setPhase(
      error
        ? { kind: "error", text: error.message }
        : { kind: "done", text: `Einwilligung von ${name} widerrufen. Alle Gesichtsdaten wurden gelöscht.` },
    );
  }

  return (
    <section className="stack">
      <div className="row-between">
        <h1>Gesicht erfassen: {name}</h1>
        <button type="button" className="btn-ghost" onClick={props.onDone}>Zurück</button>
      </div>

      {phase.kind === "loading" && <p className="muted">Lädt …</p>}

      {phase.kind === "consent" && (
        <ConsentForm
          person={person}
          onSigned={load}
          onDecline={() =>
            setPhase({
              kind: "done",
              text: `${person.first_name} hat nicht eingewilligt. Es werden keine Gesichtsdaten gespeichert; die Arbeitszeit wird auf anderem Weg erfasst.`,
            })
          }
        />
      )}

      {phase.kind === "ready" && (
        <div className="card form form-wide">
          <p className="notice notice-info">
            Einwilligung liegt vor: unterschrieben von {phase.consent.signed_name} am{" "}
            {new Date(phase.consent.given_at).toLocaleDateString("de-DE", { timeZone: "Europe/Berlin" })}.
          </p>
          <ConsentProof consent={phase.consent} />
          <div className="row">
            <button type="button" className="btn-primary" onClick={() => setPhase({ kind: "capture" })}>
              Erfassung starten
            </button>
            {!phase.confirmRevoke ? (
              <button type="button" className="btn-danger" onClick={() => setPhase({ ...phase, confirmRevoke: true })}>
                Einwilligung widerrufen
              </button>
            ) : (
              <button type="button" className="btn-danger" onClick={() => void revoke(phase.consent.id)}>
                Wirklich widerrufen und Gesichtsdaten löschen
              </button>
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
