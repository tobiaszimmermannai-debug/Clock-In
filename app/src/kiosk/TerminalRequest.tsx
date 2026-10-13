// PC als Terminal einrichten: mit dem eigenen Clock-In-Zugang anmelden, Studio wählen, anfragen.
// Tobias/Dominik sagen „Ja, passt“ (Telegram oder Einstellungen) → der PC meldet sich selbst als Terminal an.
// Die persönliche Anmeldung wird direkt nach der Anfrage beendet – am PC bleibt keine Mitarbeiter-Sitzung.
import { type FormEvent, useEffect, useRef, useState } from "react";
import { AuthLayout } from "../admin/AdminApp";
import { Field, Notice } from "../components/ui";
import { kioskLoginEmail, staffLoginEmail } from "../lib/config";
import { clearAll } from "../lib/db";
import { kioskDb, tempClient } from "../lib/supabase";
import { type Location, studioShort } from "../lib/types";

const STORE = "clockin-terminal-request";
const POLL_MS = 5000;
export type StoredRequest = { id: string; secret: string; studio: string };

export function storedRequest(): StoredRequest | null {
  try {
    return JSON.parse(localStorage.getItem(STORE) ?? "null") as StoredRequest | null;
  } catch {
    return null;
  }
}
const forget = () => {
  try {
    localStorage.removeItem(STORE);
  } catch { /* egal */ }
};

function newSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Schritt 1+2: anmelden, Studio wählen, anfragen */
export function TerminalRequest(props: { onRequested: () => void; onCancel: () => void }) {
  const [db] = useState(tempClient);
  const [locations, setLocations] = useState<Location[] | null>(null);
  const [studio, setStudio] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  async function login(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true);
    setError(undefined);
    const { error } = await db.auth.signInWithPassword({
      email: staffLoginEmail(String(f.get("username"))),
      password: String(f.get("password")),
    });
    if (error) {
      setBusy(false);
      return setError("Anmeldung fehlgeschlagen. Benutzername und Passwort prüfen.");
    }
    const { data } = await db.from("locations").select("id, code, name").eq("is_active", true).order("name");
    setBusy(false);
    setLocations((data ?? []) as Location[]);
  }

  async function request() {
    const location = locations?.find((l) => l.id === studio);
    if (!location) return;
    setBusy(true);
    setError(undefined);
    const secret = newSecret();
    const { data, error } = await db.rpc("request_terminal", {
      p_name: name.trim() || `PC ${studioShort(location.name)}`,
      p_location_id: location.id,
      p_secret: secret,
    });
    await db.auth.signOut(); // persönliche Sitzung sofort beenden
    setBusy(false);
    if (error || !data) return setError(error?.message ?? "Anfrage fehlgeschlagen.");
    localStorage.setItem(STORE, JSON.stringify({ id: data as string, secret, studio: studioShort(location.name) }));
    props.onRequested();
  }

  if (!locations) {
    return (
      <AuthLayout title="PC als Terminal einrichten" text="Mit deinem eigenen Clock-In-Zugang anmelden – nur für die Anfrage, danach wirst du hier sofort abgemeldet.">
        <form className="panel form" onSubmit={login}>
          <Field label="Benutzername">
            <input id="terminal-username" name="username" autoComplete="off" autoCapitalize="none" spellCheck={false} required />
          </Field>
          <Field label="Passwort">
            <input id="terminal-password" name="password" type="password" autoComplete="off" required />
          </Field>
          {error && <Notice tone="error">{error}</Notice>}
          <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? "Anmelden …" : "Weiter"}</button>
        </form>
        <p className="auth-foot"><button type="button" className="btn btn-plain" onClick={props.onCancel}>Zurück</button></p>
      </AuthLayout>
    );
  }

  return (
    <div className="auth">
      <div className="auth-head">
        <h1>Für welches Studio?</h1>
        <p>Der PC zeigt danach den QR-Code wie das Tablet – gestempelt wird mit dem eigenen Handy.</p>
      </div>
      <div className="studio-grid">
        {locations.map((l) => (
          <button key={l.id} type="button" className={`studio-btn${studio === l.id ? " is-selected" : ""}`}
            aria-pressed={studio === l.id} onClick={() => setStudio(l.id)}>
            {studioShort(l.name)}
          </button>
        ))}
      </div>
      <div className="panel form terminal-form">
        <Field label="Name des PCs (optional)">
          <input id="terminal-name" value={name} maxLength={40} placeholder="z. B. PC Empfang" onChange={(e) => setName(e.target.value)} />
        </Field>
        {error && <Notice tone="error">{error}</Notice>}
        <button type="button" className="btn btn-primary" disabled={!studio || busy} onClick={() => void request()}>
          {busy ? "Sendet …" : "Freigabe anfragen"}
        </button>
      </div>
    </div>
  );
}

/** Schritt 3: warten auf „Ja, passt“ – dann als Terminal anmelden */
export function TerminalWait(props: { request: StoredRequest; onReady: () => void; onRestart: () => void }) {
  const [status, setStatus] = useState<string>("pending");
  const [error, setError] = useState<string>();
  const done = useRef(props);
  done.current = props;
  const { id, secret } = props.request;

  useEffect(() => {
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      const { data, error } = await kioskDb.rpc("terminal_request_status", { p_id: id, p_secret: secret });
      if (stop) return;
      const r = data as { status: string; username: string | null } | null;
      if (error) setError("Keine Verbindung – versuche es weiter …");
      else if (!r) { forget(); return done.current.onRestart(); }
      else {
        setError(undefined);
        setStatus(r.status);
        if (r.status === "ready" && r.username) {
          const login = await kioskDb.auth.signInWithPassword({ email: kioskLoginEmail(r.username), password: secret });
          if (!login.error) {
            forget();
            await clearAll();
            return done.current.onReady();
          }
          setError("Anmeldung als Terminal fehlgeschlagen – versuche es weiter …");
        }
        if (r.status === "rejected") return;
      }
      timer = setTimeout(tick, POLL_MS);
    };
    void tick();
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [id, secret]);

  return (
    <AuthLayout
      title={status === "rejected" ? "Anfrage abgelehnt" : "Warte auf Freigabe …"}
      text={status === "rejected"
        ? "Tobias oder Dominik haben die Anfrage abgelehnt."
        : `PC als Terminal für ${props.request.studio}. Tobias oder Dominik geben per Telegram frei – danach startet der QR-Code hier automatisch.`}
    >
      {error && <Notice tone="warn">{error}</Notice>}
      {status !== "rejected" && <div className="terminal-wait" aria-hidden="true" />}
      <p className="auth-foot">
        <button type="button" className="btn btn-plain" onClick={() => { forget(); props.onRestart(); }}>
          {status === "rejected" ? "Neu anfragen" : "Anfrage abbrechen"}
        </button>
      </p>
    </AuthLayout>
  );
}
