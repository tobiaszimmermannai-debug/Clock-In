// Tablet im Studio: Uhr + QR-Code (wechselt alle 30–45 Sek.). Mitarbeiter scannen ihn mit dem
// eigenen Handy und stempeln dort; das Tablet zeigt danach die Begrüßung –
// beim pünktlichen Gehen (spätestens zum Schichtende) 3 Sekunden das „Good Job“-Bild.
//
// Takt (weniger Abfragen/Logs): offen alle 15 Sek., nachts und bei verstecktem Bildschirm alle 60 Sek.
// Nach einem Scan (meldet der Server) kurz alle 2 Sek., damit die Begrüßung sofort erscheint.
// Der QR-Code bleibt dabei gültig: er wechselt beim ersten Ping nach 30 Sek., gilt 90 Sek. und
// danach noch 30 Sek. als „vorheriger Code“ – bei 15 bzw. 60 Sek. Takt bleibt nach dem Scan immer ≥ 30 Sek. Zeit.
import { useEffect, useRef, useState } from "react";
import { ACTION_ICON, GREETING } from "../components/actions";
import { QrCode } from "../components/QrCode";
import { Icon } from "../components/ui";
import { stampUrl } from "../lib/stamp";
import { kioskDb } from "../lib/supabase";
import { berlinHour } from "../lib/visibility";
import { fmtClock, fmtClockSec, fmtDate } from "../lib/time";
import { EVENT_LABEL, type EventType, type KioskDevice, type Location, studioShort } from "../lib/types";

export type KioskSession = { device: KioskDevice; location: Location };

type Ping = {
  token: string;
  now: string;
  recent: { first_name: string; event_type: EventType; recorded_at: string; on_time?: boolean }[];
  scanned_at?: string | null; // letzter Scan dieses Tablet-Codes (Handy)
};
type Greeting = Ping["recent"][number];

const PING_MS = 15_000;
const IDLE_MS = 60_000; // nachts und bei verstecktem Bildschirm
const BURST_MS = 2_000; // kurz nach einem Scan – Begrüßung ohne Verzögerung
const BURST_FOR_MS = 60_000;
const OPEN_FROM = 5; // Berliner Stunde, ab der im normalen Takt gepingt wird
const OPEN_TO = 23; // … bis vor dieser Stunde
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

  // Regelmäßig beim Server melden: QR-Code holen, Netz bestätigen, neue Buchungen anzeigen
  useEffect(() => {
    let stop = false;
    let busy = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let burstUntil = 0;
    let lastScan: string | null = null;
    const delay = () => {
      const hour = berlinHour();
      if (document.visibilityState !== "visible" || hour < OPEN_FROM || hour >= OPEN_TO) return IDLE_MS;
      return Date.now() < burstUntil ? BURST_MS : PING_MS;
    };
    const tick = async () => {
      clearTimeout(timer);
      if (busy) return; // Antwort steht noch aus – die plant den nächsten Ping
      busy = true;
      const { data, error } = await kioskDb.rpc("kiosk_ping", { p_location_id: locationId, p_since: since.current });
      busy = false;
      if (stop) return;
      if (error || !data) {
        setProblem(error?.message && !/fetch|network/i.test(error.message) ? error.message : "Keine Internetverbindung.");
      } else {
        const ping = data as Ping;
        setProblem(null);
        setToken(ping.token);
        const last = ping.recent[ping.recent.length - 1];
        if (since.current && last) {
          setGreeting(last);
          burstUntil = 0;
        }
        // Neuer Scan, der noch zu keiner Buchung geführt hat → kurz schneller nachfragen
        const scan = ping.scanned_at ?? null;
        if (scan && scan !== lastScan && Date.parse(ping.now) - Date.parse(scan) < BURST_FOR_MS
            && (!last || scan > last.recorded_at)) {
          burstUntil = Date.now() + BURST_FOR_MS;
        }
        lastScan = scan;
        since.current = ping.now;
      }
      timer = setTimeout(tick, delay());
    };
    // Bildschirm wieder an → sofort aktualisieren (neuer QR-Code); aus → nächsten Ping in den langsamen Takt
    const onVisible = () => {
      if (document.visibilityState === "visible") return void tick();
      if (busy) return;
      clearTimeout(timer);
      timer = setTimeout(tick, IDLE_MS);
    };
    document.addEventListener("visibilitychange", onVisible);
    void tick();
    return () => {
      stop = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
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
