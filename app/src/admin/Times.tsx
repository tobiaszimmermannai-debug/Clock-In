// Zeiten je Mitarbeiter (Soll/Ist, Stempelungen) und Nachtrag (Admin sofort, Studioleitung mit Freigabe).
// Admin: Tag antippen → Stempelungen des Tages korrigieren (alle löschen und neu eintragen, ein Schritt).
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { DayTable, type DaySummary, istMinutes, type Stamp, SummaryCard } from "../components/DayTable";
import { Field, Icon, Notice, PageHeader, Sheet, WeekNav } from "../components/ui";
import { addDays, berlinDate, berlinTime, berlinToISO, fmtHM, fmtLongDay, weekStart } from "../lib/dates";
import { type Block, blocksFromStamps, blocksToEvents, calcDay, newBlock } from "../lib/dayEdit";
import { dbMessage } from "../lib/errors";
import { adminDb } from "../lib/supabase";
import { EVENT_LABEL, type EventType, type Location, studioShort } from "../lib/types";
import type { Profile } from "./AdminApp";
import { approvers } from "../lib/approvers";

type Staffer = {
  id: string;
  first_name: string;
  last_name: string;
  home_location_id: string | null;
  employment_details: { weekly_target_minutes: number } | null;
};

export function Times({ profile }: { profile: Profile }) {
  const isAdmin = profile.role === "admin";
  const [people, setPeople] = useState<Staffer[]>([]);
  const [locations, setLocations] = useState<Location[]>([]);
  const [personId, setPersonId] = useState("");
  const [start, setStart] = useState(weekStart(berlinDate()));
  const [days, setDays] = useState<DaySummary[]>([]);
  const [stamps, setStamps] = useState<Stamp[]>([]);
  const [error, setError] = useState<string>();
  const [message, setMessage] = useState<string>();
  const [entry, setEntry] = useState(false);
  const [editDay, setEditDay] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const [users, locs] = await Promise.all([
        adminDb
          .from("users")
          .select("id, first_name, last_name, home_location_id, employment_details(weekly_target_minutes)")
          .eq("is_active", true)
          .neq("role", "admin")
          .order("first_name"),
        adminDb.from("locations").select("id, code, name").eq("is_active", true).order("name"),
      ]);
      const list = (users.data ?? []) as unknown as Staffer[];
      setPeople(list);
      setLocations((locs.data ?? []) as Location[]);
      if (list[0]) setPersonId(list[0].id);
    })();
  }, []);

  const load = useCallback(async () => {
    if (!personId) return;
    const [summary, logs] = await Promise.all([
      adminDb.rpc("work_day_summary", { p_user: personId, p_from: start, p_to: addDays(start, 6) }),
      adminDb
        .from("time_logs")
        .select("id, event_type, recorded_at, approval_status, source, location_id")
        .eq("user_id", personId)
        .gte("recorded_at", berlinToISO(start))
        .lt("recorded_at", berlinToISO(addDays(start, 7)))
        .order("recorded_at"),
    ]);
    setError(summary.error ? dbMessage(summary.error) : undefined);
    setDays((summary.data ?? []) as DaySummary[]);
    setStamps((logs.data ?? []) as Stamp[]);
  }, [personId, start]);

  useEffect(() => {
    void load();
  }, [load]);

  const person = people.find((p) => p.id === personId);

  async function addEntry(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    const { error } = await adminDb.from("time_logs").insert({
      user_id: personId,
      location_id: String(f.get("location")),
      event_type: String(f.get("event")),
      recorded_at: berlinToISO(String(f.get("date")), String(f.get("time"))),
      source: "manual",
      note: String(f.get("note")).trim(),
    });
    if (error) {
      setMessage(undefined);
      return setError(
        error.code === "42501"
          ? "Nachtrag nicht erlaubt: nur Admins oder freigeschaltete Studioleitungen, höchstens 7 Tage rückwirkend."
          : dbMessage(error),
      );
    }
    form.reset();
    setEntry(false);
    setError(undefined);
    setMessage(isAdmin ? "Nachtrag gespeichert." : `Nachtrag gespeichert – wartet auf Freigabe durch ${approvers()}.`);
    void load();
  }

  return (
    <>
      <PageHeader
        title="Zeiten"
        actions={
          <button type="button" className="btn btn-primary" disabled={!personId} onClick={() => { setError(undefined); setEntry(true); }}>
            <Icon name="plus" size={20} /> Nachtragen
          </button>
        }
      />
      <Field label="Mitarbeiter">
        <select id="times-person" value={personId} onChange={(e) => setPersonId(e.target.value)}>
          {people.map((p) => <option key={p.id} value={p.id}>{p.first_name} {p.last_name}</option>)}
        </select>
      </Field>
      <WeekNav start={start} onChange={setStart} />
      {person && (
        <div className="stats">
          <SummaryCard title={`${person.first_name} · Woche`} ist={istMinutes(days)} soll={person.employment_details?.weekly_target_minutes ?? 0} />
        </div>
      )}
      {error && !entry && <Notice tone="error">{error}</Notice>}
      {message && <Notice tone="ok">{message}</Notice>}
      <DayTable days={days} stamps={stamps} onEdit={isAdmin ? setEditDay : undefined} />
      {isAdmin && <p className="muted small">Tag oder Uhrzeit antippen, um Kommen und Gehen zu ändern – die Pause wird automatisch abgezogen.</p>}

      {editDay && person && (
        <DayEditor
          person={person}
          day={editDay}
          stamps={stamps.filter((s) => berlinDate(s.recorded_at) === editDay && s.approval_status !== "rejected")}
          locations={locations}
          onClose={() => setEditDay(null)}
          onSaved={(text) => {
            setEditDay(null);
            setError(undefined);
            setMessage(text);
            void load();
          }}
        />
      )}

      {entry && (
        <Sheet
          title="Zeit nachtragen"
          subtitle={person ? `${person.first_name} ${person.last_name}` : undefined}
          onClose={() => setEntry(false)}
          footer={<button type="submit" form="entry-form" className="btn btn-primary">Nachtragen</button>}
        >
          <form id="entry-form" className="form" onSubmit={addEntry}>
            <p className="muted small">
              {isAdmin
                ? "Rückwirkend, sofort gültig – z. B. nach einem Anruf (kein Handy dabei). Ganzen Tag korrigieren: Tag in der Liste antippen."
                : `Nur mit Freischaltung durch einen Admin; der Nachtrag wartet auf Freigabe durch ${approvers()}.`}
            </p>
            <div className="grid-2">
              <Field label="Buchung">
                <select id="entry-event" name="event" defaultValue="clock_in">
                  {/* Pausen werden nie nachgetragen – die gesetzliche Pause zieht das System automatisch ab */}
                  {(["clock_in", "clock_out"] as EventType[]).map((t) => <option key={t} value={t}>{EVENT_LABEL[t]}</option>)}
                </select>
              </Field>
              <Field label="Studio">
                <select id="entry-location" name="location" defaultValue={person?.home_location_id ?? undefined}>
                  {locations.map((l) => <option key={l.id} value={l.id}>{studioShort(l.name)}</option>)}
                </select>
              </Field>
              <Field label="Datum"><input id="entry-date" name="date" type="date" defaultValue={berlinDate()} max={berlinDate()} required /></Field>
              <Field label="Uhrzeit"><input id="entry-time" name="time" type="time" defaultValue={berlinTime(new Date())} required /></Field>
            </div>
            <p className="muted small">Pausen musst du nicht nachtragen – die gesetzliche Pause (ab 6 Std. 30 Min., ab 9 Std. 45 Min.) wird automatisch abgezogen.</p>
            <Field label="Grund (Pflicht)">
              <input id="entry-note" name="note" required minLength={3} maxLength={200} placeholder="z. B. Anruf, Tablet defekt" />
            </Field>
            {error && <Notice tone="error">{error}</Notice>}
          </form>
        </Sheet>
      )}
    </>
  );
}

