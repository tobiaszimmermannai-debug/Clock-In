import { useEffect, useState } from "react";
import { AdminApp } from "./admin/AdminApp";
import { KioskApp } from "./kiosk/KioskApp";
import { isConfigured, SESSION_KEYS } from "./lib/supabase";
import { PortalApp } from "./portal/PortalApp";

function useHash() {
  const [hash, setHash] = useState(location.hash);
  useEffect(() => {
    const onChange = () => setHash(location.hash);
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return hash;
}

const hasSession = (key: string) => {
  try {
    return localStorage.getItem(key) !== null;
  } catch {
    return false;
  }
};

// Routen: #/kiosk = Tablet, #/portal = Mitarbeiter-Handy, #/admin = Verwaltung.
// Ohne Route (z. B. App vom Startbildschirm): eingerichtetes Tablet → Kiosk, angemeldetes Handy → Portal.
export default function App() {
  const hash = useHash();
  if (!isConfigured) {
    return (
      <div className="screen center">
        <p className="card">Supabase ist nicht konfiguriert (VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY fehlen).</p>
      </div>
    );
  }
  if (hash.startsWith("#/admin")) return <AdminApp />;
  if (hash.startsWith("#/portal")) return <PortalApp />;
  if (hash.startsWith("#/kiosk")) return <KioskApp />;
  if (hasSession(SESSION_KEYS.kiosk)) return <KioskApp />;
  if (hasSession(SESSION_KEYS.portal)) return <PortalApp />;
  return <Start />;
}

function Start() {
  return (
    <div className="screen setup">
      <div className="card form">
        <h1>Clock-In</h1>
        <p className="muted">Wie möchtest du die App nutzen?</p>
        <a className="btn-primary btn-block" href="#/portal">Mitarbeiter-Login (Handy)</a>
        <a className="btn-ghost btn-block" href="#/kiosk">Tablet im Studio einrichten</a>
        <a className="btn-ghost btn-block" href="#/admin">Verwaltung</a>
      </div>
    </div>
  );
}
