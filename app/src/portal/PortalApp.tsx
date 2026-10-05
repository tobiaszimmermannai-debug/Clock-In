// Handy-Portal für Mitarbeiter (nur lesen): Stunden, Dienstplan aller Studios, Schichttausch, Konto
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { WeekPlan, useWeekShifts } from "../components/WeekPlan";
import { StudioFilter, WeekNav } from "../components/ui";
import { staffLoginEmail } from "../lib/config";
import { berlinDate, weekStart } from "../lib/dates";
import { portalDb } from "../lib/supabase";
import type { Location, Role } from "../lib/types";
import { Account } from "./Account";
import { Hours } from "./Hours";
import { Swap } from "./Swap";

export type Me = {
  id: string;
  first_name: string;
  last_name: string;
  role: Role;
  home_location_id: string | null;
  employment_details: { weekly_target_minutes: number; work_days_per_week: number } | null;
};
export type Colleague = { id: string; first_name: string; last_name: string; home_location_id: string | null };

type Tab = "hours" | "plan" | "swap" | "account";
const TABS: { id: Tab; label: string }[] = [
  { id: "hours", label: "Stunden" },
  { id: "plan", label: "Dienstplan" },
  { id: "swap", label: "Tausch" },
  { id: "account", label: "Konto" },
];

export function PortalApp() {
  const [me, setMe] = useState<Me | null | undefined>(undefined); // undefined = lädt, null = abgemeldet
  const [colleagues, setColleagues] = useState<Colleague[]>([]);
  const [locations, setLocations] = useState<Location[]>([]);
  const [tab, setTab] = useState<Tab>("hours");
  const [error, setError] = useState<string>();

  const load = useCallback(async () => {
    const { data } = await portalDb.auth.getSession();
    if (!data.session) return setMe(null);
    const [profile, people, locs] = await Promise.all([
      portalDb
        .from("users")
        .select("id, first_name, last_name, role, home_location_id, employment_details(weekly_target_minutes, work_days_per_week)")
        .eq("auth_user_id", data.session.user.id)
        .maybeSingle(),
      portalDb.from("users").select("id, first_name, last_name, home_location_id").eq("is_active", true).order("first_name"),
      portalDb.from("locations").select("id, code, name").eq("is_active", true).order("name"),
    ]);
    if (!profile.data) {
      await portalDb.auth.signOut();
      setError("Für dieses Konto ist kein Mitarbeiter hinterlegt.");
      return setMe(null);
    }
    setMe(profile.data as unknown as Me);
    setColleagues((people.data ?? []) as Colleague[]);
    setLocations((locs.data ?? []) as Location[]);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (me === undefined) return <div className="screen center muted">Lädt …</div>;
  if (me === null) return <PortalLogin error={error} onDone={load} />;

  return (
    <div className="screen portal">
      <header className="admin-bar">
        <strong>Hallo {me.first_name}</strong>
        <span className="muted small">Clock-In</span>
      </header>
      <main className="admin-main">
        {tab === "hours" && <Hours me={me} />}
        {tab === "plan" && <Plan me={me} locations={locations} />}
        {tab === "swap" && <Swap me={me} colleagues={colleagues} locations={locations} />}
        {tab === "account" && (
          <Account
            me={me}
            onLogout={async () => {
              await portalDb.auth.signOut();
              setMe(null);
            }}
          />
        )}
      </main>
      <nav className="bottom-nav" aria-label="Bereiche">
        {TABS.map((t) => (
          <button key={t.id} type="button" aria-pressed={tab === t.id} onClick={() => setTab(t.id)}>{t.label}</button>
        ))}
      </nav>
    </div>
  );
}

function Plan(props: { me: Me; locations: Location[] }) {
  const [start, setStart] = useState(weekStart(berlinDate()));
  const [studio, setStudio] = useState("");
  const { shifts, error } = useWeekShifts(portalDb, start);
  return (
    <section className="stack">
      <h1>Dienstplan</h1>
      <WeekNav start={start} onChange={setStart} />
      <StudioFilter locations={props.locations} value={studio} onChange={setStudio} />
      {error && <p className="form-error">{error}</p>}
      <WeekPlan start={start} shifts={shifts} studio={studio} highlightUserId={props.me.id} />
    </section>
  );
}

function PortalLogin(props: { error?: string; onDone: () => void }) {
  const [error, setError] = useState(props.error);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setBusy(true);
    const { error } = await portalDb.auth.signInWithPassword({
      email: staffLoginEmail(String(form.get("username"))),
      password: String(form.get("password")),
    });
    setBusy(false);
    if (error) return setError("Anmeldung fehlgeschlagen. Benutzername oder Passwort falsch.");
    props.onDone();
  }

  return (
    <div className="screen setup">
      <form className="card form" onSubmit={submit}>
        <h1>Mitarbeiter-Login</h1>
        <p className="muted">Benutzername und Passwort bekommst du von Tobias oder Dominik.</p>
        <label>
          Benutzername
          <input id="portal-username" name="username" autoComplete="username" autoCapitalize="none" spellCheck={false} required />
        </label>
        <label>
          Passwort
          <input id="portal-password" name="password" type="password" autoComplete="current-password" required />
        </label>
        {error && <p className="form-error">{error}</p>}
        <button type="submit" className="btn-primary" disabled={busy}>{busy ? "Anmelden …" : "Anmelden"}</button>
      </form>
    </div>
  );
}
