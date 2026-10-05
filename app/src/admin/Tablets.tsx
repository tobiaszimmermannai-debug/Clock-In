// Tablet-Konten (nur Admin): anlegen mit Benutzername, sperren, Passwort neu setzen
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { Field, Icon, LeadingIcon, Notice, PageHeader, Pill, Row, Section, Sheet } from "../components/ui";
import { accountAdmin, generatePassword } from "../lib/accountAdmin";
import { adminDb } from "../lib/supabase";
import { type Location, studioShort } from "../lib/types";

type Tablet = { id: string; name: string; username: string | null; location_id: string | null; is_active: boolean };

export function Tablets() {
  const [tablets, setTablets] = useState<Tablet[]>([]);
  const [locations, setLocations] = useState<Location[]>([]);
  const [creating, setCreating] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string }>();

  const load = useCallback(async () => {
    const [devices, locs] = await Promise.all([
      adminDb.from("kiosk_devices").select("id, name, username, location_id, is_active").order("name"),
      adminDb.from("locations").select("id, code, name").order("name"),
    ]);
    if (devices.error) setMessage({ tone: "error", text: devices.error.message });
    setTablets((devices.data ?? []) as Tablet[]);
    setLocations((locs.data ?? []) as Location[]);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function toggle(t: Tablet) {
    const { error } = await adminDb.from("kiosk_devices").update({ is_active: !t.is_active }).eq("id", t.id);
    if (error) return setMessage({ tone: "error", text: error.message });
    void load();
  }

  async function resetPassword(t: Tablet) {
    const password = generatePassword();
    try {
      await accountAdmin({ action: "set_tablet_password", device_id: t.id, password });
      setMessage({ tone: "ok", text: `Neues Passwort für „${t.name}“: ${password} – bitte notieren, es wird nicht erneut angezeigt.` });
    } catch (e) {
      setMessage({ tone: "error", text: (e as Error).message });
    }
  }

  const studio = (id: string | null) => (id ? studioShort(locations.find((l) => l.id === id)?.name ?? "–") : "Studio am Tablet wählbar");

  return (
    <>
      <PageHeader
        title="Tablets"
        actions={
          <button type="button" className="btn btn-primary" onClick={() => setCreating(true)}>
            <Icon name="plus" size={20} /> Neues Tablet
          </button>
        }
      />
      {message && <Notice tone={message.tone}>{message.text}</Notice>}
      <Section footer="Am Tablet die App-Adresse öffnen und mit Benutzername + Passwort anmelden.">
        {tablets.length === 0 && <p className="list-empty">Noch keine Tablets angelegt.</p>}
        {tablets.map((t) => (
          <div key={t.id} className="list-item">
            <Row
              leading={<LeadingIcon name="tablet" />}
              title={t.name}
              subtitle={<>{studio(t.location_id)} · Benutzer <code>{t.username ?? "–"}</code></>}
              trailing={t.is_active ? <Pill tone="ok">aktiv</Pill> : <Pill tone="bad">gesperrt</Pill>}
            />
            <div className="list-actions indent">
              <button type="button" className="btn btn-outline btn-sm" onClick={() => void resetPassword(t)}>Neues Passwort</button>
              <button type="button" className={t.is_active ? "btn btn-danger btn-sm" : "btn btn-secondary btn-sm"} onClick={() => void toggle(t)}>
                {t.is_active ? "Sperren" : "Freigeben"}
              </button>
            </div>
          </div>
        ))}
      </Section>
      {creating && (
        <NewTablet
          locations={locations}
          onCancel={() => setCreating(false)}
          onCreated={(text) => {
            setCreating(false);
            setMessage({ tone: "ok", text });
            void load();
          }}
        />
      )}
    </>
  );
}

function NewTablet(props: { locations: Location[]; onCancel: () => void; onCreated: (text: string) => void }) {
  const [password, setPassword] = useState(() => generatePassword());
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const username = String(f.get("username")).trim().toLowerCase();
    setBusy(true);
    setError(undefined);
    try {
      await accountAdmin({
        action: "create_tablet",
        username,
        password,
        name: String(f.get("name")).trim(),
        location_id: String(f.get("location")) || null,
      });
      props.onCreated(`Tablet angelegt. Anmeldung am Tablet: Benutzername „${username}“, Passwort ${password} – bitte notieren.`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet
      title="Neues Tablet"
      onClose={props.onCancel}
      footer={<button type="submit" form="new-tablet" className="btn btn-primary" disabled={busy}>{busy ? "Legt an …" : "Anlegen"}</button>}
    >
      <form id="new-tablet" className="form" onSubmit={submit}>
        <Field label="Name"><input id="tablet-name" name="name" placeholder="z. B. Tablet Krailling" required /></Field>
        <Field label="Benutzername" hint="3–31 Zeichen: a–z, 0–9, - und _">
          <input id="tablet-username" name="username" placeholder="z. B. krailling" pattern="[a-z0-9][a-z0-9_\-]{2,30}" autoCapitalize="none" spellCheck={false} required />
        </Field>
        <Field label="Studio">
          <select id="tablet-location" name="location" defaultValue="">
            <option value="">Am Tablet wählbar</option>
            {props.locations.map((l) => <option key={l.id} value={l.id}>{studioShort(l.name)}</option>)}
          </select>
        </Field>
        <Field label="Passwort">
          <div className="input-row">
            <input id="tablet-password" value={password} onChange={(e) => setPassword(e.target.value)} minLength={10} required />
            <button type="button" className="btn btn-outline" onClick={() => setPassword(generatePassword())}>Neu</button>
          </div>
        </Field>
        {error && <Notice tone="error">{error}</Notice>}
      </form>
    </Sheet>
  );
}
