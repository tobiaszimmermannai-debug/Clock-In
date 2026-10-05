// Konto: Passwort ändern, Einwilligung zur Gesichtserkennung widerrufen, abmelden
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { portalDb } from "../lib/supabase";
import type { Me } from "./PortalApp";

export function Account(props: { me: Me; onLogout: () => void }) {
  const [consent, setConsent] = useState<{ id: string; given_at: string } | null>();
  const [confirm, setConfirm] = useState(false);
  const [message, setMessage] = useState<{ tone: "info" | "error"; text: string }>();

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
        : { tone: "info", text: "Einwilligung widerrufen. Deine Gesichtsdaten wurden gelöscht. Stempeln bitte telefonisch bei Tobias oder Dominik melden." },
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
    setMessage({ tone: "info", text: "Passwort geändert." });
  }

  return (
    <section className="stack">
      <h1>Konto</h1>
      {message && <p className={message.tone === "error" ? "form-error" : "notice notice-info"}>{message.text}</p>}

      <div className="card stack">
        <h2>Gesichtserkennung</h2>
        {consent === undefined && <p className="muted">Lädt …</p>}
        {consent === null && <p className="muted">Es sind keine Gesichtsdaten von dir gespeichert.</p>}
        {consent && (
          <>
            <p>
              Du hast am {new Date(consent.given_at).toLocaleDateString("de-DE", { timeZone: "Europe/Berlin" })} eingewilligt.
              Du kannst jederzeit ohne Nachteile widerrufen – deine Gesichtsdaten werden dann sofort gelöscht.
            </p>
            {!confirm ? (
              <button type="button" className="btn-danger" onClick={() => setConfirm(true)}>Einwilligung widerrufen</button>
            ) : (
              <button type="button" className="btn-danger" onClick={() => void revoke()}>
                Wirklich widerrufen und Gesichtsdaten löschen
              </button>
            )}
          </>
        )}
      </div>

      <form className="card form" onSubmit={changePassword}>
        <h2>Passwort ändern</h2>
        <label>Neues Passwort<input id="new-password" name="password" type="password" minLength={10} autoComplete="new-password" required /></label>
        <label>Wiederholen<input id="new-password2" name="password2" type="password" minLength={10} autoComplete="new-password" required /></label>
        <button type="submit" className="btn-primary">Speichern</button>
      </form>

      <button type="button" className="btn-ghost" onClick={props.onLogout}>Abmelden</button>
    </section>
  );
}
