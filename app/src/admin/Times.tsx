// Zeiten je Mitarbeiter (Soll/Ist, Stempelungen) und Nachtrag (Admin sofort, Studioleitung mit Freigabe)
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { DayTable, type DaySummary, istMinutes, type Stamp, SummaryCard } from "../components/DayTable";
import { Field, Icon, Notice, PageHeader, Sheet, WeekNav } from "../components/ui";
import { addDays, berlinDate, berlinTime, berlinToISO, weekStart } from "../lib/dates";
import { dbMessage } from "../lib/errors";
import { adminDb } from "../lib/supabase";
import { EVENT_LABEL, type EventType, type Location, studioShort } from "../lib/types";
import type { Profile } from "./AdminApp";

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
        .select("id, event_type, recorded_at, approval_status, source")
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
    setMessage(isAdmin ? "Nachtrag gespeichert." : "Nachtrag gespeichert – wartet auf Freigabe durch Tobias oder Dominik.");
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
      <DayTable days={days} stamps={stamps} />

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
                ? "Bis 7 Tage rückwirkend, sofort gültig – z. B. nach einem Anruf ohne Gesichtserkennung."
                : "Nur mit Freischaltung durch einen Admin; der Nachtrag wartet auf Freigabe durch Tobias oder Dominik."}
            </p>
            <div className="grid-2">
              <Field label="Buchung">
                <select id="entry-event" name="event" defaultValue="clock_in">
                  {(Object.keys(EVENT_LABEL) as EventType[]).map((t) => <option key={t} value={t}>{EVENT_LABEL[t]}</option>)}
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
