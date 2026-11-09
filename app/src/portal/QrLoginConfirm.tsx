// Studioleitung bestätigt am Handy die Anmeldung in der Verwaltung an einem anderen Gerät (QR-Code).
import { useState } from "react";
import { Icon, Notice } from "../components/ui";
import { dbMessage } from "../lib/errors";
import { existingPhoneKey } from "../lib/stamp";
import { portalDb } from "../lib/supabase";
import type { Me } from "./PortalApp";

export function QrLoginConfirm(props: { me: Me; token: string; onDone: () => void }) {
  const [state, setState] = useState<{ kind: "ask" | "busy" | "ok" } | { kind: "error"; text: string }>({ kind: "ask" });
  const isLead = props.me.role === "manager";

  async function confirm() {
    setState({ kind: "busy" });
    const { error } = await portalDb.rpc("qr_login_unlock", { p_token: props.token, p_phone_key: existingPhoneKey() ?? "" });
    if (error) return setState({ kind: "error", text: dbMessage(error) });
    setState({ kind: "ok" });
  }

  return (
    <div className="panel stamp-hero">
      <span className="stamp-hero-icon"><Icon name="monitor" size={34} /></span>
      <h2>Am PC anmelden</h2>
      {!isLead ? (
        <Notice tone="warn">Die Anmeldung per QR-Code ist für die Studioleitung.</Notice>
      ) : state.kind === "ok" ? (
        <Notice tone="ok">Bestätigt – am PC öffnet sich jetzt die Verwaltung (Dienstplan & Aufgaben).</Notice>
      ) : (
        <>
          <p className="muted">Meldet dich am anderen Gerät in der Verwaltung an. Nur bestätigen, wenn du selbst gerade davor sitzt.</p>
          {state.kind === "error" && <Notice tone="error">{state.text}</Notice>}
          <button type="button" className="btn btn-primary btn-block btn-lg" disabled={state.kind === "busy"} onClick={() => void confirm()}>
            Am PC anmelden
          </button>
        </>
      )}
      <button type="button" className="btn btn-plain btn-block" onClick={props.onDone}>Schließen</button>
    </div>
  );
}
