// Tablet-Konten (nur Admin): anlegen mit Benutzername, sperren, Passwort neu setzen
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { accountAdmin, generatePassword } from "../lib/accountAdmin";
import { adminDb } from "../lib/supabase";
import type { Location } from "../lib/types";

type Tablet = { id: string; name: string; username: string | null; location_id: string | null; is_active: boolean };

export function Tablets() {
  const [tablets, setTablets] = useState<Tablet[]>([]);
  const [locations, setLocations] = useState<Location[]>([]);
  const [creating, setCreating] = useState(false);
  const [message, setMessage] = useState<{ tone: "info" | "error"; text: string }>();

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
      setMessage({ tone: "info", text: `Neues Passwort für „${t.name}“: ${password} – bitte notieren, es wird nicht erneut angezeigt.` });
    } catch (e) {
      setMessage({ tone: "error", text: (e as Error).message });
    }
  }

  const studio = (id: string | null) => (id ? locations.find((l) => l.id === id)?.name ?? "–" : "am Tablet wählbar");

  return (
    <section className="stack">
      <div className="row-between">
        <h1>Tablets</h1>
        {!creating && <button type="button" className="btn-primary" onClick={() => setCreating(true)}>Neues Tablet</button>}
      </div>
      {message && <p className={message.tone === "error" ? "form-error" : "notice notice-info"}>{message.text}</p>}
      {creating && (
        <NewTablet
          locations={locations}
          onCancel={() => setCreating(false)}
          onCreated={(text) => {
            setCreating(false);
            setMessage({ tone: "info", text });
            void load();
          }}
        />
      )}
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr><th>Name</th><th>Benutzername</th><th>Studio</th><th>Status</th><th /></tr>
          </thead>
          <tbody>
            {tablets.map((t) => (
              <tr key={t.id}>
                <td>{t.name}</td>
                <td><code>{t.username ?? "–"}</code></td>
                <td>{studio(t.location_id)}</td>
                <td>{t.is_active ? <span className="pill pill-ok">aktiv</span> : <span className="pill">gesperrt</span>}</td>
                <td className="right row-end">
                  <button type="button" className="btn-small" onClick={() => void resetPassword(t)}>Neues Passwort</button>
                  <button type="button" className="btn-small" onClick={() => void toggle(t)}>{t.is_active ? "Sperren" : "Freigeben"}</button>
                </td>
              </tr>
            ))}
            {tablets.length === 0 && (
              <tr><td colSpan={5} className="muted">Noch keine Tablets angelegt.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
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
    <form className="card form form-wide" onSubmit={submit}>
      <h2>Neues Tablet</h2>
      <div className="grid-2">
        <label>Name<input id="tablet-name" name="name" placeholder="z. B. Tablet Nord" required /></label>
        <label>
          Benutzername
          <input id="tablet-username" name="username" placeholder="z. B. nord" pattern="[a-z0-9][a-z0-9_\-]{2,30}" title="3–31 Zeichen: a–z, 0–9, - und _" autoCapitalize="none" required />
        </label>
        <label>
          Studio
          <select id="tablet-location" name="location" defaultValue="">
            <option value="">Am Tablet wählbar</option>
            {props.locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
        </label>
        <label>
          Passwort
          <div className="row">
            <input id="tablet-password" value={password} onChange={(e) => setPassword(e.target.value)} minLength={10} required />
            <button type="button" className="btn-small" onClick={() => setPassword(generatePassword())}>Neu</button>
          </div>
        </label>
      </div>
      {error && <p className="form-error">{error}</p>}
      <div className="row">
        <button type="submit" className="btn-primary" disabled={busy}>{busy ? "Legt an …" : "Anlegen"}</button>
        <button type="button" className="btn-ghost" onClick={props.onCancel}>Abbrechen</button>
      </div>
    </form>
  );
}
