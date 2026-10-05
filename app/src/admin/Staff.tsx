// Mitarbeiterliste mit Gesichtsstatus; Admin kann Mitarbeiter anlegen
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { adminDb } from "../lib/supabase";
import type { Location, Role } from "../lib/types";
import type { Profile } from "./AdminApp";
import { Enroll } from "./Enroll";

export type Person = {
  id: string;
  first_name: string;
  last_name: string;
  role: Role;
  home_location_id: string | null;
};

const ROLE_LABEL: Record<Role, string> = {
  admin: "Admin",
  manager: "Studioleitung",
  employee: "Mitarbeiter",
  trainee: "Azubi",
};

export function Staff({ profile }: { profile: Profile }) {
  const isAdmin = profile.role === "admin";
  const [people, setPeople] = useState<Person[]>([]);
  const [locations, setLocations] = useState<Location[]>([]);
  const [faces, setFaces] = useState<Record<string, number> | null>(null);
  const [enrolling, setEnrolling] = useState<Person | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string>();

  const load = useCallback(async () => {
    const [users, locs] = await Promise.all([
      adminDb
        .from("users")
        .select("id, first_name, last_name, role, home_location_id")
        .eq("is_active", true)
        .order("last_name"),
      adminDb.from("locations").select("id, code, name").order("name"),
    ]);
    if (users.error) return setError(users.error.message);
    setPeople(users.data as Person[]);
    setLocations((locs.data ?? []) as Location[]);
    // Gesichtsstatus sehen nur Admins (Biometrie-Daten)
    if (isAdmin) {
      const { data } = await adminDb.from("face_embeddings").select("user_id");
      const counts: Record<string, number> = {};
      for (const row of data ?? []) counts[row.user_id] = (counts[row.user_id] ?? 0) + 1;
      setFaces(counts);
    }
  }, [isAdmin]);

  useEffect(() => {
    void load();
  }, [load]);

  if (enrolling) {
    return (
      <Enroll
        person={enrolling}
        isAdmin={isAdmin}
        onDone={() => {
          setEnrolling(null);
          void load();
        }}
      />
    );
  }

  const locationName = (id: string | null) => locations.find((l) => l.id === id)?.name ?? "–";

  return (
    <section className="stack">
      <div className="row-between">
        <h1>Mitarbeiter</h1>
        {isAdmin && !creating && (
          <button type="button" className="btn-primary" onClick={() => setCreating(true)}>Neu anlegen</button>
        )}
      </div>
      {error && <p className="form-error">{error}</p>}
      {creating && (
        <NewPerson
          locations={locations}
          onCancel={() => setCreating(false)}
          onSaved={() => {
            setCreating(false);
            void load();
          }}
        />
      )}
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Rolle</th>
              <th>Studio</th>
              {faces && <th>Gesicht</th>}
              <th />
            </tr>
          </thead>
          <tbody>
            {people.map((p) => (
              <tr key={p.id}>
                <td>{p.first_name} {p.last_name}</td>
                <td>{ROLE_LABEL[p.role]}</td>
                <td>{locationName(p.home_location_id)}</td>
                {faces && <td>{faces[p.id] ? <span className="pill pill-ok">erfasst</span> : <span className="pill">fehlt</span>}</td>}
                <td className="right">
                  <button type="button" className="btn-small" onClick={() => setEnrolling(p)}>Gesicht erfassen</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function NewPerson(props: { locations: Location[]; onCancel: () => void; onSaved: () => void }) {
  const [role, setRole] = useState<Role>("employee");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const homeLocation = String(f.get("location"));
    setBusy(true);
    setError(undefined);

    const { data: user, error } = await adminDb
      .from("users")
      .insert({
        first_name: String(f.get("first_name")).trim(),
        last_name: String(f.get("last_name")).trim(),
        role,
        home_location_id: homeLocation,
      })
      .select("id")
      .single();
    if (error || !user) {
      setBusy(false);
      return setError(`Speichern fehlgeschlagen: ${error?.message}`);
    }

    const details = await adminDb.from("employment_details").insert({
      user_id: user.id,
      weekly_target_minutes: Math.round(Number(f.get("weekly_hours")) * 60),
      school_day_credit_minutes: role === "trainee" ? Math.round(Number(f.get("school_hours")) * 60) : null,
    });
    if (role === "manager") {
      await adminDb.from("location_managers").insert({ user_id: user.id, location_id: homeLocation });
    }
    setBusy(false);
    if (details.error) return setError(`Vertragsdaten fehlen: ${details.error.message}`);
    props.onSaved();
  }

  return (
    <form className="card form" onSubmit={submit}>
      <h2>Neue Person</h2>
      <div className="grid-2">
        <label>Vorname<input id="new-first-name" name="first_name" required /></label>
        <label>Nachname<input id="new-last-name" name="last_name" required /></label>
        <label>
          Rolle
          <select id="new-role" value={role} onChange={(e) => setRole(e.target.value as Role)}>
            <option value="employee">Mitarbeiter</option>
            <option value="trainee">Azubi</option>
            <option value="manager">Studioleitung</option>
          </select>
        </label>
        <label>
          Heimatstudio
          <select id="new-location" name="location" required>
            {props.locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
        </label>
        <label>
          Wochenstunden (Soll)
          <input id="new-weekly-hours" name="weekly_hours" type="number" min="0" max="60" step="0.5" defaultValue="40" required />
        </label>
        {role === "trainee" && (
          <label>
            Gutschrift Berufsschultag (Std.)
            <input id="new-school-hours" name="school_hours" type="number" min="0" max="12" step="0.5" defaultValue="8" required />
          </label>
        )}
      </div>
      {error && <p className="form-error">{error}</p>}
      <div className="row">
        <button type="submit" className="btn-primary" disabled={busy}>Speichern</button>
        <button type="button" className="btn-ghost" onClick={props.onCancel}>Abbrechen</button>
      </div>
    </form>
  );
}
