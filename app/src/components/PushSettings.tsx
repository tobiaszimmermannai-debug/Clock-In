// Push-Nachrichten ein-/ausschalten (Konto) bzw. kurzer Hinweis (Mitteilungen)
import { useCallback, useEffect, useState } from "react";
import { disablePush, enablePush, pushState, type PushState } from "../lib/push";
import { portalDb } from "../lib/supabase";
import { LeadingIcon, Notice, Row, Section } from "./ui";

const TEXT: Record<PushState, string> = {
  on: "Eingeschaltet – Tausch, Dienstplan-Änderungen und Entscheidungen kommen direkt aufs Handy.",
  off: "Aus – Neuigkeiten siehst du nur, wenn du die App öffnest.",
  denied: "Im Handy blockiert – unter Einstellungen → Mitteilungen für Clock-In erlauben.",
  "ios-install": "iPhone: Erst die App auf den Home-Bildschirm legen (Teilen → „Zum Home-Bildschirm“), dann dort öffnen und Push einschalten.",
  unsupported: "Dieser Browser kann keine Push-Nachrichten.",
};

function usePush() {
  const [state, setState] = useState<PushState>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const refresh = useCallback(() => void pushState().then(setState).catch(() => setState("unsupported")), []);
  useEffect(refresh, [refresh]);
  const toggle = async (on: boolean) => {
    setBusy(true);
    setError(undefined);
    try {
      if (on) setError(await enablePush(portalDb));
      else await disablePush(portalDb);
    } catch (e) {
      setError(`Push konnte nicht geändert werden: ${(e as Error).message}`);
    }
    setBusy(false);
    refresh();
  };
  return { state, busy, error, toggle };
}

export function PushSettings() {
  const { state, busy, error, toggle } = usePush();
  if (!state) return null;
  return (
    <Section title="Push-Nachrichten">
      {error && <Notice tone="error">{error}</Notice>}
      <label className="list-row">
        <span className="list-row-main">
          <span className="list-row-title">Benachrichtigungen aufs Handy</span>
          <span className="list-row-sub">{TEXT[state]}</span>
        </span>
        {(state === "on" || state === "off") && (
          <input id="push-on" type="checkbox" role="switch" className="switch" checked={state === "on"} disabled={busy}
            onChange={(e) => void toggle(e.target.checked)} />
        )}
      </label>
    </Section>
  );
}

/** Hinweis oben in den Mitteilungen, solange Push aus ist (verschwindet nach dem Einschalten) */
export function PushHint() {
  const { state, busy, error, toggle } = usePush();
  if (state !== "off" && state !== "ios-install") return error ? <Notice tone="error">{error}</Notice> : null;
  return (
    <Section>
      {error && <Notice tone="error">{error}</Notice>}
      <Row leading={<LeadingIcon name="bell" />} title="Push-Nachrichten einschalten"
        subtitle={state === "off" ? "Damit du Tauschanfragen und Dienstplan-Änderungen sofort mitbekommst." : TEXT["ios-install"]}
        trailing={state === "off" ? <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => void toggle(true)}>Einschalten</button> : undefined} />
    </Section>
  );
}
