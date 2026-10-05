// Mitarbeiterliste: Gesichtsstatus, Soll-Stunden; Admin legt an (immer 40 Std.) und passt Stunden individuell an
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { accountAdmin, generatePassword, suggestUsername } from "../lib/accountAdmin";
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
  username: string | null;
  auth_user_id: string | null;
  employment_details: { weekly_target_minutes: number; work_days_per_week: number } | null;
};

const ROLE_LABEL: Record<Role, string> = {
  admin: "Admin",
  manager: "Studioleitung",
  employee: "Mitarbeiter",
  trainee: "Azubi",
};

// Vorschlag beim Anlegen je Rolle: Azubis 40 Std./5 Tage (+ optional Samstag),
// Vollangestellte 25 Std./4 Tage. Abweichungen passt ein Admin an.
const DEFAULTS: Record<Exclude<Role, "admin">, { hours: number; days: number }> = {
  trainee: { hours: 40, days: 5 },
  employee: { hours: 25, days: 4 },
  manager: { hours: 25, days: 4 },
};
const DEFAULT_WEEKLY_MINUTES = 40 * 60;
const DEFAULT_WORK_DAYS = 5;

const fmtHours = (minutes: number) => `${(minutes / 60).toLocaleString("de-DE", { maximumFractionDigits: 2 })} Std.`;

export function Staff({ profile }: { profile: Profile }) {
  const isAdmin = profile.role === "admin";
  const [people, setPeople] = useState<Person[]>([]);
  const [locations, setLocations] = useState<Location[]>([]);
  const [faces, setFaces] = useState<Record<string, number> | null>(null);
  const [enrolling, setEnrolling] = useState<Person | null>(null);
  const [editing, setEditing] = useState<Person | null>(null);
  const [creating, setCreating] = useState(false);
  const [login, setLogin] = useState<Person | null>(null);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();

  const load = useCallback(async () => {
    const [users, locs] = await Promise.all([
      adminDb
        .from("users")
        .select(
          "id, first_name, last_name, role, home_location_id, username, auth_user_id, employment_details(weekly_target_minutes, work_days_per_week)",
        )
        .eq("is_active", true)
        .order("last_name"),
      adminDb.from("locations").select("id, code, name").order("name"),
    ]);
    if (users.error) return setError(users.error.message);
    setPeople(users.data as unknown as Person[]);
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
  const reload = () => {
    setCreating(false);
    setEditing(null);
    setLogin(null);
    void load();
  };

  async function resetPassword(p: Person) {
    const password = generatePassword();
    try {
      await accountAdmin({ action: "set_login_password", user_id: p.id, password });
      setNotice(`Neues Passwort für ${p.first_name}: ${password} – bitte weitergeben, es wird nicht erneut angezeigt.`);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <section className="stack">
      <div className="row-between">
        <h1>Mitarbeiter</h1>
        {isAdmin && !creating && (
          <button type="button" className="btn-primary" onClick={() => setCreating(true)}>Neu anlegen</button>
        )}
      </div>
      {error && <p className="form-error">{error}</p>}
      {notice && <p className="notice notice-info">{notice}</p>}
      {login && (
        <NewLogin
          person={login}
          onCancel={() => setLogin(null)}
          onCreated={(text) => {
            setNotice(text);
            reload();
          }}
        />
      )}
      {creating && <NewPerson locations={locations} onCancel={() => setCreating(false)} onSaved={reload} />}
      {editing && (
        <EditPerson person={editing} locations={locations} onCancel={() => setEditing(null)} onSaved={reload} />
      )}
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Rolle</th>
              <th>Studio</th>
              <th>Soll/Woche</th>
              {isAdmin && <th>Handy-Zugang</th>}
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
                <td className="num">
                  {p.employment_details ? `${fmtHours(p.employment_details.weekly_target_minutes)} · ${p.employment_details.work_days_per_week} Tage` : "–"}
                </td>
                {isAdmin && (
                  <td>
                    {p.username ? (
                      <span className="row">
                        <code>{p.username}</code>
                        <button type="button" className="btn-small" onClick={() => void resetPassword(p)}>Neues Passwort</button>
                      </span>
                    ) : p.auth_user_id ? (
                      <span className="muted small">E-Mail-Login</span>
                    ) : (
                      <button type="button" className="btn-small" onClick={() => setLogin(p)}>Zugang anlegen</button>
                    )}
                  </td>
                )}
                {faces && <td>{faces[p.id] ? <span className="pill pill-ok">erfasst</span> : <span className="pill">fehlt</span>}</td>}
                <td className="right row-end">
                  {isAdmin && <button type="button" className="btn-small" onClick={() => setEditing(p)}>Bearbeiten</button>}
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
  const [role, setRole] = useState<keyof typeof DEFAULTS>("employee");
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
      work_days_per_week: Number(f.get("work_days")),
    });
    if (role === "manager") {
      await adminDb.from("location_managers").insert({ user_id: user.id, location_id: homeLocation });
    }
    setBusy(false);
    if (details.error) return setError(`Vertragsdaten fehlen: ${details.error.message}`);
    props.onSaved();
  }

  return (
    <form className="card form form-wide" onSubmit={submit}>
      <h2>Neue Person</h2>
      <div className="grid-2">
        <label>Vorname<input id="new-first-name" name="first_name" required /></label>
        <label>Nachname<input id="new-last-name" name="last_name" required /></label>
        <label>
          Rolle
          <select id="new-role" value={role} onChange={(e) => setRole(e.target.value as keyof typeof DEFAULTS)}>
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
        {/* key = Rolle: Vorschlag springt beim Rollenwechsel um */}
        <label key={`h-${role}`}>
          Wochenstunden (Soll)
          <input id="new-weekly-hours" name="weekly_hours" type="number" min="0" max="60" step="0.5" defaultValue={DEFAULTS[role].hours} required />
        </label>
        <label key={`d-${role}`}>
          Arbeitstage pro Woche
          <input id="new-work-days" name="work_days" type="number" min="1" max="6" step="1" defaultValue={DEFAULTS[role].days} required />
        </label>
      </div>
      <p className="muted small">Vorschlag: Azubis 40 Std. an 5 Tagen, Vollangestellte 25 Std. an 4 Tagen. Später über „Bearbeiten“ änderbar.</p>
      {error && <p className="form-error">{error}</p>}
      <div className="row">
        <button type="submit" className="btn-primary" disabled={busy}>Speichern</button>
        <button type="button" className="btn-ghost" onClick={props.onCancel}>Abbrechen</button>
      </div>
    </form>
  );
}

function EditPerson(props: { person: Person; locations: Location[]; onCancel: () => void; onSaved: () => void }) {
  const { person } = props;
  const details = person.employment_details;
  const [leaving, setLeaving] = useState(false);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true);
    setError(undefined);
    const minutes = Math.round(Number(f.get("weekly_hours")) * 60);
    const days = Number(f.get("work_days"));

    const detailsSave = await adminDb
      .from("employment_details")
      .upsert({ user_id: person.id, weekly_target_minutes: minutes, work_days_per_week: days });
    const userSave = await adminDb
      .from("users")
      .update({
        role: String(f.get("role")),
        home_location_id: String(f.get("location")),
        // Ausgeschieden → Datenbank widerruft Einwilligung und löscht Gesichtsdaten
        ...(leaving ? { is_active: false } : {}),
      })
      .eq("id", person.id);
    setBusy(false);
    const failed = detailsSave.error ?? userSave.error;
    if (failed) return setError(`Speichern fehlgeschlagen: ${failed.message}`);
    props.onSaved();
  }

  return (
    <form className="card form form-wide" onSubmit={submit}>
      <h2>{person.first_name} {person.last_name} bearbeiten</h2>
      <div className="grid-2">
        <label>
          Wochenstunden (Soll)
          <input id="edit-weekly-hours" name="weekly_hours" type="number" min="0" max="60" step="0.5"
            defaultValue={(details?.weekly_target_minutes ?? DEFAULT_WEEKLY_MINUTES) / 60} required />
        </label>
        <label>
          Arbeitstage pro Woche
          <input id="edit-work-days" name="work_days" type="number" min="1" max="6" step="1"
            defaultValue={details?.work_days_per_week ?? DEFAULT_WORK_DAYS} required />
        </label>
        <label>
          Rolle
          <select id="edit-role" name="role" defaultValue={person.role}>
            <option value="employee">Mitarbeiter</option>
            <option value="trainee">Azubi</option>
            <option value="manager">Studioleitung</option>
            <option value="admin">Admin</option>
          </select>
        </label>
        <label>
          Heimatstudio
          <select id="edit-location" name="location" defaultValue={person.home_location_id ?? undefined}>
            {props.locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
        </label>
      </div>
      <label className="check">
        <input id="edit-leaving" type="checkbox" checked={leaving} onChange={(e) => setLeaving(e.target.checked)} />
        Ausgeschieden (deaktivieren)
      </label>
      {leaving && (
        <p className="notice notice-warn">
          Die Person kann dann nicht mehr stempeln. Einwilligung und Gesichtsdaten werden sofort gelöscht,
          Arbeitszeitnachweise bleiben erhalten.
        </p>
      )}
      {error && <p className="form-error">{error}</p>}
      <div className="row">
        <button type="submit" className="btn-primary" disabled={busy}>Speichern</button>
        <button type="button" className="btn-ghost" onClick={props.onCancel}>Abbrechen</button>
      </div>
    </form>
  );
}

