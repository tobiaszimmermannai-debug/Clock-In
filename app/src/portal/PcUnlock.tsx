// Studioleitung bestätigt am Handy den QR-Code am Studio-PC → dort ist die Schichtplanung freigeschaltet.
// Der Server prüft: aktive Studioleitung, eigenes registriertes Stempel-Handy, Code höchstens 2 Min. alt.
import { useState } from "react";
import { Icon, Notice } from "../components/ui";
import { dbMessage } from "../lib/errors";
import { existingPhoneKey } from "../lib/stamp";
import { portalDb } from "../lib/supabase";
import type { Me } from "./PortalApp";

/** QR-Inhalt „https://…/#/pc/<code>“ → Code */
export function parsePcToken(text: string): string | null {
  const m = text.trim().match(/#\/pc\/([0-9a-f]{32})\/?$/i);
  return m ? m[1].toLowerCase() : null;
}

export function PcUnlock(props: { me: Me; token: string; onDone: () => void }) {
  const [state, setState] = useState<{ kind: "ask" | "busy" } | { kind: "ok"; studio: string } | { kind: "error"; text: string }>({ kind: "ask" });
  const isLead = props.me.role === "manager";

  async function confirm() {
    setState({ kind: "busy" });
    const { data, error } = await portalDb.rpc("pc_plan_unlock", { p_token: props.token, p_phone_key: existingPhoneKey() ?? "" });
    if (error) return setState({ kind: "error", text: dbMessage(error) });
    setState({ kind: "ok", studio: String((data as { studio?: string } | null)?.studio ?? "") });
  }

  return (
    <div className="panel stamp-hero">
      <span className="stamp-hero-icon"><Icon name="calendar" size={34} /></span>
      <h2>Schichtplanung am Studio-PC</h2>
      {!isLead ? (
        <Notice tone="warn">Nur eine Studioleitung kann die Schichtplanung am PC freigeben.</Notice>
      ) : state.kind === "ok" ? (
        <Notice tone="ok">Freigegeben{state.studio ? ` – ${state.studio}` : ""}. Am PC kannst du jetzt dein Studio planen.</Notice>
      ) : (
        <>
          <p className="muted">Gibt die Planung am PC für dich frei – nur für dein Studio, sie sperrt nach 5 Minuten ohne Bedienung.</p>
          {state.kind === "error" && <Notice tone="error">{state.text}</Notice>}
          <button type="button" className="btn btn-primary btn-block btn-lg" disabled={state.kind === "busy"} onClick={() => void confirm()}>
            Planung freigeben
          </button>
        </>
      )}
      <button type="button" className="btn btn-plain btn-block" onClick={props.onDone}>Schließen</button>
    </div>
  );
}
