// Handy-Portal für Mitarbeiter (nur lesen): Stunden, Dienstplan aller Studios, Schichttausch, Konto
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { AuthLayout } from "../admin/AdminApp";
import { Shell, type ShellTab } from "../components/Shell";
import { StudioCalendar } from "../components/StudioCalendar";
import { TaskReminder } from "../components/TaskReminder";
import { Tasks } from "../components/Tasks";
import { WeekPlan, useWeekShifts } from "../components/WeekPlan";
import { Field, Notice, PageHeader, Segmented, Sheet, StudioFilter, WeekNav } from "../components/ui";
import { staffLoginEmail } from "../lib/config";
import { berlinDate, weekStart } from "../lib/dates";
import { registerStudios } from "../lib/studios";
import { portalDb } from "../lib/supabase";
import type { Location, Role } from "../lib/types";
import { Account } from "./Account";
import { Hours } from "./Hours";
import { Stamp } from "./Stamp";
import { MyWishes } from "./ShiftWishes";
import { PcUnlock } from "./PcUnlock";
import { ErrorBoundary } from "../components/ErrorBoundary";
import { Knowledge } from "./Knowledge";
import { QrLoginConfirm } from "./QrLoginConfirm";
import { Swap } from "./Swap";
import { useWishes } from "../lib/wishes";

export type Me = {
  id: string;
  first_name: string;
  last_name: string;
  role: Role;
  home_location_id: string | null;
  employment_details: { weekly_target_minutes: number; work_days_per_week: number } | null;
  /** false = ohne Zeiterfassung (z. B. Praktikum): nur Dienstplan, Aufgaben, Konto */
  time_tracking?: boolean;
};
export type Colleague = { id: string; first_name: string; last_name: string; home_location_id: string | null };

type Tab = "stamp" | "hours" | "plan" | "knowledge" | "tasks" | "account";
const TABS: ShellTab<Tab>[] = [
  { id: "stamp", label: "Stempeln", icon: "qr" },
  { id: "hours", label: "Stunden", icon: "clock" },
  { id: "plan", label: "Dienstplan", icon: "calendar" },
  { id: "knowledge", label: "Wissen", icon: "book" },
  { id: "tasks", label: "Aufgaben", icon: "tasks" },
  { id: "account", label: "Konto", icon: "user" },
];

