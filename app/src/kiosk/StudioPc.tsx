// Studio-PC: alle Mitarbeiter sehen und bearbeiten dort ihre Aufgaben ("Wer bist du?").
// Private Seiten erscheinen am PC nie. Der Stempel-QR bleibt bei Bedarf erreichbar.
// Dienstplan: alle Studios lesen; planen nach QR-Bestätigung der Studioleitung (siehe PcPlan).
import { useState } from "react";
import { Tasks } from "../components/Tasks";
import { BrandMark, Segmented } from "../components/ui";
import { kioskDb } from "../lib/supabase";
import { studioShort } from "../lib/types";
import { Kiosk, type KioskSession } from "./Kiosk";
import { PcPlan } from "./PcPlan";

export function StudioPc(props: { session: KioskSession; onReset: () => void }) {
  const [view, setView] = useState<"tasks" | "plan" | "qr">("tasks");
  return (
    <div className="studio-pc">
      <header className="studio-pc-bar">
        <span className="brand">
          <BrandMark />
          <span>
            Clock-In<span className="brand-sub">Studio-PC · {studioShort(props.session.location.name)}</span>
          </span>
        </span>
        <span className="spacer" />
        <Segmented
          label="Ansicht"
          value={view}
          onChange={setView}
          options={[
            { id: "tasks", label: "Aufgaben" },
            { id: "plan", label: "Dienstplan" },
            { id: "qr", label: "Stempel-QR" },
          ]}
        />
      </header>
      <div className="studio-pc-body">
        {/* Aufgaben bleiben eingehängt (Personenwahl „Wer bist du?“ läuft weiter) */}
        <div hidden={view !== "tasks"}><Tasks db={kioskDb} /></div>
        {view === "plan" && <PcPlan />}
        {view === "qr" && <Kiosk session={props.session} onReset={props.onReset} />}
      </div>
    </div>
  );
}
