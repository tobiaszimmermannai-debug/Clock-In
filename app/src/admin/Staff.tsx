// Team: Liste nach Studio → Detailseite (Vertrag, Handy-Zugang, Gesichtserkennung, Ausscheiden)
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { Avatar, Field, Icon, LeadingIcon, Notice, PageHeader, Pill, Row, Section, Sheet, StudioFilter } from "../components/ui";
import { accountAdmin, generatePassword, suggestUsername } from "../lib/accountAdmin";
import { fmtHours } from "../lib/dates";
import { adminDb } from "../lib/supabase";
import { type Location, ROLE_LABEL, type Role, studioShort } from "../lib/types";
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

// Vorschlag beim Anlegen je Rolle: Azubis 40 Std./5 Tage (+ optional Samstag),
// Vollangestellte 25 Std./4 Tage. Abweichungen passt ein Admin an.
const DEFAULTS: Record<Exclude<Role, "admin">, { hours: number; days: number }> = {
  trainee: { hours: 40, days: 5 },
  employee: { hours: 25, days: 4 },
  manager: { hours: 25, days: 4 },
};
const DEFAULT_WEEKLY_MINUTES = 40 * 60;
const DEFAULT_WORK_DAYS = 5;

const contract = (p: Person) =>
  p.employment_details ? `${fmtHours(p.employment_details.weekly_target_minutes)} · ${p.employment_details.work_days_per_week} Tage` : "–";

