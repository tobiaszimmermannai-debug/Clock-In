// Tablet-Einrichtung: Kiosk-Konto anmelden, Gerät prüfen, Studio wählen
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { clearAll, getCache, setCache } from "../lib/db";
import { kioskDb } from "../lib/supabase";
import type { KioskDevice, Location } from "../lib/types";
import { Kiosk } from "./Kiosk";
import type { KioskSession } from "./useKiosk";

type Phase =
  | { kind: "loading" }
  | { kind: "login"; error?: string }
  | { kind: "pick-location"; device: KioskDevice; locations: Location[] }
  | { kind: "ready"; session: KioskSession };

export function KioskApp() {
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });

  const resolve = useCallback(async () => {
    const { data } = await kioskDb.auth.getSession();
    if (!data.session) return setPhase({ kind: "login" });

    // Gerät & Studios: online frisch laden, offline aus dem Cache
    let device = await getCache<KioskDevice>("device");
    let locations = (await getCache<Location[]>("locations")) ?? [];
    const remote = await kioskDb
      .from("kiosk_devices")
      .select("id, name, location_id")
      .eq("auth_user_id", data.session.user.id)
      .maybeSingle();
    if (!remote.error) {
      if (!remote.data) {
        await kioskDb.auth.signOut();
        return setPhase({ kind: "login", error: "Dieses Konto ist kein registriertes Kiosk-Tablet." });
      }
      device = remote.data as KioskDevice;
      await setCache("device", device);
    }
    const locs = await kioskDb.from("locations").select("id, code, name").eq("is_active", true).order("name");
    if (!locs.error) {
      locations = locs.data as Location[];
      await setCache("locations", locations);
    }
    if (!device) return setPhase({ kind: "login", error: "Keine Verbindung. Bitte Internet prüfen." });

    const locationId = device.location_id ?? (await getCache<string>("locationId"));
    const location = locations.find((l) => l.id === locationId);
    if (!location) return setPhase({ kind: "pick-location", device, locations });
    setPhase({ kind: "ready", session: { device, location } });
  }, []);

  useEffect(() => {
    void resolve();
  }, [resolve]);

  if (phase.kind === "loading") return <div className="screen center muted">Lädt …</div>;
  if (phase.kind === "login") return <KioskLogin error={phase.error} onDone={resolve} />;
  if (phase.kind === "pick-location") {
    return (
      <div className="screen setup">
        <h1>Welches Studio?</h1>
        <p className="muted">Tablet „{phase.device.name}“ – Auswahl bleibt gespeichert.</p>
        <div className="studio-grid">
          {phase.locations.map((l) => (
            <button
              key={l.id}
              type="button"
              className="studio-btn"
              onClick={async () => {
                await setCache("locationId", l.id);
                void resolve();
              }}
            >
              {l.name}
            </button>
          ))}
        </div>
      </div>
    );
  }
  return (
    <Kiosk
      session={phase.session}
      onReset={async () => {
        await setCache("locationId", undefined);
        void resolve();
      }}
    />
  );
}

function KioskLogin(props: { error?: string; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(props.error);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setBusy(true);
    setError(undefined);
    const { error } = await kioskDb.auth.signInWithPassword({
      email: String(form.get("email")).trim(),
      password: String(form.get("password")),
    });
    setBusy(false);
    if (error) return setError("Anmeldung fehlgeschlagen. E-Mail und Passwort des Tablet-Kontos prüfen.");
    await clearAll();
    props.onDone();
  }

  return (
    <div className="screen setup">
      <form className="card form" onSubmit={submit}>
        <h1>Tablet einrichten</h1>
        <p className="muted">Mit dem Kiosk-Konto dieses Tablets anmelden. Das ist nur einmal nötig.</p>
        <label>
          E-Mail des Tablet-Kontos
          <input id="kiosk-email" name="email" type="email" autoComplete="username" required />
        </label>
        <label>
          Passwort
          <input id="kiosk-password" name="password" type="password" autoComplete="current-password" required />
        </label>
        {error && <p className="form-error">{error}</p>}
        <button type="submit" className="btn-primary" disabled={busy}>
          {busy ? "Anmelden …" : "Anmelden"}
        </button>
        <a className="link" href="#/admin">Zur Verwaltung (Leitung/Admin)</a>
      </form>
    </div>
  );
}
