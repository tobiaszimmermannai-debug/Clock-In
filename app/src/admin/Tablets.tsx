// Tablets & PCs (nur Admin): anlegen, sperren, löschen, Passwort neu setzen – darunter die Studios.
// PCs fragen selbst an (Startseite → „PC im Studio als Terminal“); hier oder per Telegram „Ja, passt“.
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { Field, Icon, LeadingIcon, Notice, PageHeader, Pill, Row, Section, Sheet } from "../components/ui";
import { accountAdmin, generatePassword } from "../lib/accountAdmin";
import { dbMessage } from "../lib/errors";
import { adminDb } from "../lib/supabase";
import { type Location, studioShort } from "../lib/types";
import { StudiosSection } from "./Studios";

type Tablet = { id: string; name: string; username: string | null; location_id: string | null; is_active: boolean; kind?: string };
type TerminalRequest = { id: string; name: string; location_name: string; requested_by: string | null; created_at: string; status: string };
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
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string }>();
  const [requests, setRequests] = useState<TerminalRequest[]>([]);

  const load = useCallback(async () => {
    const [devices, locs, qr, nets, open] = await Promise.all([
      adminDb.from("kiosk_devices").select("*").is("archived_at", null).order("name"),
      adminDb.from("locations").select("id, code, name").eq("is_active", true).order("name"),
      adminDb.from("kiosk_qr").select("device_id, last_seen_at"),
      adminDb.from("kiosk_networks").select("device_id, network, last_seen_at").order("last_seen_at", { ascending: false }),
      adminDb.rpc("open_terminal_requests"),
    ]);
    setRequests((open.data ?? []) as TerminalRequest[]);
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

  // Ohne Stempelungen komplett löschen, sonst nur aus der Übersicht nehmen (Buchungen bleiben)
  async function remove(t: Tablet) {
    setConfirmDelete(null);
    const { data, error } = await adminDb.rpc("delete_tablet", { p_device_id: t.id });
    if (error) return setMessage({ tone: "error", text: error.message });
    setMessage({
      tone: "ok",
      text: data === "archived"
        ? `„${t.name}“ ist gesperrt und aus der Übersicht entfernt. Die Stempelungen daran bleiben als Nachweis gespeichert.`
        : `„${t.name}“ wurde gelöscht.`,
    });
    void load();
  }

  async function decide(r: TerminalRequest, approve: boolean) {
    const { error } = await adminDb.rpc("decide_terminal_request", { p_id: r.id, p_approve: approve });
    if (error) return setMessage({ tone: "error", text: error.message });
    setMessage({
      tone: "ok",
      text: approve
        ? `„${r.name}“ freigegeben – der PC startet gleich von selbst mit dem QR-Code für ${studioShort(r.location_name)}.`
        : `Anfrage „${r.name}“ abgelehnt.`,
    });
    void load();
    if (approve) setTimeout(() => void load(), 4000); // Konto legt die Telegram-Function an
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
        title="Einstellungen"
        subtitle="Tablets, PCs und Studios"
        actions={
          <button type="button" className="btn btn-primary" onClick={() => setCreating(true)}>
            <Icon name="plus" size={20} /> Neues Tablet
          </button>
        }
      />
      {message && <Notice tone={message.tone}>{message.text}</Notice>}
      {requests.length > 0 && (
        <Section title="PC-Anfragen" aside={<span>{requests.length}</span>}
          footer="Der PC zeigt nach der Freigabe den QR-Code wie das Tablet. Gestempelt wird nur mit dem eigenen Handy.">
          {requests.map((r) => (
            <div key={r.id} className="list-item">
              <Row
                leading={<LeadingIcon name="monitor" />}
                title={`${r.name} → ${studioShort(r.location_name)}`}
                subtitle={`angefragt von ${r.requested_by ?? "?"} · ${ago(r.created_at).replace(" online", "")}`}
                trailing={r.status === "approved" ? <Pill tone="accent">wird eingerichtet</Pill> : undefined}
              />
              {r.status === "pending" && (
                <div className="list-actions indent">
                  <button type="button" className="btn btn-primary btn-sm" onClick={() => void decide(r, true)}>Ja, passt</button>
                  <button type="button" className="btn btn-outline btn-sm" onClick={() => void decide(r, false)}>Nein</button>
                </div>
              )}
            </div>
          ))}
        </Section>
      )}
      <Section title="Tablets & PCs" footer="Am Tablet die App-Adresse öffnen und mit Benutzername + Passwort anmelden. „Netz“ ist die Internet-Adresse des Studio-WLANs – damit müssen auch die Handys verbunden sein.">
        {tablets.length === 0 && <p className="list-empty">Noch keine Tablets angelegt.</p>}
        {tablets.map((t) => (
          <div key={t.id} className="list-item">
            <Row
              leading={<LeadingIcon name={t.kind === "pc" ? "monitor" : "tablet"} />}
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
              <button type="button" className={t.is_active ? "btn btn-outline btn-sm" : "btn btn-secondary btn-sm"} onClick={() => void toggle(t)}>
                {t.is_active ? "Sperren" : "Freigeben"}
              </button>
              {confirmDelete === t.id ? (
                <>
                  <button type="button" className="btn btn-danger-solid btn-sm" onClick={() => void remove(t)}>Wirklich löschen</button>
                  <button type="button" className="btn btn-plain btn-sm" onClick={() => setConfirmDelete(null)}>Abbrechen</button>
                </>
              ) : (
                <button type="button" className="btn btn-danger btn-sm" onClick={() => setConfirmDelete(t.id)}>Löschen</button>
              )}
            </div>
          </div>
        ))}
      </Section>
      <LogoutDevices locations={locations} />

      <StudiosSection onChanged={() => void load()} />
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

// Alle Studio-Geräte (oder die eines Studios) abmelden – nichts wird gelöscht; Geräte fragen jede Minute nach
function LogoutDevices(props: { locations: Location[] }) {
  const [studio, setStudio] = useState("");
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ tone: "ok" | "error"; text: string }>();
  const target = studio ? `alle Geräte in ${studioShort(props.locations.find((l) => l.id === studio)?.name ?? "")}` : "alle Studio-Geräte";

  async function run() {
    setBusy(true);
    const { data, error } = await adminDb.rpc("kiosk_logout_all", { p_location: studio || null });
    setBusy(false);
    setConfirm(false);
    if (error) return setResult({ tone: "error", text: dbMessage(error) });
    const n = Number(data ?? 0);
    setResult({ tone: "ok", text: n === 0 ? "Keine aktiven Geräte gefunden." : `${n} ${n === 1 ? "Gerät wird" : "Geräte werden"} innerhalb von 1 Minute abgemeldet.` });
  }

  return (
    <Section title="Geräte abmelden" footer="Tablets und Studio-PCs melden sich innerhalb einer Minute ab und zeigen wieder die Anmeldung. Es wird nichts gelöscht; ein danach neu angemeldetes Gerät bleibt angemeldet.">
      <div className="logout-box">
        {result && <Notice tone={result.tone}>{result.text}</Notice>}
        <Field label="Welche Geräte?">
          <select id="logout-studio" value={studio} onChange={(e) => { setStudio(e.target.value); setConfirm(false); setResult(undefined); }}>
            <option value="">Alle Studios</option>
            {props.locations.map((l) => <option key={l.id} value={l.id}>{studioShort(l.name)}</option>)}
          </select>
        </Field>
        <div className="list-actions">
          {confirm ? (
            <>
              <span className="muted small">Wirklich {target} abmelden?</span>
              <button type="button" className="btn btn-outline btn-sm" onClick={() => setConfirm(false)} disabled={busy}>Nein</button>
              <button type="button" className="btn btn-danger btn-sm" onClick={() => void run()} disabled={busy}>Ja, abmelden</button>
            </>
          ) : (
            <button type="button" className="btn btn-danger btn-sm" onClick={() => setConfirm(true)}>
              {studio ? "Geräte dieses Studios abmelden" : "Alle Studio-Geräte abmelden"}
            </button>
          )}
        </div>
      </div>
    </Section>
  );
}