// Tag korrigieren: nur Kommen und Gehen je Einsatz → ersetzt alle Stempelungen des Tages (protokolliert).
// Pausen trägt niemand mehr von Hand ein – das System zieht die gesetzliche Pause automatisch ab.
function DayEditor(props: {
  person: Staffer;
  day: string;
  stamps: Stamp[];
  locations: Location[];
  onClose: () => void;
  onSaved: (text: string) => void;
}) {
  const [blocks, setBlocks] = useState<Block[]>(() => {
    const list = blocksFromStamps(props.stamps, berlinTime);
    return list.length ? list : [newBlock()];
  });
  const [location, setLocation] = useState(props.stamps.find((s) => s.location_id)?.location_id ?? props.person.home_location_id ?? props.locations[0]?.id ?? "");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const hadBreaks = props.stamps.some((s) => s.event_type === "break_start" || s.event_type === "break_end");
  const calc = calcDay(blocks);

  const update = (key: number, patch: Partial<Block>) => setBlocks((r) => r.map((x) => (x.key === key ? { ...x, ...patch } : x)));
  const addBlock = () => setBlocks((r) => {
    const last = [...r].sort((a, b) => a.from.localeCompare(b.from)).at(-1);
    return [...r, newBlock(last?.to || "16:00", "")];
  });

  async function save(clear = false) {
    setError(undefined);
    if (note.trim().length < 3) return setError("Bitte einen Grund angeben (mind. 3 Zeichen).");
    if (!clear && calc.problem) return setError(calc.problem);
    const events = clear ? [] : blocksToEvents(blocks);
    setBusy(true);
    const { error } = await adminDb.rpc("replace_day_logs", {
      p_user: props.person.id,
      p_day: props.day,
      p_location: location || null,
      p_events: events.map((e) => ({ event: e.event, at: berlinToISO(props.day, e.time) })),
      p_note: note.trim(),
    });
    setBusy(false);
    if (error) return setError(dbMessage(error));
    props.onSaved(events.length
      ? `${props.person.first_name}: ${fmtLongDay(props.day)} neu erfasst – ${fmtHM(calc.presence)} Std. anwesend, ${calc.autoBreak} Min. Pause automatisch abgezogen.`
      : `${props.person.first_name}: alle Stempelungen am ${fmtLongDay(props.day)} gelöscht.`);
  }

  return (
    <Sheet
      title="Tag korrigieren"
      subtitle={`${props.person.first_name} ${props.person.last_name} · ${fmtLongDay(props.day)}`}
      onClose={props.onClose}
      footer={<button type="button" className="btn btn-primary" disabled={busy} onClick={() => void save()}>{busy ? "Speichert …" : "Tag neu speichern"}</button>}
    >
      <p className="muted small">Uhrzeit antippen und ändern. Pausen musst du nicht eintragen – die gesetzliche Pause wird automatisch abgezogen.</p>
      <div className="list day-edit">
        {blocks.map((b, i) => (
          <div key={b.key} className="list-row day-edit-block">
            <label className="day-edit-time">
              <span>{blocks.length > 1 ? `Kommen ${i + 1}` : "Kommen"}</span>
              <input aria-label="Kommen" type="time" value={b.from} onChange={(e) => update(b.key, { from: e.target.value })} required />
            </label>
            <span className="day-edit-dash" aria-hidden="true">–</span>
            <label className="day-edit-time">
              <span>Gehen</span>
              <input aria-label="Gehen" type="time" value={b.to} onChange={(e) => update(b.key, { to: e.target.value })} required />
            </label>
            {blocks.length > 1 ? (
              <button type="button" className="icon-btn" aria-label="Einsatz löschen" onClick={() => setBlocks((x) => x.filter((y) => y.key !== b.key))}>
                <Icon name="trash" size={18} />
              </button>
            ) : <span />}
          </div>
        ))}
      </div>
      <div className="day-edit-sum">
        <span>Anwesend <b>{fmtHM(calc.presence)} Std.</b></span>
        <span>Pause automatisch <b>{calc.autoBreak} Min.</b>{calc.gaps > 0 ? ` (+ ${calc.gaps} Min. zwischen den Einsätzen)` : ""}</span>
        <span>Zählt <b>{fmtHM(calc.counted)} Std.</b></span>
      </div>
      <p className="muted small">Ab Schichtbeginn bis Schichtende; Überstunden rechnet das System wie gewohnt.</p>
      {hadBreaks && <Notice>Gestempelte Pausen dieses Tages werden ersetzt – es zählt die automatische Pause.</Notice>}
      <div className="list-actions">
        <button type="button" className="btn btn-outline btn-sm" onClick={addBlock}><Icon name="plus" size={16} /> Weiterer Einsatz (Splitschicht)</button>
      </div>
      <Field label="Studio">
        <select id="edit-location" value={location} onChange={(e) => setLocation(e.target.value)}>
          {props.locations.map((l) => <option key={l.id} value={l.id}>{studioShort(l.name)}</option>)}
        </select>
      </Field>
      <Field label="Grund (Pflicht)">
        <input id="edit-note" value={note} maxLength={200} placeholder="z. B. Ausstempeln vergessen" onChange={(e) => setNote(e.target.value)} />
      </Field>
      {error && <Notice tone="error">{error}</Notice>}
      <button type="button" className="btn btn-plain btn-sm text-danger" disabled={busy} onClick={() => void save(true)}>Alle Stempelungen dieses Tages löschen</button>
    </Sheet>
  );
}