function NewLogin(props: { person: Person; onCancel: () => void; onCreated: (text: string) => void }) {
  const [username, setUsername] = useState(suggestUsername(props.person.first_name, props.person.last_name));
  const [password] = useState(() => generatePassword());
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    try {
      await accountAdmin({ action: "create_login", user_id: props.person.id, username, password });
      props.onCreated(
        `Zugang für ${props.person.first_name}: Benutzername „${username}“, Passwort ${password} – bitte weitergeben (Adresse: …/#/portal). Das Passwort kann im Portal geändert werden.`,
      );
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card form form-wide" onSubmit={submit}>
      <h2>Handy-Zugang für {props.person.first_name} {props.person.last_name}</h2>
      <label>
        Benutzername
        <input id="login-username" value={username} onChange={(e) => setUsername(e.target.value.toLowerCase())}
          pattern="[a-z0-9][a-z0-9._\-]{2,30}" title="3–31 Zeichen: a–z, 0–9, Punkt, - und _" autoCapitalize="none" required />
      </label>
      <p className="muted small">Startpasswort: <code>{password}</code> (wird nach dem Anlegen angezeigt)</p>
      {error && <p className="form-error">{error}</p>}
      <div className="row">
        <button type="submit" className="btn-primary" disabled={busy}>{busy ? "Legt an …" : "Zugang anlegen"}</button>
        <button type="button" className="btn-ghost" onClick={props.onCancel}>Abbrechen</button>
      </div>
    </form>
  );
}
