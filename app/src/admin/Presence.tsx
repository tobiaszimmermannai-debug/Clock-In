// „Wer ist da?“ – Live-Überblick je Studio: eingestempelt (seit wann), in Pause, noch nicht da, gegangen.
// Nur für Admins: alle Studios auf einer Seite, Daten aus presence_today(); aktualisiert alle 30 Sek.
import { useCallback, useEffect, useState } from "react";
import { Avatar, Empty, Icon, Notice, PageHeader, Pill, Row, Section } from "../components/ui";
import { berlinTime } from "../lib/dates";
import { dbMessage } from "../lib/errors";
import { registerStudios, studioColor } from "../lib/studios";
import { adminDb } from "../lib/supabase";
import { type Location, studioShort } from "../lib/types";

type State = "in" | "break" | "missing" | "later" | "gone" | "missed" | "absent";

type Presence = {
  user_id: string;
  first_name: string;
  last_name: string;
  location_id: string | null;
  state: State;
  clocked_in: string | null;
  since: string | null;
  last_out: string | null;
  shift_start: string | null;
  shift_end: string | null;
  late_minutes: number | null;
  tag: string | null;
  pending: boolean;
};

const ORDER: State[] = ["in", "break", "missing", "later", "gone", "missed", "absent"];
const TAG_LABEL: Record<string, string> = {
  herold: "Herold",
  acquisition: "Akquise",
  sick: "Krank",
  vacation: "Urlaub",
  vocational_school: "Schule",
  day_off: "Frei",
};
const REFRESH_MS = 30_000;

const minutesSince = (iso: string) => Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
const span = (from: string | null, to: string | null) => (from && to ? `${berlinTime(from)}–${berlinTime(to)}` : "");

export function Presence() {
  const [rows, setRows] = useState<Presence[]>([]);
  const [locations, setLocations] = useState<Location[]>([]);
  const [error, setError] = useState<string>();
  const [stand, setStand] = useState<string>();

  const load = useCallback(async () => {
    const { data, error } = await adminDb.rpc("presence_today");
    setError(error ? dbMessage(error) : undefined);
    if (!error) {
      setRows((data ?? []) as Presence[]);
      setStand(berlinTime(new Date()));
    }
  }, []);

  useEffect(() => {
    void (async () => {
      const { data } = await adminDb.from("locations").select("id, code, name").eq("is_active", true).order("name");
      const list = (data ?? []) as Location[];
      registerStudios(list);
      setLocations(list);
    })();
    void load();
    const timer = window.setInterval(() => void load(), REFRESH_MS);
    const onVisible = () => document.visibilityState === "visible" && void load();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [load]);

  const count = (s: State) => rows.filter((r) => r.state === s).length;
  // alle Studios (auch leere), dazu „Ohne Studio“ falls nötig
  const studios = [
    ...locations,
    ...(rows.some((r) => !r.location_id || !locations.some((l) => l.id === r.location_id))
      ? [{ id: "", code: "", name: "Ohne Studio" } as Location]
      : []),
  ];

  return (
    <div className="stack">
      <PageHeader
        title="Wer ist da?"
        subtitle={stand ? `Stand ${stand} Uhr · aktualisiert sich selbst` : "Lädt …"}
        actions={
          <button type="button" className="btn btn-outline" onClick={() => void load()} aria-label="Aktualisieren">
            <Icon name="clock" size={18} /> Jetzt
          </button>
        }
      />
      {error && <Notice tone="error">{error}</Notice>}

      <div className="presence-summary">
        <span className="presence-count is-in"><strong>{count("in")}</strong> arbeiten</span>
        <span className="presence-count is-break"><strong>{count("break")}</strong> in Pause</span>
        <span className="presence-count is-missing"><strong>{count("missing")}</strong> fehlen</span>
      </div>

      {studios.map((l) => {
        const list = rows
          .filter((r) => (l.id ? r.location_id === l.id : !r.location_id || !locations.some((x) => x.id === r.location_id)))
          .sort((a, b) => ORDER.indexOf(a.state) - ORDER.indexOf(b.state) || a.first_name.localeCompare(b.first_name, "de"));
        const here = list.filter((r) => r.state === "in" || r.state === "break").length;
        return (
          <Section
            key={l.id || "none"}
            title={<><span className="dot" style={{ background: studioColor(l.id) }} aria-hidden="true" /> {studioShort(l.name)}</>}
            aside={<span>{here} da</span>}
          >
            {list.length === 0 ? (
              <Empty icon="users" title="Heute niemand eingeplant" />
            ) : (
              list.map((r) => <PresenceRow key={r.user_id} row={r} />)
            )}
          </Section>
        );
      })}
    </div>
  );
}

function PresenceRow({ row: r }: { row: Presence }) {
  const shift = span(r.shift_start, r.shift_end);
  let sub: string;
  let pill: { tone: "ok" | "warn" | "bad" | "muted"; text: string };
  switch (r.state) {
    case "in":
      sub = `Da seit ${berlinTime(r.clocked_in!)}${shift ? ` · Schicht ${shift}` : ""}`;
      pill = { tone: "ok", text: "Arbeitet" };
      break;
    case "break":
      sub = `Pause seit ${berlinTime(r.since!)} (${minutesSince(r.since!)} Min.) · da seit ${berlinTime(r.clocked_in!)}`;
      pill = { tone: "warn", text: "Pause" };
      break;
    case "missing":
      sub = `Schicht ${shift} · noch nicht eingestempelt`;
      pill = { tone: "bad", text: `Fehlt ${r.late_minutes ?? 0} Min.` };
      break;
    case "later":
      sub = `Schicht ab ${berlinTime(r.shift_start!)}${r.clocked_in ? ` · war schon ${span(r.clocked_in, r.last_out)} da` : ""}`;
      pill = { tone: "muted", text: "Kommt noch" };
      break;
    case "gone":
      sub = `Da ${span(r.clocked_in, r.last_out)}${shift ? ` · Schicht ${shift}` : ""}`;
      pill = { tone: "muted", text: "Gegangen" };
      break;
    case "missed":
      sub = `Schicht ${shift} · nicht eingestempelt`;
      pill = { tone: "bad", text: "Nicht gekommen" };
      break;
    default:
      sub = "Heute nicht im Studio";
      pill = { tone: "muted", text: TAG_LABEL[r.tag ?? ""] ?? "Abwesend" };
  }
  const late = (r.state === "in" || r.state === "break" || r.state === "gone") && r.late_minutes;
  const tag = r.state !== "absent" && r.tag ? TAG_LABEL[r.tag] : null;
  return (
    <Row
      className={`presence-row is-${r.state}`}
      leading={<Avatar first={r.first_name} last={r.last_name} color={studioColor(r.location_id)} />}
      title={
        <>
          {r.first_name} {r.last_name}
          {tag && <> <Pill tone="accent">{tag}</Pill></>}
        </>
      }
      subtitle={
        <>
          {sub}
          {late ? <span className="presence-late"> · {late} Min. zu spät</span> : null}
          {r.pending ? <span className="presence-late"> · Stempelung noch nicht bestätigt</span> : null}
        </>
      }
      trailing={<Pill tone={pill.tone}>{pill.text}</Pill>}
    />
  );
}
