// Kiosk-Hauptansicht: Uhr, vier Aktionen, Gesichtserkennung, Ergebnis
import { useEffect, useRef, useState } from "react";
import { FaceScan } from "../components/FaceScan";
import type { Match } from "../lib/match";
import { relevantShift, shiftNotice, type Notice } from "../lib/shiftInfo";
import { validateAction } from "../lib/status";
import { fmtClock, fmtClockSec, fmtDate } from "../lib/time";
import { EVENT_LABEL, type EventType } from "../lib/types";
import { type KioskSession, useKiosk } from "./useKiosk";

const ACTIONS: EventType[] = ["clock_in", "break_start", "break_end", "clock_out"];

const GREETING: Record<EventType, (name: string) => string> = {
  clock_in: (n) => `Hallo ${n}!`,
  break_start: (n) => `Gute Pause, ${n}!`,
  break_end: (n) => `Willkommen zurück, ${n}!`,
  clock_out: (n) => `Schönen Feierabend, ${n}!`,
};

type Phase =
  | { kind: "idle" }
  | { kind: "scan"; action: EventType }
  | { kind: "done"; action: EventType; name: string; at: Date; notice: Notice | null; queued: boolean }
  | { kind: "error"; title: string; text: string };

export function Kiosk(props: { session: KioskSession; onReset: () => void }) {
  const kiosk = useKiosk(props.session);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const now = useNow();
  useWakeLock();

  // Ergebnis-Anzeigen schließen sich selbst
  useEffect(() => {
    if (phase.kind !== "done" && phase.kind !== "error") return;
    const ms = phase.kind === "done" && !phase.notice ? 4000 : 7000;
    const t = setTimeout(() => setPhase({ kind: "idle" }), ms);
    return () => clearTimeout(t);
  }, [phase]);

  function start(action: EventType) {
    if (kiosk.roster.length === 0) {
      return setPhase({
        kind: "error",
        title: "Noch keine Gesichter erfasst",
        text: "Die Studioleitung muss Mitarbeiter zuerst in der Verwaltung erfassen. Bis dahin: bitte Tobias oder Dominik anrufen.",
      });
    }
    setPhase({ kind: "scan", action });
  }

  async function onMatch(action: EventType, match: Match) {
    const at = new Date();
    const { state, since } = await kiosk.stateOf(match.entry.user_id, at);
    const problem = validateAction(state, since, action);
    if (problem) return setPhase({ kind: "error", title: `${match.entry.first_name}, Moment:`, text: problem });

    const notice = shiftNotice(action, relevantShift(kiosk.shifts, match.entry.user_id, at), at);
    await kiosk.book(match.entry.user_id, action, match.distance, at);
    setPhase({ kind: "done", action, name: match.entry.first_name, at, notice, queued: !kiosk.online });
  }

  return (
    <div className="screen kiosk">
      <header className="kiosk-bar">
        <StudioTitle name={props.session.location.name} />
        <SyncBadge online={kiosk.online} pending={kiosk.pending} failed={kiosk.failed} />
      </header>

      {phase.kind === "idle" && (
        <main className="kiosk-idle">
          <div className="clock">
            <time className="clock-time">{fmtClockSec(now)}</time>
            <span className="clock-date">{fmtDate(now)}</span>
          </div>
          <div className="actions">
            {ACTIONS.map((a) => (
              <button key={a} type="button" className={`action action-${a}`} onClick={() => start(a)}>
                {EVENT_LABEL[a]}
              </button>
            ))}
          </div>
        </main>
      )}

      {phase.kind === "scan" && (
        <main className="kiosk-scan">
          <h2 className={`scan-title action-${phase.action}`}>{EVENT_LABEL[phase.action]}</h2>
          <FaceScan
            roster={kiosk.roster}
            onMatch={(m) => void onMatch(phase.action, m)}
            onTimeout={() =>
              setPhase({
                kind: "error",
                title: "Nicht erkannt",
                text: "Bitte noch einmal versuchen. Gutes Licht und direkter Blick in die Kamera helfen. Ohne Gesichtserkennung: bitte Tobias oder Dominik anrufen.",
              })
            }
          />
          <button type="button" className="btn-ghost" onClick={() => setPhase({ kind: "idle" })}>
            Abbrechen
          </button>
        </main>
      )}

      {phase.kind === "done" && (
        <main className="kiosk-result" onClick={() => setPhase({ kind: "idle" })}>
          <div className={`result-icon action-${phase.action}`} aria-hidden="true">✓</div>
          <h2>{GREETING[phase.action](phase.name)}</h2>
          <p className="result-line">
            {EVENT_LABEL[phase.action]} · {fmtClock(phase.at)} Uhr
          </p>
          {phase.notice && <p className={`notice notice-${phase.notice.tone}`}>{phase.notice.text}</p>}
          {phase.queued && <p className="muted">Offline gespeichert – wird automatisch nachgesendet.</p>}
        </main>
      )}

      {phase.kind === "error" && (
        <main className="kiosk-result" onClick={() => setPhase({ kind: "idle" })}>
          <div className="result-icon is-error" aria-hidden="true">!</div>
          <h2>{phase.title}</h2>
          <p className="result-line">{phase.text}</p>
          <p className="muted">Zum Schließen tippen</p>
        </main>
      )}

      {phase.kind === "idle" && kiosk.failed > 0 && (
        <footer className="kiosk-foot">
          {kiosk.failed} Buchung(en) wurden vom Server abgelehnt – bitte Leitung informieren.
        </footer>
      )}
      <ResetHint onReset={props.onReset} fixed={props.session.device.location_id !== null} />
    </div>
  );
}

// Langes Drücken (2 s) auf den Studionamen öffnet die Verwaltung
function StudioTitle({ name }: { name: string }) {
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const start = () => {
    timer.current = setTimeout(() => (location.hash = "#/admin"), 2000);
  };
  const cancel = () => clearTimeout(timer.current);
  return (
    <h1
      className="studio-name"
      onPointerDown={start}
      onPointerUp={cancel}
      onPointerLeave={cancel}
      onContextMenu={(e) => e.preventDefault()}
    >
      {name}
    </h1>
  );
}

function SyncBadge(props: { online: boolean; pending: number; failed: number }) {
  if (!props.online) {
    return <span className="badge badge-off">Offline{props.pending ? ` · ${props.pending} wartend` : ""}</span>;
  }
  if (props.pending) return <span className="badge badge-busy">Sendet {props.pending} …</span>;
  return <span className="badge badge-on">Online</span>;
}

// Studio-Wechsel nur bei Tablets ohne festen Standort (verstecktes Feld unten rechts, 2 s halten)
function ResetHint(props: { onReset: () => void; fixed: boolean }) {
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  if (props.fixed) return null;
  return (
    <span
      className="reset-hotspot"
      aria-hidden="true"
      onPointerDown={() => (timer.current = setTimeout(props.onReset, 2000))}
      onPointerUp={() => clearTimeout(timer.current)}
      onPointerLeave={() => clearTimeout(timer.current)}
    />
  );
}

function useNow() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  return now;
}

// Bildschirm bleibt an, solange der Kiosk sichtbar ist
function useWakeLock() {
  useEffect(() => {
    let lock: WakeLockSentinel | null = null;
    const request = async () => {
      try {
        lock = (await navigator.wakeLock?.request("screen")) ?? null;
      } catch {
        // nicht unterstützt oder abgelehnt – Kiosk funktioniert trotzdem
      }
    };
    const onVisible = () => document.visibilityState === "visible" && void request();
    void request();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      void lock?.release();
    };
  }, []);
}
