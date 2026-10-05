// Konto: Stempel-Handy, Passwort ändern, abmelden
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { Field, LeadingIcon, Notice, PageHeader, Pill, Row, Section } from "../components/ui";
import { existingPhoneKey, sha256Hex } from "../lib/stamp";
import { portalDb } from "../lib/supabase";
import type { Me } from "./PortalApp";

export function Account(props: { me: Me; onLogout: () => void }) {
  // null = kein Handy registriert; sonst Datum und ob es dieses Handy ist
  const [phone, setPhone] = useState<{ since: string; thisPhone: boolean } | null>();
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string }>();

  const loadPhone = useCallback(async () => {
    const { data } = await portalDb
      .from("stamp_phones")
      .select("key_hash, registered_at")
      .eq("user_id", props.me.id)
      .maybeSingle();
    if (!data) return setPhone(null);
    const key = existingPhoneKey();
    setPhone({ since: data.registered_at, thisPhone: !!key && (await sha256Hex(key)) === data.key_hash });
  }, [props.me.id]);

  useEffect(() => {
    void loadPhone();
  }, [loadPhone]);

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

      <Section title="Stempel-Handy" footer="Stempeln geht nur mit deinem registrierten Handy. Neues Handy? Bitte Tobias oder Dominik, es zurückzusetzen.">
        {phone === undefined && <p className="list-empty">Lädt …</p>}
        {phone === null && (
          <Row leading={<LeadingIcon name="phone" />} title="Noch nicht registriert" subtitle="Wird beim ersten Stempeln automatisch registriert" />
        )}
        {phone && (
          <Row
            leading={<LeadingIcon name="phone" />}
            title={phone.thisPhone ? "Dieses Handy" : "Ein anderes Handy"}
            subtitle={`registriert seit ${new Date(phone.since).toLocaleDateString("de-DE", { timeZone: "Europe/Berlin" })}`}
            trailing={phone.thisPhone ? <Pill tone="ok">aktiv</Pill> : <Pill tone="warn">nicht dieses</Pill>}
          />
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
