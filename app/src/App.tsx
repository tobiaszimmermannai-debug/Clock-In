import { useEffect, useState } from "react";
import { AdminApp, AuthLayout } from "./admin/AdminApp";
import { LeadingIcon, Row } from "./components/ui";
import { KioskApp } from "./kiosk/KioskApp";
import { parseToken } from "./lib/stamp";
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

// Routen: #/kiosk = Tablet, #/portal = Mitarbeiter-Handy, #/s/<code> = QR vom Tablet gescannt, #/admin = Verwaltung.
// Ohne Route (z. B. App vom Startbildschirm): eingerichtetes Tablet → Kiosk, angemeldetes Handy → Portal.
export default function App() {
  const hash = useHash();
  if (!isConfigured) {
    return (
      <div className="screen center">
        <p className="panel">Supabase ist nicht konfiguriert (VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY fehlen).</p>
      </div>
    );
  }
  if (hash.startsWith("#/admin")) return <AdminApp />;
  if (hash.startsWith("#/s/")) return <PortalApp stampToken={parseToken(hash) ?? undefined} />;
  if (hash.startsWith("#/portal")) return <PortalApp />;
  if (hash.startsWith("#/kiosk")) return <KioskApp />;
  if (hasSession(SESSION_KEYS.kiosk)) return <KioskApp />;
  if (hasSession(SESSION_KEYS.portal)) return <PortalApp />;
  return <Start />;
}

function Start() {
  const go = (hash: string) => () => (location.hash = hash);
  return (
    <AuthLayout title="Clock-In" text="Wie möchtest du die App nutzen?">
      <div className="list">
        <Row leading={<LeadingIcon name="phone" />} title="Mitarbeiter-Login" subtitle="Stempeln, Stunden, Dienstplan, Tausch" chevron onClick={go("#/portal")} />
        <Row leading={<LeadingIcon name="tablet" />} title="Tablet im Studio einrichten" subtitle="Zeigt den QR-Code zum Stempeln" chevron onClick={go("#/kiosk")} />
        <Row leading={<LeadingIcon name="shield" />} title="Verwaltung" subtitle="Studioleitung und Geschäftsführung" chevron onClick={go("#/admin")} />
      </div>
    </AuthLayout>
  );
}
