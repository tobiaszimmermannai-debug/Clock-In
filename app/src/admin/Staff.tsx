// Team: Liste nach Studio → Detailseite (Vertrag, Urlaub, Login, Stempel-Handy, Ausscheiden)
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { Avatar, Field, Icon, LeadingIcon, Notice, PageHeader, Pill, Row, Section, Sheet, StudioFilter } from "../components/ui";
import { accountAdmin, generatePassword, suggestUsername } from "../lib/accountAdmin";
import { berlinDate, fmtHours } from "../lib/dates";
import { registerStudios, studioColor } from "../lib/studios";
import { adminDb } from "../lib/supabase";
import { type Location, ROLE_LABEL, type Role, studioShort } from "../lib/types";
import type { Profile } from "./AdminApp";

export type Person = {
  id: string;
  first_name: string;
  last_name: string;
  role: Role;
  home_location_id: string | null;
  username: string | null;
  auth_user_id: string | null;
  employment_details: { weekly_target_minutes: number; work_days_per_week: number; vacation_days_per_year: number | null } | null;
};

// Urlaubstage im laufenden Jahr (vacation_overview)
export type VacationInfo = { user_id: string; allowance: number | null; taken: number; planned: number };
const vacationLeft = (v: VacationInfo) => (v.allowance === null ? null : Number(v.allowance) - v.taken - v.planned);
const fmtDays = (n: number) => `${String(n).replace(".", ",")} ${n === 1 ? "Tag" : "Tage"}`;

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
  const [phones, setPhones] = useState<Record<string, string>>({});
  const [vacation, setVacation] = useState<Record<string, VacationInfo>>({});
  const year = Number(berlinDate().slice(0, 4));
  const [studio, setStudio] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string>();

  const load = useCallback(async () => {
    const [users, locs] = await Promise.all([
      adminDb
        .from("users")
        .select(
          "id, first_name, last_name, role, home_location_id, username, auth_user_id, employment_details(weekly_target_minutes, work_days_per_week, vacation_days_per_year)",
        )
        .eq("is_active", true)
        .order("first_name"),
      adminDb.from("locations").select("id, code, name").eq("is_active", true).order("name"),
    ]);
    if (users.error) return setError(users.error.message);
    setPeople(users.data as unknown as Person[]);
    setLocations((locs.data ?? []) as Location[]);
    registerStudios((locs.data ?? []) as Location[]);
    // Registrierte Stempel-Handys (Admin: alle, Studioleitung: eigenes Studio)
    const [{ data }, overview] = await Promise.all([
      adminDb.from("stamp_phones").select("user_id, registered_at"),
      adminDb.rpc("vacation_overview", { p_year: year }),
    ]);
    setPhones(Object.fromEntries((data ?? []).map((r) => [r.user_id as string, r.registered_at as string])));
    setVacation(Object.fromEntries(((overview.data ?? []) as VacationInfo[]).map((v) => [v.user_id, v])));
  }, [year]);

  useEffect(() => {
    void load();
  }, [load]);

  const person = people.find((p) => p.id === selected);
  if (person) {
    return (
      <PersonDetail
        person={person}
        isAdmin={isAdmin}
        phoneSince={phones[person.id]}
        vacation={vacation[person.id]}
        year={year}
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
      .map((l) => ({
        key: l.id,
        title: studioShort(l.name),
        members: staff.filter((p) =>
          l.id ? p.home_location_id === l.id : !locations.some((x) => x.id === p.home_location_id)),
      })),
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
              leading={<Avatar first={p.first_name} last={p.last_name} color={p.role === "admin" ? undefined : studioColor(p.home_location_id)} />}
              title={`${p.first_name} ${p.last_name}`}
              subtitle={[ROLE_LABEL[p.role], contract(p), vacationShort(vacation[p.id])].filter(Boolean).join(" · ")}
              trailing={p.role !== "admin" && <ReadyPill person={p} hasPhone={!!phones[p.id]} />}
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

function vacationShort(v: VacationInfo | undefined) {
  const left = v ? vacationLeft(v) : null;
  return v && left !== null ? `Urlaub ${String(left).replace(".", ",")}/${String(Number(v.allowance)).replace(".", ",")} übrig` : "";
}

// Bereit zum Stempeln = Login vorhanden + Handy registriert
function ReadyPill(props: { person: Person; hasPhone: boolean }) {
  if (!props.person.username && !props.person.auth_user_id) return <Pill tone="warn">kein Login</Pill>;
  if (!props.hasPhone) return <Pill>Handy fehlt</Pill>;
  return <Pill tone="ok">bereit</Pill>;
}

function PersonDetail(props: {
  person: Person;
  isAdmin: boolean;
  phoneSince?: string;
  vacation?: VacationInfo;
  year: number;
  locations: Location[];
  onBack: () => void;
  onChanged: () => Promise<void>;
  onRemoved: () => void;
}) {
  const { person, isAdmin } = props;
  const [view, setView] = useState<"detail" | "login" | "leave">("detail");
  const [confirmReset, setConfirmReset] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string }>();
  const studio = props.locations.find((l) => l.id === person.home_location_id);

  async function resetPhone() {
    const { error } = await adminDb.from("stamp_phones").delete().eq("user_id", person.id);
    setConfirmReset(false);
    if (error) return setMessage({ tone: "error", text: error.message });
    setMessage({ tone: "ok", text: `Stempel-Handy zurückgesetzt. Das nächste Handy, mit dem ${person.first_name} stempelt, wird registriert.` });
    await props.onChanged();
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

      {person.role !== "admin" && (
        <VacationSection vacation={props.vacation} year={props.year} isAdmin={isAdmin} />
      )}

      {isAdmin && person.role !== "admin" && (
        <Section title="Login fürs Handy" footer="Damit stempelt die Person und sieht Stunden und Dienstplan.">
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
        <Section
          title="Stempel-Handy"
          footer="Gestempelt wird nur mit diesem Handy – Kollegen können niemanden mit ihrem Handy einstempeln. Neues Handy? Zurücksetzen; beim nächsten Stempeln wird das neue registriert."
        >
          {props.phoneSince ? (
            <Row
              leading={<LeadingIcon name="phone" />}
              title="Registriert"
              subtitle={`seit ${new Date(props.phoneSince).toLocaleDateString("de-DE", { timeZone: "Europe/Berlin" })}`}
              trailing={
                <button type="button" className={confirmReset ? "btn btn-danger-solid btn-sm" : "btn btn-danger btn-sm"}
                  onClick={() => (confirmReset ? void resetPhone() : setConfirmReset(true))}>
                  {confirmReset ? "Wirklich zurücksetzen" : "Zurücksetzen"}
                </button>
              }
            />
          ) : (
            <Row leading={<LeadingIcon name="phone" />} title="Noch nicht registriert" subtitle="Wird beim ersten Stempeln automatisch registriert" />
          )}
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

// Urlaubstagezähler: Anspruch (im Vertrag), genommen bis heute, geplant, übrig
function VacationSection(props: { vacation?: VacationInfo; year: number; isAdmin: boolean }) {
  const v = props.vacation;
  const left = v ? vacationLeft(v) : null;
  if (!v || v.allowance === null) {
    return (
      <Section title={`Urlaub ${props.year}`}>
        <Row title="Noch kein Urlaubsanspruch hinterlegt"
          subtitle={props.isAdmin ? "Oben im Arbeitsvertrag bei „Urlaubstage pro Jahr“ eintragen." : "Tobias oder Dominik tragen den Anspruch ein."} />
      </Section>
    );
  }
  return (
    <Section title={`Urlaub ${props.year}`} footer="Jeder eingetragene Urlaubstag im Dienstplan zählt als ein Tag.">
      <Row title="Anspruch" trailing={<span className="num">{fmtDays(Number(v.allowance))}</span>} />
      <Row title="Genommen" trailing={<span className="num">{fmtDays(v.taken)}</span>} />
      <Row title="Geplant" trailing={<span className="num">{fmtDays(v.planned)}</span>} />
      <Row title={<strong>Übrig</strong>}
        trailing={<strong className={`num${left !== null && left < 0 ? " text-danger" : ""}`}>{fmtDays(left ?? 0)}</strong>} />
    </Section>
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
      vacation_days_per_year: vacationValue(f),
    });
    const role = String(f.get("role"));
    const location = String(f.get("location"));
    const userSave = await adminDb.from("users").update({ role, home_location_id: location }).eq("id", person.id);
    // Studioleitung leitet ihr Heimatstudio (Nachtragsrecht bleibt erhalten)
    let managerSave: { error: { message: string } | null } = { error: null };
    if (role === "manager" && !userSave.error) {
      managerSave = await adminDb
        .from("location_managers")
        .upsert({ user_id: person.id, location_id: location }, { onConflict: "user_id,location_id", ignoreDuplicates: true });
      if (!managerSave.error) {
        managerSave = await adminDb.from("location_managers").delete().eq("user_id", person.id).neq("location_id", location);
      }
    }
    setBusy(false);
    const failed = detailsSave.error ?? userSave.error ?? managerSave.error;
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
          <Field label="Urlaubstage pro Jahr" hint="Leer = noch nicht festgelegt">
            <input id="edit-vacation-days" name="vacation_days" type="number" min="0" max="365" step="0.5"
              defaultValue={details?.vacation_days_per_year ?? ""} />
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

function vacationValue(f: FormData): number | null {
  const raw = String(f.get("vacation_days") ?? "").trim();
  return raw === "" ? null : Number(raw.replace(",", "."));
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
      vacation_days_per_year: vacationValue(f),
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
          <Field label="Urlaubstage pro Jahr" hint="Optional">
            <input id="new-vacation-days" name="vacation_days" type="number" min="0" max="365" step="0.5" />
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
    // Ausgeschieden → kein Stempeln und kein Login mehr möglich
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
        {props.person.first_name} kann danach nicht mehr stempeln. Arbeitszeitnachweise bleiben erhalten.
      </Notice>
      {error && <Notice tone="error">{error}</Notice>}
    </Sheet>
  );
}