export function Staff({ profile }: { profile: Profile }) {
  const isAdmin = profile.role === "admin";
  const [people, setPeople] = useState<Person[]>([]);
  const [locations, setLocations] = useState<Location[]>([]);
  const [faces, setFaces] = useState<Record<string, number> | null>(null);
  const [studio, setStudio] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string>();

  const load = useCallback(async () => {
    const [users, locs] = await Promise.all([
      adminDb
        .from("users")
        .select(
          "id, first_name, last_name, role, home_location_id, username, auth_user_id, employment_details(weekly_target_minutes, work_days_per_week)",
        )
        .eq("is_active", true)
        .order("first_name"),
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

  const person = people.find((p) => p.id === selected);
  if (person) {
    return (
      <PersonDetail
        person={person}
        isAdmin={isAdmin}
        hasFace={faces ? !!faces[person.id] : undefined}
        locations={locations}
        onBack={() => setSelected(null)}
        onChanged={load}
        onRemoved={() => {
          setSelected(null);
          void load();
        }}
      />
    );
  }

  const staff = people.filter((p) => p.role !== "admin");
  const groups = [
    ...[...locations, { id: "", code: "", name: "Ohne Studio" }]
      .filter((l) => !studio || l.id === studio)
      .map((l) => ({ key: l.id, title: studioShort(l.name), members: staff.filter((p) => (p.home_location_id ?? "") === l.id) })),
    ...(studio ? [] : [{ key: "admins", title: "Geschäftsführung", members: people.filter((p) => p.role === "admin") }]),
  ].filter((g) => g.members.length > 0);

  return (
    <>
      <PageHeader
        title="Team"
        subtitle={`${people.length} aktive Personen`}
        actions={isAdmin && (
          <button type="button" className="btn btn-primary" onClick={() => setCreating(true)}>
            <Icon name="plus" size={20} /> Neue Person
          </button>
        )}
      />
      <StudioFilter locations={locations} value={studio} onChange={setStudio} />
      {error && <Notice tone="error">{error}</Notice>}
      {groups.map((g) => (
        <Section key={g.key} title={g.title} aside={<span>{g.members.length}</span>}>
          {g.members.map((p) => (
            <Row
              key={p.id}
              leading={<Avatar first={p.first_name} last={p.last_name} />}
              title={`${p.first_name} ${p.last_name}`}
              subtitle={`${ROLE_LABEL[p.role]} · ${contract(p)}`}
              trailing={faces && p.role !== "admin" && (faces[p.id] ? <Pill tone="ok">Gesicht</Pill> : <Pill>kein Gesicht</Pill>)}
              chevron
              onClick={() => setSelected(p.id)}
            />
          ))}
        </Section>
      ))}
      {creating && (
        <NewPerson
          locations={locations}
          defaultStudio={studio}
          onClose={() => setCreating(false)}
          onSaved={(id) => {
            setCreating(false);
            void load().then(() => setSelected(id));
          }}
        />
      )}
    </>
  );
}

function PersonDetail(props: {
  person: Person;
  isAdmin: boolean;
  hasFace?: boolean;
  locations: Location[];
  onBack: () => void;
  onChanged: () => Promise<void>;
  onRemoved: () => void;
}) {
  const { person, isAdmin } = props;
  const [view, setView] = useState<"detail" | "enroll" | "login" | "leave">("detail");
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string }>();
  const studio = props.locations.find((l) => l.id === person.home_location_id);

  if (view === "enroll") {
    return (
      <Enroll
        person={person}
        isAdmin={isAdmin}
        onDone={() => {
          setView("detail");
          void props.onChanged();
        }}
      />
    );
  }

  async function resetPassword() {
    const password = generatePassword();
    try {
      await accountAdmin({ action: "set_login_password", user_id: person.id, password });
      setMessage({ tone: "ok", text: `Neues Passwort für ${person.first_name}: ${password} – bitte weitergeben, es wird nicht erneut angezeigt.` });
    } catch (e) {
      setMessage({ tone: "error", text: (e as Error).message });
    }
  }

  return (
    <>
      <PageHeader
        back={props.onBack}
        title={`${person.first_name} ${person.last_name}`}
        subtitle={`${ROLE_LABEL[person.role]}${studio ? ` · ${studioShort(studio.name)}` : ""}`}
      />
      {message && <Notice tone={message.tone}>{message.text}</Notice>}

      {isAdmin ? (
        <ContractForm person={person} locations={props.locations} onSaved={async () => {
          setMessage({ tone: "ok", text: "Gespeichert." });
          await props.onChanged();
        }} />
      ) : (
        <Section title="Arbeitsvertrag">
          <Row title="Soll pro Woche" trailing={<span className="num">{contract(person)}</span>} />
        </Section>
      )}

      {isAdmin && person.role !== "admin" && (
        <Section title="Handy-Zugang" footer="Damit sieht die Person im Handy-Portal ihre Stunden und den Dienstplan.">
          {person.username ? (
            <Row
              leading={<LeadingIcon name="phone" />}
              title={<code>{person.username}</code>}
              subtitle="Benutzername fürs Portal"
              trailing={<button type="button" className="btn btn-outline btn-sm" onClick={() => void resetPassword()}>Neues Passwort</button>}
            />
          ) : person.auth_user_id ? (
            <Row leading={<LeadingIcon name="phone" />} title="E-Mail-Login" subtitle="Anmeldung mit E-Mail-Adresse" />
          ) : (
            <Row leading={<LeadingIcon name="key" />} className="is-accent" title="Zugang anlegen" chevron onClick={() => setView("login")} />
          )}
        </Section>
      )}

      {person.role !== "admin" && (
        <Section title="Gesichtserkennung" footer="Nur mit unterschriebener Einwilligung. Gespeichert werden Merkmale, kein Foto.">
          <Row
            leading={<LeadingIcon name="face" />}
            title="Gesicht erfassen"
            subtitle={props.hasFace === undefined ? "Einwilligung und Aufnahme" : props.hasFace ? "Erfasst – erneut aufnehmen" : "Noch nicht erfasst"}
            trailing={props.hasFace !== undefined && (props.hasFace ? <Pill tone="ok">erfasst</Pill> : <Pill tone="warn">fehlt</Pill>)}
            chevron
            onClick={() => setView("enroll")}
          />
        </Section>
      )}

      {isAdmin && (
        <Section>
          <Row className="is-danger" title="Als ausgeschieden markieren" chevron onClick={() => setView("leave")} />
        </Section>
      )}

      {view === "login" && (
        <NewLogin
          person={person}
          onClose={() => setView("detail")}
          onCreated={async (text) => {
            setView("detail");
            setMessage({ tone: "ok", text });
            await props.onChanged();
          }}
        />
      )}
      {view === "leave" && <Leave person={person} onClose={() => setView("detail")} onDone={props.onRemoved} />}
    </>
  );
}

function ContractForm(props: { person: Person; locations: Location[]; onSaved: () => Promise<void> }) {
  const { person } = props;
  const details = person.employment_details;
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true);
    setError(undefined);
    const detailsSave = await adminDb.from("employment_details").upsert({
      user_id: person.id,
      weekly_target_minutes: Math.round(Number(f.get("weekly_hours")) * 60),
      work_days_per_week: Number(f.get("work_days")),
    });
    const userSave = await adminDb
      .from("users")
      .update({ role: String(f.get("role")), home_location_id: String(f.get("location")) })
      .eq("id", person.id);
    setBusy(false);
    const failed = detailsSave.error ?? userSave.error;
    if (failed) return setError(`Speichern fehlgeschlagen: ${failed.message}`);
    await props.onSaved();
  }

  return (
    <Section title="Arbeitsvertrag" plain>
      <form className="panel form" onSubmit={submit}>
        <div className="grid-2">
          <Field label="Wochenstunden (Soll)">
            <input id="edit-weekly-hours" name="weekly_hours" type="number" min="0" max="60" step="0.5"
              defaultValue={(details?.weekly_target_minutes ?? DEFAULT_WEEKLY_MINUTES) / 60} required />
          </Field>
          <Field label="Arbeitstage pro Woche">
            <input id="edit-work-days" name="work_days" type="number" min="1" max="6" step="1"
              defaultValue={details?.work_days_per_week ?? DEFAULT_WORK_DAYS} required />
          </Field>
          <Field label="Rolle">
            <select id="edit-role" name="role" defaultValue={person.role}>
              <option value="employee">Mitarbeiter</option>
              <option value="trainee">Azubi</option>
              <option value="manager">Studioleitung</option>
              <option value="admin">Admin</option>
            </select>
          </Field>
          <Field label="Heimatstudio">
            <select id="edit-location" name="location" defaultValue={person.home_location_id ?? undefined}>
              {props.locations.map((l) => <option key={l.id} value={l.id}>{studioShort(l.name)}</option>)}
            </select>
          </Field>
        </div>
        {error && <Notice tone="error">{error}</Notice>}
        <div className="form-actions">
          <button type="submit" className="btn btn-secondary" disabled={busy}>{busy ? "Speichert …" : "Änderungen speichern"}</button>
        </div>
      </form>
    </Section>
  );
}

function NewPerson(props: { locations: Location[]; defaultStudio: string; onClose: () => void; onSaved: (id: string) => void }) {
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
    props.onSaved(user.id);
  }

  return (
    <Sheet
      title="Neue Person"
      onClose={props.onClose}
      footer={<button type="submit" form="new-person" className="btn btn-primary" disabled={busy}>{busy ? "Speichert …" : "Anlegen"}</button>}
    >
      <form id="new-person" className="form" onSubmit={submit}>
        <div className="grid-2">
          <Field label="Vorname"><input id="new-first-name" name="first_name" autoComplete="off" required /></Field>
          <Field label="Nachname"><input id="new-last-name" name="last_name" autoComplete="off" required /></Field>
          <Field label="Rolle">
            <select id="new-role" value={role} onChange={(e) => setRole(e.target.value as keyof typeof DEFAULTS)}>
              <option value="employee">Mitarbeiter</option>
              <option value="trainee">Azubi</option>
              <option value="manager">Studioleitung</option>
            </select>
          </Field>
          <Field label="Heimatstudio">
            <select id="new-location" name="location" defaultValue={props.defaultStudio || undefined} required>
              {props.locations.map((l) => <option key={l.id} value={l.id}>{studioShort(l.name)}</option>)}
            </select>
          </Field>
          {/* key = Rolle: Vorschlag springt beim Rollenwechsel um */}
          <Field key={`h-${role}`} label="Wochenstunden (Soll)">
            <input id="new-weekly-hours" name="weekly_hours" type="number" min="0" max="60" step="0.5" defaultValue={DEFAULTS[role].hours} required />
          </Field>
          <Field key={`d-${role}`} label="Arbeitstage pro Woche">
            <input id="new-work-days" name="work_days" type="number" min="1" max="6" step="1" defaultValue={DEFAULTS[role].days} required />
          </Field>
        </div>
        <p className="muted small">Vorschlag: Azubis 40 Std. an 5 Tagen, Vollangestellte 25 Std. an 4 Tagen.</p>
        {error && <Notice tone="error">{error}</Notice>}
      </form>
    </Sheet>
  );
}

