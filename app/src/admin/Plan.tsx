// Dienstplan bearbeiten (Admin: alle Studios, Studioleitung: eigene Studios)
import { type FormEvent, useEffect, useState } from "react";
import { type PlanShift, WeekPlan, useWeekShifts } from "../components/WeekPlan";
import { StudioFilter, WeekNav } from "../components/ui";
import { berlinDate, berlinTime, berlinToISO, fmtLongDay, weekStart } from "../lib/dates";
import { dbMessage } from "../lib/errors";
import { adminDb } from "../lib/supabase";
import { type Location, SHIFT_TYPE_LABEL, type ShiftType } from "../lib/types";
import type { Profile } from "./AdminApp";

type Staffer = { id: string; first_name: string; last_name: string; home_location_id: string | null };

export function Plan({ profile }: { profile: Profile }) {
  const [start, setStart] = useState(weekStart(berlinDate()));
  const [studio, setStudio] = useState("");
  const [people, setPeople] = useState<Staffer[]>([]);
  const [locations, setLocations] = useState<Location[]>([]);
  const [editing, setEditing] = useState<{ day: string; shift?: PlanShift } | null>(null);
  const { shifts, error, reload } = useWeekShifts(adminDb, start);

  useEffect(() => {
    void (async () => {
      const [users, locs, managed] = await Promise.all([
        adminDb.from("users").select("id, first_name, last_name, home_location_id").eq("is_active", true).neq("role", "admin").order("first_name"),
        adminDb.from("locations").select("id, code, name").eq("is_active", true).order("name"),
        adminDb.from("location_managers").select("location_id").eq("user_id", profile.id),
      ]);
      setPeople((users.data ?? []) as Staffer[]);
      setLocations((locs.data ?? []) as Location[]);
      // Studioleitung startet im eigenen Studio
      const own = managed.data?.[0]?.location_id;
      if (profile.role === "manager" && own) setStudio(own);
    })();
  }, [profile.id, profile.role]);

  return (
    <section className="stack">
      <div className="row-between">
        <h1>Dienstplan</h1>
      </div>
      <WeekNav start={start} onChange={setStart} />
      <StudioFilter locations={locations} value={studio} onChange={setStudio} />
      {error && <p className="form-error">{error}</p>}
      {editing && (
        <ShiftForm
          key={editing.shift?.id ?? editing.day}
          day={editing.day}
          shift={editing.shift}
          people={people}
          locations={locations}
          defaultStudio={studio || locations[0]?.id || ""}
          onClose={(changed) => {
            setEditing(null);
            if (changed) void reload();
          }}
        />
      )}
      <WeekPlan
        start={start}
        shifts={shifts}
        studio={studio}
        onAdd={(day) => setEditing({ day })}
        onSelect={(shift) => setEditing({ day: berlinDate(shift.starts_at), shift })}
      />
    </section>
  );
}

const ABSENCE_DEFAULT = { from: "08:00", to: "14:30" }; // 6,5 Std. Gutschrift

function ShiftForm(props: {
  day: string;
  shift?: PlanShift;
  people: Staffer[];
  locations: Location[];
  defaultStudio: string;
  onClose: (changed: boolean) => void;
}) {
  const s = props.shift;
  const [type, setType] = useState<ShiftType>(s?.shift_type ?? "work");
  const [error, setError] = useState<string>();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const isWork = type === "work";

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const date = String(f.get("date"));
    const row = {
      user_id: String(f.get("user")),
      shift_type: type,
      location_id: isWork ? String(f.get("location")) : null,
      starts_at: berlinToISO(date, isWork ? String(f.get("from")) : ABSENCE_DEFAULT.from),
      ends_at: berlinToISO(date, isWork ? String(f.get("to")) : ABSENCE_DEFAULT.to),
      note: String(f.get("note")).trim() || null,
    };
    if (row.ends_at <= row.starts_at) return setError("Das Ende muss nach dem Beginn liegen.");
    const { error } = s ? await adminDb.from("shifts").update(row).eq("id", s.id) : await adminDb.from("shifts").insert(row);
    if (error) return setError(dbMessage(error));
    props.onClose(true);
  }

  async function remove() {
    if (!s) return;
    const { error } = await adminDb.from("shifts").delete().eq("id", s.id);
    if (error) return setError(dbMessage(error));
    props.onClose(true);
  }

  return (
    <form className="card form form-wide" onSubmit={submit}>
      <h2>{s ? "Eintrag bearbeiten" : `Neuer Eintrag · ${fmtLongDay(props.day)}`}</h2>
      <div className="grid-2">
        <label>
          Person
          <select id="shift-user" name="user" defaultValue={s?.user_id ?? ""} required>
            <option value="" disabled>Bitte wählen</option>
            {props.people.map((p) => <option key={p.id} value={p.id}>{p.first_name} {p.last_name}</option>)}
          </select>
        </label>
        <label>
          Art
          <select id="shift-type" value={type} onChange={(e) => setType(e.target.value as ShiftType)}>
            {(Object.keys(SHIFT_TYPE_LABEL) as ShiftType[]).map((t) => <option key={t} value={t}>{SHIFT_TYPE_LABEL[t]}</option>)}
          </select>
        </label>
        <label>
          Datum
          <input id="shift-date" name="date" type="date" defaultValue={props.day} required />
        </label>
        {isWork && (
          <label>
            Studio
            <select id="shift-location" name="location" defaultValue={s?.location_id ?? props.defaultStudio} required>
              {props.locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
          </label>
        )}
        {isWork && (
          <>
            <label>Von<input id="shift-from" name="from" type="time" defaultValue={s ? berlinTime(s.starts_at) : "09:00"} required /></label>
            <label>Bis<input id="shift-to" name="to" type="time" defaultValue={s ? berlinTime(s.ends_at) : "15:30"} required /></label>
          </>
        )}
      </div>
      {!isWork && <p className="muted small">{SHIFT_TYPE_LABEL[type]} wird mit 6,5 Std. gutgeschrieben.</p>}
      <label>Notiz (optional)<input id="shift-note" name="note" defaultValue={s?.note ?? ""} maxLength={200} /></label>
      {error && <p className="form-error">{error}</p>}
      <div className="row">
        <button type="submit" className="btn-primary">Speichern</button>
        <button type="button" className="btn-ghost" onClick={() => props.onClose(false)}>Abbrechen</button>
        {s && (!confirmDelete
          ? <button type="button" className="btn-danger" onClick={() => setConfirmDelete(true)}>Löschen</button>
          : <button type="button" className="btn-danger" onClick={() => void remove()}>Wirklich löschen</button>)}
      </div>
    </form>
  );
}
