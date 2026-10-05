import { useEffect, useState } from "react";
import { AdminApp } from "./admin/AdminApp";
import { KioskApp } from "./kiosk/KioskApp";
import { isConfigured } from "./lib/supabase";

function useHash() {
  const [hash, setHash] = useState(location.hash);
  useEffect(() => {
    const onChange = () => setHash(location.hash);
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return hash;
}

// Routen: #/ = Kiosk (Tablet), #/admin = Verwaltung. Später: #/portal = Mitarbeiter-Handy
export default function App() {
  const hash = useHash();
  if (!isConfigured) {
    return (
      <div className="screen center">
        <p className="card">Supabase ist nicht konfiguriert (VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY fehlen).</p>
      </div>
    );
  }
  return hash.startsWith("#/admin") ? <AdminApp /> : <KioskApp />;
}
