// Digitale Einwilligung: Mitarbeiter liest selbst, bestätigt und unterschreibt am Gerät
import { useMemo, useState } from "react";
import { SignaturePad } from "../components/SignaturePad";
import { Field, Notice } from "../components/ui";
import { CONSENT_VERSION, consentText } from "../lib/consentText";
import { adminDb } from "../lib/supabase";
import type { Person } from "./Staff";

export type ConsentRecord = {
  id: string;
  given_at: string;
  signed_name: string;
  consent_text: string;
  signature_svg: string;
  version: string;
};

export function ConsentForm(props: { person: Person; onSigned: () => void; onDecline: () => void }) {
  const fullName = `${props.person.first_name} ${props.person.last_name}`;
  const text = useMemo(() => consentText(fullName), [fullName]);
  const [agreed, setAgreed] = useState(false);
  const [signedName, setSignedName] = useState(fullName);
  const [signature, setSignature] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  async function submit() {
    if (!signature) return;
    setBusy(true);
    const { error } = await adminDb.from("biometric_consents").insert({
      user_id: props.person.id,
      version: CONSENT_VERSION,
      consent_text: text,
      signed_name: signedName.trim(),
      signature_svg: signature,
    });
    setBusy(false);
    if (error) return setError(`Speichern fehlgeschlagen: ${error.message}`);
    props.onSigned();
  }

  return (
    <div className="panel form">
      <Notice>Bitte das Gerät an {props.person.first_name} übergeben: selbst lesen, bestätigen und unterschreiben.</Notice>
      <div className="consent-text" tabIndex={0}>{text}</div>
      <label className="check">
        <input id="consent-agree" type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />
        <span>Ich habe die Erklärung gelesen und willige freiwillig ein.</span>
      </label>
      <Field label="Name">
        <input id="consent-name" value={signedName} onChange={(e) => setSignedName(e.target.value)} autoComplete="off" />
      </Field>
      <SignaturePad onChange={setSignature} />
      {error && <Notice tone="error">{error}</Notice>}
      <div className="form-actions">
        <button type="button" className="btn btn-outline" onClick={props.onDecline}>Nicht einwilligen</button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={!agreed || !signature || signedName.trim().length < 3 || busy}
          onClick={submit}
        >
          Einwilligen und unterschreiben
        </button>
      </div>
    </div>
  );
}

// Nachweis anzeigen: Text, Name, Unterschrift, Zeitpunkt
export function ConsentProof({ consent }: { consent: ConsentRecord }) {
  const src = `data:image/svg+xml;utf8,${encodeURIComponent(consent.signature_svg)}`;
  return (
    <details className="proof">
      <summary>Unterschriebene Einwilligung anzeigen</summary>
      <div className="consent-text">{consent.consent_text}</div>
      <p className="small muted">
        Unterschrieben von {consent.signed_name} am{" "}
        {new Date(consent.given_at).toLocaleString("de-DE", { timeZone: "Europe/Berlin" })} · Version {consent.version}
      </p>
      <img className="signature-proof" src={src} alt={`Unterschrift von ${consent.signed_name}`} />
    </details>
  );
}
