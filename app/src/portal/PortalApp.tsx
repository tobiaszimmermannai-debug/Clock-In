// Handy-Portal für Mitarbeiter (nur lesen): Stunden, Dienstplan aller Studios, Schichttausch, Konto
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { AuthLayout } from "../admin/AdminApp";
import { Shell, type ShellTab } from "../components/Shell";
import { StudioCalendar } from "../components/StudioCalendar";
import { WeekPlan, useWeekShifts } from "../components/WeekPlan";
import { Field, Notice, PageHeader, Segmented, StudioFilter, WeekNav } from "../components/ui";
import { staffLoginEmail } from "../lib/config";
import { berlinDate, weekStart } from "../lib/dates";
import { registerStudios } from "../lib/studios";
import { portalDb } from "../lib/supabase";
import type { Location, Role } from "../lib/types";
import { Account } from "./Account";
import { Hours } from "./Hours";
import { Stamp } from "./Stamp";
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

type Tab = "stamp" | "hours" | "plan" | "swap" | "account";
const TABS: ShellTab<Tab>[] = [
  { id: "stamp", label: "Stempeln", icon: "qr" },
  { id: "hours", label: "Stunden", icon: "clock" },
  { id: "plan", label: "Dienstplan", icon: "calendar" },
  { id: "swap", label: "Tausch", icon: "swap" },
  { id: "account", label: "Konto", icon: "user" },
];

// stampToken: QR-Code vom Tablet, wenn die App über die Kamera-App geöffnet wurde (#/s/<code>)
export function PortalApp(props: { stampToken?: string }) {
  const [me, setMe] = useState<Me | null | undefined>(undefined); // undefined = lädt, null = abgemeldet
  const [colleagues, setColleagues] = useState<Colleague[]>([]);
  const [locations, setLocations] = useState<Location[]>([]);
  const [tab, setTab] = useState<Tab>("stamp");
  const [token, setToken] = useState(props.stampToken);

  useEffect(() => {
    if (!props.stampToken) return;
    setToken(props.stampToken);
    setTab("stamp");
  }, [props.stampToken]);
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
    registerStudios((locs.data ?? []) as Location[]);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (me === undefined) return <div className="screen center muted">Lädt …</div>;
  if (me === null) return <PortalLogin error={error} onDone={load} />;

  const logout = async () => {
    await portalDb.auth.signOut();
    setMe(null);
  };

  return (
    <Shell title="Clock-In" subtitle={`${me.first_name} ${me.last_name}`} tabs={TABS} current={tab} onTab={setTab}>
      {tab === "stamp" && (
        <Stamp
          me={me}
          token={token}
          onTokenUsed={() => {
            setToken(undefined);
            location.replace("#/portal"); // Code nicht erneut verwenden (Neuladen, Zurück-Taste)
          }}
        />
      )}
      {tab === "hours" && <Hours me={me} />}
      {tab === "plan" && <Plan me={me} locations={locations} />}
      {tab === "swap" && <Swap me={me} colleagues={colleagues} locations={locations} />}
      {tab === "account" && <Account me={me} onLogout={logout} />}
    </Shell>
  );
}

function Plan(props: { me: Me; locations: Location[] }) {
  const [start, setStart] = useState(weekStart(berlinDate()));
  const [studio, setStudio] = useState("");
  const [view, setView] = useState<"list" | "calendar">("list");
  const { shifts, error } = useWeekShifts(portalDb, start);
  return (
    <>
      <PageHeader
        title="Dienstplan"
        actions={
          <Segmented label="Ansicht" value={view} onChange={setView}
            options={[{ id: "list", label: "Liste" }, { id: "calendar", label: "Kalender" }]} />
        }
      />
      {view === "list" && <StudioFilter locations={props.locations} value={studio} onChange={setStudio} />}
      <WeekNav start={start} onChange={setStart} />
      {error && <Notice tone="error">{error}</Notice>}
      {view === "list"
        ? <WeekPlan start={start} shifts={shifts} studio={studio} highlightUserId={props.me.id} />
        : <StudioCalendar start={start} shifts={shifts} locations={props.locations} highlightUserId={props.me.id} />}
    </>
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
    <AuthLayout title="Clock-In" text="Deine Stunden, der Dienstplan und Schichttausch">
      <form className="panel form" onSubmit={submit}>
        <Field label="Benutzername">
          <input id="portal-username" name="username" autoComplete="username" autoCapitalize="none" spellCheck={false} required />
        </Field>
        <Field label="Passwort">
          <input id="portal-password" name="password" type="password" autoComplete="current-password" required />
        </Field>
        {error && <Notice tone="error">{error}</Notice>}
        <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? "Anmelden …" : "Anmelden"}</button>
      </form>
      <p className="auth-foot muted">Zugangsdaten bekommst du von Tobias oder Dominik.</p>
    </AuthLayout>
  );
}