// stampToken: QR-Code vom Tablet, wenn die App über die Kamera-App geöffnet wurde (#/s/<code>)
export function PortalApp(props: { stampToken?: string; pcToken?: string; qrToken?: string }) {
  const [me, setMe] = useState<Me | null | undefined>(undefined); // undefined = lädt, null = abgemeldet
  const [colleagues, setColleagues] = useState<Colleague[]>([]);
  const [locations, setLocations] = useState<Location[]>([]);
  const [tab, setTab] = useState<Tab>("stamp");
  const [token, setToken] = useState(props.stampToken);
  const [reminderDay, setReminderDay] = useState(() => {
    try {
      return localStorage.getItem("clockin-task-reminder") ?? "";
    } catch {
      return "";
    }
  });
  const closeReminder = () => {
    const day = berlinDate();
    setReminderDay(day);
    try {
      localStorage.setItem("clockin-task-reminder", day);
    } catch {
      /* egal */
    }
  };

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
        // * statt Spaltenliste: neue Spalten (time_tracking) brechen das Laden nicht, falls das SQL noch fehlt
        .select("*, employment_details(weekly_target_minutes, work_days_per_week)")
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
    const meData = profile.data as unknown as Me;
    setMe(meData);
    // Ohne Zeiterfassung: kein Stempeln/Stunden/Tausch – direkt zu den Aufgaben
    if (meData.time_tracking === false) setTab((t) => (t === "stamp" || t === "hours" ? "tasks" : t));
    setColleagues((people.data ?? []) as Colleague[]);
    setLocations((locs.data ?? []) as Location[]);
    registerStudios((locs.data ?? []) as Location[]);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Erinnerung an offene Aufgaben: einmal am Tag beim Öffnen (nicht mitten im Stempeln per QR)
  const showReminder = Boolean(me) && !props.stampToken && !props.pcToken && !props.qrToken && reminderDay !== berlinDate();

  if (me === undefined) return <div className="screen center muted">Lädt …</div>;
  if (me === null) return <PortalLogin error={error} onDone={load} />;

  const logout = async () => {
    await portalDb.auth.signOut();
    setMe(null);
  };

  return (
    <Shell
      title="Clock-In"
      subtitle={`${me.first_name} ${me.last_name}`}
      tabs={me.time_tracking === false ? TABS.filter((t) => t.id === "plan" || t.id === "knowledge" || t.id === "tasks" || t.id === "account") : TABS}
      current={tab}
      onTab={setTab}
      full={tab === "tasks"}
    >
      {props.pcToken && <PcUnlock me={me} token={props.pcToken} onDone={() => location.replace("#/portal")} />}
      {props.qrToken && <QrLoginConfirm me={me} token={props.qrToken} onDone={() => location.replace("#/portal")} />}
      {tab === "stamp" && !props.pcToken && !props.qrToken && (
        <Stamp
          me={me}
          token={token}
          onOpenVacation={() => setTab("account")}
          onOpenTasks={() => setTab("tasks")}
          onTokenUsed={() => {
            setToken(undefined);
            location.replace("#/portal"); // Code nicht erneut verwenden (Neuladen, Zurück-Taste)
          }}
        />
      )}
      {tab === "hours" && <Hours me={me} />}
      {tab === "plan" && <Plan me={me} locations={locations} colleagues={colleagues} />}
      {tab === "knowledge" && <Knowledge />}
      {tab === "tasks" && <ErrorBoundary label="Aufgaben"><Tasks db={portalDb} /></ErrorBoundary>}
      {tab === "account" && <Account me={me} onLogout={logout} />}
      {showReminder && tab !== "tasks" && (
        <Sheet title="Deine Aufgaben heute" onClose={closeReminder}>
          <TaskReminder
            db={portalDb}
            reason="login"
            onOpen={() => {
              closeReminder();
              setTab("tasks");
            }}
            onClose={closeReminder}
          />
        </Sheet>
      )}
    </Shell>
  );
}

// Dienstplan mit Schichttausch (früher eigener Reiter „Tausch“)
function Plan(props: { me: Me; locations: Location[]; colleagues: Colleague[] }) {
  const canSwap = props.me.time_tracking !== false;
  const [mode, setMode] = useState<"plan" | "swap">("plan");
  const [view, setView] = useState<"list" | "calendar">("list");
  return (
    <>
      <PageHeader
        title="Dienstplan"
        actions={mode === "plan" ? (
          <Segmented label="Ansicht" value={view} onChange={setView}
            options={[{ id: "list", label: "Liste" }, { id: "calendar", label: "Kalender" }]} />
        ) : undefined}
      />
      {canSwap && (
        <Segmented label="Bereich" value={mode} onChange={setMode} fill
          options={[{ id: "plan", label: "Dienstplan" }, { id: "swap", label: "Schichttausch" }]} />
      )}
      {mode === "swap" && canSwap
        ? <Swap me={props.me} colleagues={props.colleagues} locations={props.locations} embedded />
        : <PlanView me={props.me} locations={props.locations} view={view} />}
    </>
  );
}

function PlanView(props: { me: Me; locations: Location[]; view: "list" | "calendar" }) {
  const [start, setStart] = useState(weekStart(berlinDate()));
  const [studio, setStudio] = useState("");
  const { view } = props;
  const { shifts, error, blockOf } = useWeekShifts(portalDb, start);
  const wishes = useWishes(portalDb, start);
  return (
    <>
      {view === "list" && <StudioFilter locations={props.locations} value={studio} onChange={setStudio} />}
      <WeekNav start={start} onChange={setStart} />
      {error && <Notice tone="error">{error}</Notice>}
      {view === "list"
        ? <WeekPlan start={start} shifts={shifts} studio={studio} highlightUserId={props.me.id} blockOf={blockOf} />
        : <StudioCalendar start={start} shifts={shifts} locations={props.locations} highlightUserId={props.me.id} blockOf={blockOf}
            wishes={wishes.wishes.filter((w) => w.status === "open")} slots={wishes.slots} />}
      <MyWishes me={props.me} locations={props.locations} onChanged={() => void wishes.reload()} />
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
