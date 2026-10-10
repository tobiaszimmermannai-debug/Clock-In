// Tablet im Studio: Uhr + QR-Code (wechselt alle 30 Sek.). Mitarbeiter scannen ihn mit dem
// eigenen Handy und stempeln dort; das Tablet zeigt danach die Begrüßung –
// beim pünktlichen Gehen (spätestens zum Schichtende) 3 Sekunden das „Good Job“-Bild.
import { useEffect, useRef, useState } from "react";
import { ACTION_ICON, GREETING } from "../components/actions";
import { QrCode } from "../components/QrCode";
import { Icon } from "../components/ui";
import { stampUrl } from "../lib/stamp";
import { kioskDb } from "../lib/supabase";
import { fmtClock, fmtClockSec, fmtDate } from "../lib/time";
import { EVENT_LABEL, type EventType, type KioskDevice, type Location, studioShort } from "../lib/types";

export type KioskSession = { device: KioskDevice; location: Location };

type Ping = {
  token: string;
  now: string;
  recent: { first_name: string; event_type: EventType; recorded_at: string; on_time?: boolean }[];
};
type Greeting = Ping["recent"][number];

const PING_MS = 4000;
const GOOD_JOB_MS = 3000;
const GOOD_JOB_SRC = `${import.meta.env.BASE_URL}good-job.webp`;

export function Kiosk(props: { session: KioskSession; onReset: () => void }) {
  const now = useNow();
  const [token, setToken] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [greeting, setGreeting] = useState<Greeting | null>(null);
  const since = useRef<string | null>(null);
  const locationId = props.session.location.id;
  useWakeLock();

  // Alle paar Sekunden beim Server melden: QR-Code holen, Netz bestätigen, neue Buchungen anzeigen
  useEffect(() => {
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      const { data, error } = await kioskDb.rpc("kiosk_ping", { p_location_id: locationId, p_since: since.current });
      if (stop) return;
      if (error || !data) {
        setProblem(error?.message && !/fetch|network/i.test(error.message) ? error.message : "Keine Internetverbindung.");
      } else {
        const ping = data as Ping;
        setProblem(null);
        setToken(ping.token);
        if (since.current && ping.recent.length) setGreeting(ping.recent[ping.recent.length - 1]);
        since.current = ping.now;
      }
      timer = setTimeout(tick, PING_MS);
    };
    void tick();
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [locationId]);

  useEffect(() => {
    if (!greeting) return;
    const t = setTimeout(() => setGreeting(null), greeting.on_time ? GOOD_JOB_MS : 6000);
    return () => clearTimeout(t);
  }, [greeting]);

  return (
    <div className="screen kiosk">
      <header className="kiosk-bar">
        <StudioTitle name={studioShort(props.session.location.name)} />
        {problem ? <span className="badge badge-off">Offline</span> : <span className="badge badge-on">Online</span>}
      </header>

      <main className="kiosk-main">
        <div className="clock">
          <time className="clock-time">{fmtClockSec(now)}</time>
          <span className="clock-date">{fmtDate(now)}</span>
        </div>

        <section className="kiosk-qr" aria-live="polite">
          {problem ? (
            <div className="kiosk-qr-off">
              <Icon name="wifi" size={48} />
              <strong>Stempeln gerade nicht möglich</strong>
              <span>{problem} Bitte Tobias oder Dominik anrufen.</span>
            </div>
          ) : token ? (
            <QrCode text={stampUrl(token)} label="QR-Code zum Stempeln" />
          ) : (
            <div className="kiosk-qr-off"><span>Lädt …</span></div>
          )}
          <div className="kiosk-steps">
            <strong>Mit dem Handy stempeln</strong>
            <ol>
              <li>Mit dem Studio-WLAN verbinden</li>
              <li>Clock-In öffnen → <b>Stempeln</b> → Code scannen</li>
              <li>Kommen, Pause oder Gehen wählen</li>
            </ol>
          </div>
        </section>
      </main>

      {greeting?.on_time ? (
        <div className="kiosk-goodboy" onClick={() => setGreeting(null)}>
          <img src={GOOD_JOB_SRC} alt="Good Job – You Rock!" />
          <p>{GREETING.clock_out(greeting.first_name)} · {fmtClock(greeting.recorded_at)} Uhr</p>
        </div>
      ) : greeting && (
        <div className="kiosk-greeting" onClick={() => setGreeting(null)}>
          <span className={`result-icon action-${greeting.event_type}`} aria-hidden="true">
            <Icon name={ACTION_ICON[greeting.event_type]} stroke={2.4} />
          </span>
          <h2>{GREETING[greeting.event_type](greeting.first_name)}</h2>
          <p className="result-line">{EVENT_LABEL[greeting.event_type]} · {fmtClock(greeting.recorded_at)} Uhr</p>
        </div>
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
