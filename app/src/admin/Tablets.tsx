// Tablet-Konten (nur Admin): anlegen mit Benutzername, sperren, Passwort neu setzen
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { Field, Icon, LeadingIcon, Notice, PageHeader, Pill, Row, Section, Sheet } from "../components/ui";
import { accountAdmin, generatePassword } from "../lib/accountAdmin";
import { adminDb } from "../lib/supabase";
import { type Location, studioShort } from "../lib/types";

type Tablet = { id: string; name: string; username: string | null; location_id: string | null; is_active: boolean };
type Seen = { last_seen_at: string; network: string | null };

// "vor 3 Min." – zuletzt online
function ago(iso: string): string {
  const min = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (min < 2) return "gerade online";
  if (min < 60) return `vor ${min} Min. online`;
  if (min < 48 * 60) return `vor ${Math.round(min / 60)} Std. online`;
  return `vor ${Math.round(min / 1440)} Tagen online`;
}

export function Tablets() {
  const [tablets, setTablets] = useState<Tablet[]>([]);
  const [locations, setLocations] = useState<Location[]>([]);
  const [seen, setSeen] = useState<Record<string, Seen>>({});
  const [creating, setCreating] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string }>();

  const load = useCallback(async () => {
    const [devices, locs, qr, nets] = await Promise.all([
      adminDb.from("kiosk_devices").select("id, name, username, location_id, is_active").order("name"),
      adminDb.from("locations").select("id, code, name").order("name"),
      adminDb.from("kiosk_qr").select("device_id, last_seen_at"),
      adminDb.from("kiosk_networks").select("device_id, network, last_seen_at").order("last_seen_at", { ascending: false }),
    ]);
    // Zuletzt gesehenes Netz je Tablet (öffentliche Adresse des Studio-WLANs)
    const map: Record<string, Seen> = {};
    for (const q of qr.data ?? []) map[q.device_id] = { last_seen_at: q.last_seen_at, network: null };
    for (const n of nets.data ?? []) if (map[n.device_id] && !map[n.device_id].network) map[n.device_id].network = n.network;
    setSeen(map);
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
      <Section footer="Am Tablet die App-Adresse öffnen und mit Benutzername + Passwort anmelden. „Netz“ ist die Internet-Adresse des Studio-WLANs – damit müssen auch die Handys verbunden sein.">
        {tablets.length === 0 && <p className="list-empty">Noch keine Tablets angelegt.</p>}
        {tablets.map((t) => (
          <div key={t.id} className="list-item">
            <Row
              leading={<LeadingIcon name="tablet" />}
              title={t.name}
              subtitle={
                <>
                  {studio(t.location_id)} · Benutzer <code>{t.username ?? "–"}</code>
                  <br />
                  {seen[t.id] ? <>{ago(seen[t.id].last_seen_at)}{seen[t.id].network && <> · Netz <code>{seen[t.id].network}</code></>}</> : "noch nie online"}
                </>
              }
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
