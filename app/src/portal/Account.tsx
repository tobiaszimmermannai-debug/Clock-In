// Konto: Passwort ändern, Einwilligung zur Gesichtserkennung widerrufen, abmelden
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { Field, LeadingIcon, Notice, PageHeader, Row, Section } from "../components/ui";
import { portalDb } from "../lib/supabase";
import type { Me } from "./PortalApp";

export function Account(props: { me: Me; onLogout: () => void }) {
  const [consent, setConsent] = useState<{ id: string; given_at: string } | null>();
  const [confirm, setConfirm] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string }>();

  const loadConsent = useCallback(async () => {
    const { data } = await portalDb
      .from("biometric_consents")
      .select("id, given_at")
      .eq("user_id", props.me.id)
      .is("revoked_at", null)
      .maybeSingle();
    setConsent(data ?? null);
  }, [props.me.id]);

  useEffect(() => {
    void loadConsent();
  }, [loadConsent]);

  async function revoke() {
    if (!consent) return;
    const { error } = await portalDb
      .from("biometric_consents")
      .update({ revoked_at: new Date().toISOString() })
      .eq("id", consent.id);
    setConfirm(false);
    setMessage(
      error
        ? { tone: "error", text: error.message }
        : { tone: "ok", text: "Einwilligung widerrufen. Deine Gesichtsdaten wurden gelöscht. Stempeln bitte telefonisch bei Tobias oder Dominik melden." },
    );
    void loadConsent();
  }

  async function changePassword(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    const pw = String(f.get("password"));
    if (pw !== String(f.get("password2"))) return setMessage({ tone: "error", text: "Die Passwörter stimmen nicht überein." });
    const { error } = await portalDb.auth.updateUser({ password: pw });
    if (error) return setMessage({ tone: "error", text: `Passwort konnte nicht geändert werden: ${error.message}` });
    form.reset();
    setMessage({ tone: "ok", text: "Passwort geändert." });
  }

  return (
    <>
      <PageHeader title="Konto" subtitle={`${props.me.first_name} ${props.me.last_name}`} />
      {message && <Notice tone={message.tone}>{message.text}</Notice>}

      <Section title="Gesichtserkennung">
        {consent === undefined && <p className="list-empty">Lädt …</p>}
        {consent === null && <Row leading={<LeadingIcon name="face" />} title="Keine Gesichtsdaten gespeichert" />}
        {consent && (
          <div className="list-item">
            <Row
              leading={<LeadingIcon name="face" />}
              title="Einwilligung erteilt"
              subtitle={`am ${new Date(consent.given_at).toLocaleDateString("de-DE", { timeZone: "Europe/Berlin" })} · jederzeit ohne Nachteile widerrufbar`}
            />
            <div className="list-actions indent">
              {!confirm ? (
                <button type="button" className="btn btn-danger btn-sm" onClick={() => setConfirm(true)}>Einwilligung widerrufen</button>
              ) : (
                <button type="button" className="btn btn-danger-solid btn-sm" onClick={() => void revoke()}>
                  Wirklich widerrufen und Gesichtsdaten löschen
                </button>
              )}
            </div>
          </div>
        )}
      </Section>

      <Section title="Passwort ändern" plain>
        <form className="panel form" onSubmit={changePassword}>
          <Field label="Neues Passwort" hint="Mindestens 10 Zeichen">
            <input id="new-password" name="password" type="password" minLength={10} autoComplete="new-password" required />
          </Field>
          <Field label="Wiederholen">
            <input id="new-password2" name="password2" type="password" minLength={10} autoComplete="new-password" required />
          </Field>
          <div className="form-actions">
            <button type="submit" className="btn btn-secondary">Passwort speichern</button>
          </div>
        </form>
      </Section>

      <Section>
        <Row className="is-danger" leading={<LeadingIcon name="logout" />} title="Abmelden" onClick={props.onLogout} />
      </Section>
    </>
  );
}