function NewLogin(props: { person: Person; onClose: () => void; onCreated: (text: string) => void }) {
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
    <Sheet
      title="Handy-Zugang"
      subtitle={`${props.person.first_name} ${props.person.last_name}`}
      onClose={props.onClose}
      footer={<button type="submit" form="new-login" className="btn btn-primary" disabled={busy}>{busy ? "Legt an …" : "Zugang anlegen"}</button>}
    >
      <form id="new-login" className="form" onSubmit={submit}>
        <Field label="Benutzername" hint="3–31 Zeichen: a–z, 0–9, Punkt, - und _">
          <input id="login-username" value={username} onChange={(e) => setUsername(e.target.value.toLowerCase())}
            pattern="[a-z0-9][a-z0-9._\-]{2,30}" autoCapitalize="none" spellCheck={false} required />
        </Field>
        <p className="muted small">Startpasswort: <code>{password}</code> – wird nach dem Anlegen noch einmal angezeigt.</p>
        {error && <Notice tone="error">{error}</Notice>}
      </form>
    </Sheet>
  );
}

function Leave(props: { person: Person; onClose: () => void; onDone: () => void }) {
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  async function confirm() {
    setBusy(true);
    // Ausgeschieden → Datenbank widerruft Einwilligung und löscht Gesichtsdaten
    const { error } = await adminDb.from("users").update({ is_active: false }).eq("id", props.person.id);
    setBusy(false);
    if (error) return setError(error.message);
    props.onDone();
  }

  return (
    <Sheet
      title="Ausgeschieden"
      subtitle={`${props.person.first_name} ${props.person.last_name}`}
      onClose={props.onClose}
      footer={<button type="button" className="btn btn-danger-solid" disabled={busy} onClick={() => void confirm()}>Deaktivieren</button>}
    >
      <Notice tone="warn">
        {props.person.first_name} kann danach nicht mehr stempeln. Einwilligung und Gesichtsdaten werden sofort gelöscht,
        Arbeitszeitnachweise bleiben erhalten.
      </Notice>
      {error && <Notice tone="error">{error}</Notice>}
    </Sheet>
  );
}
