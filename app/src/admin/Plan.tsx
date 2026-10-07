// Dienstplan schreiben: Studio → Woche → Tag antippen → „Eintragen“ → Art (Dropdown, Standard Studio-Schicht):
// Studio-Schicht · Aushilfe anfragen · Aushilfe stellen · Akquise · Urlaub · Krank · Schule.
// Studioleitung plant nur ihr eigenes Studio; wer an dem Tag schon eingetragen ist, fällt aus der Auswahl.
// Ausnahmen: Akquise und angefragte Aushilfe – dafür dürfen eigene Leute auch in andere Studios.
// Krank: geplante Schicht tauschen (ganz oder ab Uhrzeit) oder ganzer Tag ohne Schicht – Studioleitung und Admin.
import { type CSSProperties, useCallback, useEffect, useState } from "react";
import { StudioCalendar } from "../components/StudioCalendar";
import { type PlanShift, ShiftRow, isHelpShift, isSickSwap, useWeekShifts } from "../components/WeekPlan";
import { Avatar, DayStrip, Empty, Field, Icon, Notice, PageHeader, Row, Section, Segmented, Sheet, StudioFilter, WeekNav } from "../components/ui";
import { absenceDays, addDays, berlinDate, berlinTime, berlinToISO, fmtDay, fmtHM, fmtLongDay, weekStart } from "../lib/dates";
import { dbMessage } from "../lib/errors";
import { registerStudios, studioColor } from "../lib/studios";
import { adminDb } from "../lib/supabase";
import { ABSENCE_WEEK_DAYS, type Location, ROLE_LABEL, type Role, SHIFT_TYPE_LABEL, type ShiftType, studioShort } from "../lib/types";
import type { Profile } from "./AdminApp";

type Staffer = {
  id: string;
  first_name: string;
  last_name: string;
  role: Role;
  home_location_id: string | null;
  employment_details: { weekly_target_minutes: number } | null;
};

// Urlaub/Schule: Ganztags-Eintrag mit 6,5 Std. – Azubis je Tag Wochenstunden ÷ 5,25 (rechnet die Datenbank)
const ABSENCE_TIMES = { from: "08:00", to: "14:30" };
const MAX_ABSENCE_DAYS = 62;

type Category = "work" | "help_request" | "help_fill" | "acq" | "vacation" | "sick" | "vocational_school";
const CATEGORIES: { id: Category; label: string }[] = [
  { id: "work", label: "Studio-Schicht" },
  { id: "help_request", label: "Aushilfe anfragen" },
  { id: "help_fill", label: "Aushilfe stellen (für anderes Studio)" },
  { id: "acq", label: "Akquise" },
  { id: "vacation", label: "Urlaub" },
  { id: "sick", label: "Krank" },
  { id: "vocational_school", label: "Schule" },
];
const SHEET_TITLE: Record<Category, string> = {
  work: "Studio-Schicht",
  help_request: "Aushilfe anfragen",
  help_fill: "Aushilfe stellen",
  acq: "Akquise eintragen",
  vacation: "Urlaub eintragen",
  sick: "Krank eintragen",
  vocational_school: "Schule eintragen",
};
type Vacation = { user_id: string; allowance: number | null; taken: number; planned: number };
type HelpRequest = { id: string; location_id: string; starts_at: string; ends_at: string; note: string | null; location: { name: string } | null };
type SheetState = { shift?: PlanShift; category?: Category; requestId?: string };
// Gutschrift zur Anzeige: minutes = Dauer des Eintrags, share = Anteil am Tag (Krank ab Uhrzeit)
type Credit = { minutes?: number; trainee: boolean };
type CreditOf = (userId: string, minutes: number, share: number) => Credit;
const TRAINEE_RULE = `Azubi: Wochenstunden ÷ ${String(ABSENCE_WEEK_DAYS).replace(".", ",")}`;
// Zuletzt eingetragene Zeiten als Vorschlag für die nächste Schicht
let lastTimes = { from: "09:00", to: "15:30" };

const minutesBetween = (from: string, to: string) => {
  const [fh, fm] = from.split(":").map(Number);
  const [th, tm] = to.split(":").map(Number);
  return th * 60 + tm - (fh * 60 + fm);
};
const fullName = (p: { first_name: string; last_name: string }) => `${p.first_name} ${p.last_name}`;
const durationMinutes = (s: { starts_at: string; ends_at: string }) => Math.round((Date.parse(s.ends_at) - Date.parse(s.starts_at)) / 60_000);

// Offene Aushilfe-Anfragen aller Studios (ab jetzt) – sehen alle
function useHelpRequests() {
  const [requests, setRequests] = useState<HelpRequest[]>([]);
  const reload = useCallback(async () => {
    const { data } = await adminDb
      .from("help_requests")
      .select("id, location_id, starts_at, ends_at, note, location:locations(name)")
      .eq("status", "open")
      .gt("ends_at", new Date().toISOString())
      .order("starts_at")
      .limit(30);
    setRequests((data ?? []) as unknown as HelpRequest[]);
  }, []);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { requests, reload };
}

export function Plan({ profile }: { profile: Profile }) {
  const today = berlinDate();
  const [start, setStart] = useState(weekStart(today));
  const [day, setDay] = useState(today);
  const [locations, setLocations] = useState<Location[] | null>(null);
  const [allLocations, setAllLocations] = useState<Location[]>([]);
  const [managed, setManaged] = useState<Set<string>>(new Set());
  const [view, setView] = useState<"plan" | "all">("plan");
  const [studio, setStudio] = useState("");
  const [people, setPeople] = useState<Staffer[]>([]);
  const [sheet, setSheet] = useState<SheetState | null>(null);
  const [flash, setFlash] = useState<string>();
  const { shifts, error, reload } = useWeekShifts(adminDb, start);
  const help = useHelpRequests();

  useEffect(() => {
    void (async () => {
      const [users, locs, managed] = await Promise.all([
        adminDb.from("users").select("id, first_name, last_name, role, home_location_id, employment_details(weekly_target_minutes)").eq("is_active", true).neq("role", "admin").order("first_name"),
        adminDb.from("locations").select("id, code, name").eq("is_active", true).order("name"),
        adminDb.from("location_managers").select("location_id").eq("user_id", profile.id),
      ]);
      const mine = new Set((managed.data ?? []).map((m) => m.location_id as string));
      const all = (locs.data ?? []) as Location[];
      registerStudios(all);
      // Admin plant alle Studios, Studioleitung nur die eigenen
      const allowed = all.filter((l) => profile.role === "admin" || mine.has(l.id));
      setPeople((users.data ?? []) as unknown as Staffer[]);
      setAllLocations(all);
      setManaged(mine);
      setLocations(allowed);
      setStudio(allowed[0]?.id ?? "");
    })();
  }, [profile.id, profile.role]);

  function goWeek(next: string) {
    setStart(next);
    setDay(next <= today && today < addDays(next, 7) ? today : next);
  }

  if (locations === null) return <p className="muted">Lädt …</p>;
  if (locations.length === 0) {
    return (
      <>
        <PageHeader title="Dienstplan" />
        <Notice tone="warn">Dir ist noch kein Studio zugeordnet. Bitte Tobias oder Dominik fragen.</Notice>
      </>
    );
  }

  const isAdmin = profile.role === "admin";
  const studioName = studioShort(locations.find((l) => l.id === studio)?.name ?? "");
  // Eigene Leute bleiben sichtbar – auch mit Abwesenheit oder Akquise in einem anderen Studio
  const inStudio = (s: PlanShift) =>
    s.location_id === studio || ((s.location_id === null || !!s.is_acquisition) && s.user?.home_location_id === studio);
  const counts: Record<string, number> = {};
  for (const s of shifts) if (inStudio(s)) counts[berlinDate(s.starts_at)] = (counts[berlinDate(s.starts_at)] ?? 0) + 1;
  const dayEntries = shifts.filter((s) => berlinDate(s.starts_at) === day && inStudio(s));
  // Wer an diesem Tag schon irgendwo eingetragen ist, kann nicht erneut gewählt werden
  const taken = new Set(shifts.filter((s) => berlinDate(s.starts_at) === day).map((s) => s.user_id));

  const done = (text: string) => {
    setSheet(null);
    setFlash(text);
    void reload();
    void help.reload();
  };

  // „Stellen“: zum Tag der Anfrage springen und Sheet „Aushilfe stellen“ öffnen
  function fillRequest(r: HelpRequest) {
    const d = berlinDate(r.starts_at);
    setStart(weekStart(d));
    setDay(d);
    setView("plan");
    setFlash(undefined);
    setSheet({ category: "help_fill", requestId: r.id });
  }
  async function cancelRequest(r: HelpRequest) {
    const { error } = await adminDb.from("help_requests").delete().eq("id", r.id);
    setFlash(error ? dbMessage(error) : "Aushilfe-Anfrage zurückgezogen.");
    void help.reload();
  }
  const helpBoard = (
    <HelpBoard requests={help.requests} isOwn={(id) => id === studio} onFill={fillRequest} onCancel={(r) => void cancelRequest(r)} />
  );
  const dayRequests = help.requests.filter((r) => r.location_id === studio && berlinDate(r.starts_at) === day);

  const canEdit = (s: PlanShift) =>
    isAdmin ||
    managed.has(s.location_id ?? s.user?.home_location_id ?? "") ||
    (!!s.is_acquisition && managed.has(s.user?.home_location_id ?? ""));
  // Krank setzen: Schichten im eigenen Studio und alle Schichten der eigenen Leute (auch die eigene); Admin alles
  const canSick = (s: PlanShift) => s.shift_type === "work" && (canEdit(s) || managed.has(s.user?.home_location_id ?? ""));
  const sickCandidates = shifts.filter((s) =>
    berlinDate(s.starts_at) === day && (inStudio(s) || s.user?.home_location_id === studio) && canSick(s));
  // Gutschrift (Anzeige): Azubis Wochenstunden ÷ 5,25 je Tag, sonst Dauer des Eintrags
  const creditOf: CreditOf = (userId, minutes, share) => {
    const p = people.find((x) => x.id === userId);
    if (p?.role !== "trainee") return { minutes, trainee: false };
    const weekly = p.employment_details?.weekly_target_minutes;
    return { minutes: weekly == null ? undefined : Math.round((weekly / ABSENCE_WEEK_DAYS) * share), trainee: true };
  };
  const editSheet = (shift: PlanShift) => (
    <EditShift shift={shift} canPlanNormal={isAdmin || managed.has(shift.location_id ?? "")} canSick={canSick(shift)}
      creditOf={creditOf} onClose={() => setSheet(null)} onSaved={done} />
  );
  const viewSwitch = (
    <Segmented
      label="Ansicht"
      value={view}
      onChange={setView}
      options={[{ id: "plan", label: "Planen" }, { id: "all", label: "Alle Studios" }]}
    />
  );

  if (view === "all") {
    return (
      <>
        <PageHeader title="Dienstplan" subtitle="Alle Studios" actions={viewSwitch} />
        <WeekNav start={start} onChange={goWeek} />
        {error && <Notice tone="error">{error}</Notice>}
        {flash && <Notice tone="ok">{flash}</Notice>}
        {helpBoard}
        <StudioCalendar
          start={start}
          shifts={shifts}
          locations={allLocations}
          canEdit={canEdit}
          onSelect={(s) => setSheet({ shift: s })}
        />
        {sheet?.shift && editSheet(sheet.shift)}
      </>
    );
  }

  return (
    <>
      <PageHeader title="Dienstplan" subtitle={locations.length === 1 ? `Studio ${studioName}` : undefined} actions={viewSwitch} />
      {locations.length > 1 && <StudioFilter all={false} locations={locations} value={studio} onChange={setStudio} />}
      <WeekNav start={start} onChange={goWeek} />
      <DayStrip start={start} value={day} onChange={(d) => { setDay(d); setFlash(undefined); }} counts={counts} />
      {error && <Notice tone="error">{error}</Notice>}
      {flash && <Notice tone="ok">{flash}</Notice>}
      {helpBoard}

      <Section title={fmtLongDay(day)} aside={<span>{dayEntries.length} {dayEntries.length === 1 ? "Eintrag" : "Einträge"}</span>}>
        {dayEntries.length === 0 && dayRequests.length === 0 && <p className="list-empty">Noch niemand eingetragen.</p>}
        {dayEntries.map((s) => <ShiftRow key={s.id} shift={s} onClick={() => setSheet({ shift: s })} />)}
        {dayRequests.map((r) => (
          <Row key={r.id} className="is-request" leading={<span className="avatar avatar-request" aria-hidden="true">?</span>}
            title="Aushilfe gesucht" subtitle={r.note ?? "Anfrage an alle Studios"}
            trailing={<strong className="num">{berlinTime(r.starts_at)}–{berlinTime(r.ends_at)}</strong>} />
        ))}
      </Section>
      <button type="button" className="btn btn-primary btn-block" onClick={() => setSheet({})}>
        <Icon name="plus" size={20} /> Eintragen
      </button>

      {sheet && !sheet.shift && (
        <AddShift
          day={day}
          studio={studio}
          studioName={studioName}
          locations={allLocations}
          canPlanAt={(id) => isAdmin || managed.has(id)}
          people={people}
          taken={taken}
          sickCandidates={sickCandidates}
          helpRequests={help.requests.filter((r) => r.location_id !== studio && berlinDate(r.starts_at) === day)}
          initialCategory={sheet.category}
          initialRequestId={sheet.requestId}
          creditOf={creditOf}
          onClose={() => setSheet(null)}
          onSaved={done}
        />
      )}
      {sheet?.shift && editSheet(sheet.shift)}
    </>
  );
}

// Offene Anfragen: eigenes Studio → zurückziehen, andere Studios → Aushilfe stellen
function HelpBoard(props: {
  requests: HelpRequest[];
  isOwn: (locationId: string) => boolean;
  onFill: (r: HelpRequest) => void;
  onCancel: (r: HelpRequest) => void;
}) {
  if (props.requests.length === 0) return null;
  return (
    <Section title="Aushilfe gesucht" aside={<span>{props.requests.length}</span>}
      footer="Mit „Stellen“ trägst du einen eigenen Mitarbeiter direkt im anfragenden Studio ein.">
      {props.requests.map((r) => {
        const own = props.isOwn(r.location_id);
        return (
          <Row
            key={r.id}
            className="has-studio"
            style={{ "--studio": studioColor(r.location_id) } as CSSProperties}
            title={`${studioShort(r.location?.name ?? "")} sucht Aushilfe`}
            subtitle={`${fmtDay(berlinDate(r.starts_at))} · ${berlinTime(r.starts_at)}–${berlinTime(r.ends_at)} Uhr${r.note ? ` · ${r.note}` : ""}`}
            trailing={own
              ? <button type="button" className="btn btn-outline btn-sm" onClick={() => props.onCancel(r)}>Zurückziehen</button>
              : <button type="button" className="btn btn-primary btn-sm" onClick={() => props.onFill(r)}>Stellen</button>}
          />
        );
      })}
    </Section>
  );
}

function TimeFields(props: { from: string; to: string; onFrom: (v: string) => void; onTo: (v: string) => void }) {
  const minutes = minutesBetween(props.from, props.to);
  return (
    <div className="grid-2">
      <Field label="Von"><input id="shift-from" type="time" value={props.from} onChange={(e) => props.onFrom(e.target.value)} required /></Field>
      <Field label="Bis" hint={minutes > 0 ? `Dauer ${fmtHM(minutes)} Std.` : "Ende muss nach Beginn liegen"}>
        <input id="shift-to" type="time" value={props.to} onChange={(e) => props.onTo(e.target.value)} required />
      </Field>
    </div>
  );
}

function SwitchRow(props: { title: string; subtitle?: string; checked: boolean; onChange: (on: boolean) => void }) {
  return (
    <div className="list">
      <label className="list-row">
        <span className="list-row-main">
          <span className="list-row-title">{props.title}</span>
          {props.subtitle && <span className="list-row-sub">{props.subtitle}</span>}
        </span>
        <input type="checkbox" role="switch" className="switch" checked={props.checked} onChange={(e) => props.onChange(e.target.checked)} />
      </label>
    </div>
  );
}

// Krank: ganze Schicht oder ab Uhrzeit – davor Gearbeitetes bleibt Arbeitszeit
function SickChoice(props: { shift: PlanShift; creditOf: CreditOf; from: string | null; onChange: (from: string | null) => void }) {
  const start = berlinTime(props.shift.starts_at);
  const end = berlinTime(props.shift.ends_at);
  const sickMinutes = props.from ? minutesBetween(props.from, end) : durationMinutes(props.shift);
  const valid = !props.from || (minutesBetween(start, props.from) > 0 && sickMinutes > 0);
  const credit = props.creditOf(props.shift.user_id, sickMinutes, sickMinutes / durationMinutes(props.shift));
  return (
    <>
      <Segmented
        label="Krank"
        value={props.from === null ? "all" : "from"}
        onChange={(v) => props.onChange(v === "all" ? null : props.from ?? suggestSickFrom(props.shift))}
        options={[{ id: "all", label: "Ganze Schicht" }, { id: "from", label: "Ab Uhrzeit" }]}
      />
      {props.from !== null && (
        <Field label="Krank ab" hint={valid ? undefined : `Zwischen ${start} und ${end} Uhr`}>
          <input id="sick-from" type="time" value={props.from} onChange={(e) => props.onChange(e.target.value)} required />
        </Field>
      )}
      {valid && (
        <Notice>
          Krank {props.from ?? start}–{end} Uhr: {credit.minutes === undefined
            ? <>gutgeschrieben wird {props.from ? "anteilig " : ""}der Tagesanteil ({TRAINEE_RULE}).</>
            : <><strong>{fmtHM(credit.minutes)} Std.</strong> werden gutgeschrieben
              {credit.trainee && ` (${TRAINEE_RULE}${props.from ? ", anteilig" : ""})`}.</>}
          {props.from && ` ${start}–${props.from} Uhr bleibt Arbeitszeit (es zählen die Stempelzeiten).`}
        </Notice>
      )}
    </>
  );
}

// Vorschlag „Krank ab“: jetzt (auf 15 Min. abgerundet), wenn die Schicht gerade läuft
function suggestSickFrom(shift: PlanShift): string {
  const now = Date.now();
  if (now <= Date.parse(shift.starts_at) || now >= Date.parse(shift.ends_at)) return berlinTime(shift.starts_at);
  const [h, m] = berlinTime(new Date(now)).split(":").map(Number);
  return `${String(h).padStart(2, "0")}:${String(m - (m % 15)).padStart(2, "0")}`;
}

function sickValid(shift: PlanShift, from: string | null) {
  if (from === null) return true;
  return minutesBetween(berlinTime(shift.starts_at), from) > 0 && minutesBetween(from, berlinTime(shift.ends_at)) > 0;
}

async function reportSick(shift: PlanShift, from: string | null) {
  const { error } = await adminDb.rpc("report_sick", {
    p_shift_id: shift.id,
    p_from: from ? berlinToISO(berlinDate(shift.starts_at), from) : null,
  });
  return { error, text: `${shift.user ? fullName(shift.user) : "?"}: krank ${from ?? berlinTime(shift.starts_at)}–${berlinTime(shift.ends_at)} Uhr eingetragen.` };
}

function AddShift(props: {
  day: string;
  studio: string;
  studioName: string;
  locations: Location[];
  canPlanAt: (locationId: string) => boolean;
  people: Staffer[];
  taken: Set<string>;
  sickCandidates: PlanShift[];
  helpRequests: HelpRequest[];
  initialCategory?: Category;
  initialRequestId?: string;
  creditOf: CreditOf;
  onClose: () => void;
  onSaved: (text: string) => void;
}) {
  const [cat, setCat] = useState<Category>(props.initialCategory ?? "work");
  const [requestId, setRequestId] = useState(props.initialRequestId ?? "");
  const [note, setNote] = useState("");
  const [userId, setUserId] = useState("");
  const [from, setFrom] = useState(lastTimes.from);
  const [to, setTo] = useState(lastTimes.to);
  const [acqStudio, setAcqStudio] = useState(props.studio);
  const [until, setUntil] = useState(props.day);
  const [saturdays, setSaturdays] = useState(false);
  const [sickShiftId, setSickShiftId] = useState("");
  const [sickFrom, setSickFrom] = useState<string | null>(null);
  // Krank: geplante Schicht tauschen oder ganzer Tag (ohne Schicht)
  const [sickMode, setSickMode] = useState<"swap" | "day">(props.sickCandidates.length ? "swap" : "day");
  const [vacation, setVacation] = useState<Record<string, Vacation>>({});
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const isAcq = cat === "acq";
  const isWork = cat === "work" || isAcq;
  const isHelpReq = cat === "help_request";
  const isHelpFill = cat === "help_fill";
  const isSwap = cat === "sick" && sickMode === "swap";
  const isAbsence = cat === "vacation" || cat === "vocational_school" || (cat === "sick" && sickMode === "day");
  const location = isAcq ? acqStudio : props.studio;
  const locationName = studioShort(props.locations.find((l) => l.id === location)?.name ?? props.studioName);
  // Akquise in einem fremden Studio: nur eigene Leute (normale Schichten dort plant die dortige Leitung)
  const foreign = isAcq && !props.canPlanAt(acqStudio);
  const year = Number(props.day.slice(0, 4));

  useEffect(() => {
    void adminDb.rpc("vacation_overview", { p_year: year }).then(({ data }) => {
      setVacation(Object.fromEntries(((data ?? []) as Vacation[]).map((v) => [v.user_id, v])));
    });
  }, [year]);

  const free = props.people.filter((p) => !props.taken.has(p.id));
  const own = free.filter((p) => p.home_location_id === props.studio);
  // Aushilfen aus anderen Studios nur für Schichten (Abwesenheiten trägt das Heimatstudio ein)
  const others = isWork
    ? free.filter((p) => p.home_location_id !== props.studio && (!foreign || props.canPlanAt(p.home_location_id ?? "")))
    : [];
  const person = [...own, ...others].find((p) => p.id === userId);
  const days = absenceDays(props.day, until, saturdays);
  const sickShift = props.sickCandidates.find((s) => s.id === sickShiftId);
  const request = props.helpRequests.find((r) => r.id === requestId);

  const vacationLeft = (id: string) => {
    const v = vacation[id];
    return v && v.allowance !== null ? Number(v.allowance) - v.taken - v.planned : null;
  };
  const vacationHint = (id: string) => {
    const left = vacationLeft(id);
    return left === null ? "Kein Urlaubsanspruch hinterlegt" : `Urlaub ${year}: ${left} von ${Number(vacation[id].allowance)} Tagen übrig`;
  };

  function choose(next: Category) {
    setCat(next);
    setUserId("");
    setSickShiftId("");
    setRequestId("");
    setSickFrom(null);
    setSickMode(props.sickCandidates.length ? "swap" : "day");
    setAcqStudio(props.studio);
    setError(undefined);
  }

  async function save() {
    setError(undefined);
    if (isSwap) {
      if (!sickShift || !sickValid(sickShift, sickFrom)) return;
      setBusy(true);
      const { error, text } = await reportSick(sickShift, sickFrom);
      setBusy(false);
      return error ? setError(dbMessage(error)) : props.onSaved(text);
    }
    if (isHelpReq) {
      if (minutesBetween(from, to) <= 0) return setError("Das Ende muss nach dem Beginn liegen.");
      setBusy(true);
      const { error } = await adminDb.from("help_requests").insert({
        location_id: props.studio,
        starts_at: berlinToISO(props.day, from),
        ends_at: berlinToISO(props.day, to),
        note: note.trim() || null,
      });
      setBusy(false);
      if (error) return setError(dbMessage(error));
      return props.onSaved(`Aushilfe angefragt: ${fmtDay(props.day)}, ${from}–${to} Uhr – alle Studios sehen die Anfrage.`);
    }
    if (!person) return;
    if (isHelpFill) {
      if (!request) return;
      setBusy(true);
      const { error } = await adminDb.rpc("fill_help_request", { p_request_id: request.id, p_user_id: person.id });
      setBusy(false);
      if (error) return setError(dbMessage(error));
      return props.onSaved(
        `${fullName(person)} hilft in ${studioShort(request.location?.name ?? "")} aus: ${fmtDay(props.day)}, ` +
          `${berlinTime(request.starts_at)}–${berlinTime(request.ends_at)} Uhr.`,
      );
    }
    if (isWork) {
      if (minutesBetween(from, to) <= 0) return setError("Das Ende muss nach dem Beginn liegen.");
      setBusy(true);
      const { error } = await adminDb.from("shifts").insert({
        user_id: person.id,
        shift_type: "work",
        location_id: location,
        is_acquisition: isAcq,
        starts_at: berlinToISO(props.day, from),
        ends_at: berlinToISO(props.day, to),
      });
      setBusy(false);
      if (error) return setError(dbMessage(error));
      lastTimes = { from, to };
      return props.onSaved(`${fullName(person)}: ${isAcq ? `Akquise in ${locationName}, ` : ""}${from}–${to} Uhr eingetragen.`);
    }
    if (days.length > MAX_ABSENCE_DAYS) return setError(`Bitte höchstens ${MAX_ABSENCE_DAYS} Tage auf einmal eintragen.`);
    setBusy(true);
    const { error } = await adminDb.from("shifts").insert(
      days.map((d) => ({
        user_id: person.id,
        shift_type: cat,
        location_id: null,
        starts_at: berlinToISO(d, ABSENCE_TIMES.from),
        ends_at: berlinToISO(d, ABSENCE_TIMES.to),
      })),
    );
    setBusy(false);
    if (error?.code === "23P01") {
      return setError("An mindestens einem dieser Tage ist schon etwas eingetragen (z. B. eine Schicht). Bitte dort zuerst löschen.");
    }
    if (error) return setError(dbMessage(error));
    const label = SHIFT_TYPE_LABEL[cat as ShiftType];
    props.onSaved(
      days.length === 1
        ? `${fullName(person)}: ${label} eingetragen.`
        : `${fullName(person)}: ${label} ${fmtDay(days[0])} – ${fmtDay(days[days.length - 1])} (${days.length} Tage) eingetragen.`,
    );
  }

  const option = (p: Staffer) => (
    <label key={p.id} className="list-row has-leading">
      <input type="radio" name="shift-user" value={p.id} checked={userId === p.id} onChange={() => setUserId(p.id)} />
      <Avatar first={p.first_name} last={p.last_name} color={studioColor(p.home_location_id)} />
      <span className="list-row-main">
        <span className="list-row-title">{fullName(p)}</span>
        <span className="list-row-sub">{cat === "vacation" ? vacationHint(p.id) : ROLE_LABEL[p.role]}</span>
      </span>
    </label>
  );

  const canSave = isSwap ? !!sickShift && sickValid(sickShift, sickFrom)
    : isHelpReq ? minutesBetween(from, to) > 0
    : isHelpFill ? !!request && !!person
    : !!person;
  const left = person && cat === "vacation" ? vacationLeft(person.id) : null;
  const dayCredit = person ? props.creditOf(person.id, minutesBetween(ABSENCE_TIMES.from, ABSENCE_TIMES.to), 1) : undefined;

  return (
    <Sheet
      title={SHEET_TITLE[cat]}
      subtitle={`${fmtLongDay(props.day)} · ${isAcq ? `Akquise in ${locationName}` : isHelpFill ? `Aushilfe aus ${props.studioName}` : props.studioName}`}
      onClose={props.onClose}
      footer={
        <button type="button" className="btn btn-primary" disabled={!canSave || busy} onClick={() => void save()}>
          {busy ? "Speichert …" : isSwap ? "Auf Krank setzen" : isHelpReq ? "Anfragen" : isHelpFill ? "Aushilfe stellen" : "Speichern"}
        </button>
      }
    >
      <Field label="Art">
        <select id="shift-category" value={cat} onChange={(e) => choose(e.target.value as Category)}>
          {CATEGORIES.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
        </select>
      </Field>

      {isHelpReq && (
        <Notice>Alle Studios sehen die Anfrage unter „Aushilfe gesucht“ und können jemanden schicken.</Notice>
      )}
      {isHelpFill && (
        props.helpRequests.length === 0 ? (
          <Empty icon="users" title="Keine offene Anfrage an diesem Tag">
            Offene Anfragen stehen oben im Dienstplan unter „Aushilfe gesucht“.
          </Empty>
        ) : (
          <Section title="Welche Anfrage?">
            {props.helpRequests.map((r) => (
              <label key={r.id} className="list-row has-leading">
                <input type="radio" name="help-request" value={r.id} checked={requestId === r.id} onChange={() => setRequestId(r.id)} />
                <span className="studio-swatch" style={{ background: studioColor(r.location_id) }} aria-hidden="true" />
                <span className="list-row-main">
                  <span className="list-row-title">{studioShort(r.location?.name ?? "")}</span>
                  <span className="list-row-sub">{berlinTime(r.starts_at)}–{berlinTime(r.ends_at)} Uhr{r.note ? ` · ${r.note}` : ""}</span>
                </span>
              </label>
            ))}
          </Section>
        )
      )}

      {isAcq && (
        <Section title="Wo findet die Akquise statt?" plain
          footer={foreign ? `In ${locationName} planst du nur Akquise – normale Schichten dort plant die Studioleitung ${locationName}.` : undefined}>
          <StudioFilter all={false} locations={props.locations} value={acqStudio}
            onChange={(id) => { setAcqStudio(id); setError(undefined); }} />
        </Section>
      )}

      {cat === "sick" && (
        <Segmented label="Krank" value={sickMode} fill
          onChange={(m) => { setSickMode(m); setUserId(""); setSickShiftId(""); setSickFrom(null); setError(undefined); }}
          options={[{ id: "swap", label: "Schicht tauschen" }, { id: "day", label: "Ganzer Tag" }]} />
      )}

      {isHelpReq || (isHelpFill && props.helpRequests.length === 0) ? null : isSwap ? (
        props.sickCandidates.length === 0 ? (
          <Empty icon="calendar" title="Keine Schicht an diesem Tag">
            Ohne geplante Schicht „Ganzer Tag“ wählen.
          </Empty>
        ) : (
          <>
            <Section title="Welche Schicht?">
              {props.sickCandidates.map((s) => (
                <label key={s.id} className="list-row has-leading">
                  <input type="radio" name="sick-shift" value={s.id} checked={sickShiftId === s.id}
                    onChange={() => { setSickShiftId(s.id); setSickFrom(null); }} />
                  <Avatar first={s.user?.first_name ?? "?"} last={s.user?.last_name} color={studioColor(s.user?.home_location_id)} />
                  <span className="list-row-main">
                    <span className="list-row-title">{s.user ? fullName(s.user) : "?"}</span>
                    <span className="list-row-sub">
                      {berlinTime(s.starts_at)}–{berlinTime(s.ends_at)} Uhr
                      {s.is_acquisition ? ` · Akquise in ${studioShort(s.location?.name ?? "")}`
                        : s.location_id !== props.studio ? ` · in ${studioShort(s.location?.name ?? "")}` : ""}
                    </span>
                  </span>
                </label>
              ))}
            </Section>
            {sickShift && <SickChoice shift={sickShift} creditOf={props.creditOf} from={sickFrom} onChange={setSickFrom} />}
          </>
        )
      ) : own.length + others.length === 0 ? (
        <Empty icon="users" title="Alle sind schon eingetragen">
          Bestehende Einträge lassen sich über den Tag bearbeiten oder löschen.
        </Empty>
      ) : (
        <>
          <Section title={isHelpFill ? `Wer hilft aus? · ${props.studioName}` : `Wer? · ${props.studioName}`}>
            {own.length === 0 && <p className="list-empty">Alle aus diesem Studio sind schon eingetragen.</p>}
            {own.map(option)}
          </Section>
          {others.length > 0 && (
            <Section title={isAcq ? "Aus anderen Studios" : "Aushilfe aus anderen Studios"}>{others.map(option)}</Section>
          )}
        </>
      )}

      {(isWork || isHelpReq) && (
        <Section title="Wann?" plain>
          <TimeFields from={from} to={to} onFrom={setFrom} onTo={setTo} />
        </Section>
      )}
      {isHelpReq && (
        <Field label="Hinweis (optional)">
          <input id="help-note" value={note} maxLength={200} placeholder="z. B. Kurs am Vormittag" onChange={(e) => setNote(e.target.value)} />
        </Field>
      )}
      {isAbsence && (
        <Section title="Bis wann?" plain>
          <div className="grid-2">
            <Field label="Erster Tag"><input id="absence-from" type="date" value={props.day} disabled /></Field>
            <Field label="Letzter Tag">
              <input id="absence-until" type="date" value={until} min={props.day}
                onChange={(e) => setUntil(e.target.value || props.day)} />
            </Field>
          </div>
          {until > props.day && (
            <SwitchRow title="Samstage mitzählen" subtitle="Sonntage zählen nie" checked={saturdays} onChange={setSaturdays} />
          )}
          <p className="muted small">
            {days.length === 1 ? "1 Tag" : `${days.length} Tage (${saturdays ? "Mo–Sa" : "Mo–Fr"})`} · zählt je Tag{" "}
            {!dayCredit ? `6,5 Std. (${TRAINEE_RULE.replace("Azubi", "Azubis")})`
              : dayCredit.minutes === undefined ? `den Tagesanteil (${TRAINEE_RULE})`
              : `${fmtHM(dayCredit.minutes)} Std.${dayCredit.trainee ? ` (${TRAINEE_RULE})` : ""}`}
            {left !== null && ` · danach ${left - days.length} Urlaubstage übrig`}
          </p>
          {left !== null && left - days.length < 0 && <Notice tone="warn">Damit wird der Urlaubsanspruch überschritten.</Notice>}
        </Section>
      )}
      {error && <Notice tone="error">{error}</Notice>}
    </Sheet>
  );
}

function EditShift(props: {
  shift: PlanShift;
  canPlanNormal: boolean;
  canSick: boolean;
  creditOf: CreditOf;
  onClose: () => void;
  onSaved: (text: string) => void;
}) {
  const s = props.shift;
  const isWork = s.shift_type === "work";
  const day = berlinDate(s.starts_at);
  const name = s.user ? fullName(s.user) : "?";
  const [from, setFrom] = useState(berlinTime(s.starts_at));
  const [to, setTo] = useState(berlinTime(s.ends_at));
  const [acq, setAcq] = useState(!!s.is_acquisition);
  const [sick, setSick] = useState(false);
  const [sickFrom, setSickFrom] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  async function save() {
    if (minutesBetween(from, to) <= 0) return setError("Das Ende muss nach dem Beginn liegen.");
    setBusy(true);
    const { error } = await adminDb
      .from("shifts")
      .update({ starts_at: berlinToISO(day, from), ends_at: berlinToISO(day, to), is_acquisition: acq })
      .eq("id", s.id);
    setBusy(false);
    if (error) return setError(dbMessage(error));
    props.onSaved(`${name}: jetzt ${acq ? "Akquise, " : ""}${from}–${to} Uhr.`);
  }

  async function setToSick() {
    if (!sickValid(s, sickFrom)) return;
    setBusy(true);
    const { error, text } = await reportSick(s, sickFrom);
    setBusy(false);
    if (error) return setError(dbMessage(error));
    props.onSaved(text);
  }

  async function remove() {
    setBusy(true);
    const { error } = await adminDb.from("shifts").delete().eq("id", s.id);
    setBusy(false);
    if (error) return setError(dbMessage(error));
    props.onSaved(`Eintrag von ${name} gelöscht.`);
  }

  // ganzer Tag pauschal, Krank statt Schicht mit der Schichtdauer
  const credit = props.creditOf(s.user_id, isSickSwap(s) ? durationMinutes(s) : minutesBetween(ABSENCE_TIMES.from, ABSENCE_TIMES.to),
    Number(s.credit_share ?? 1));
  const where = isWork ? `${s.is_acquisition ? "Akquise in " : ""}${studioShort(s.location?.name ?? "")}` : SHIFT_TYPE_LABEL[s.shift_type];

  if (sick) {
    return (
      <Sheet
        title={`${name} · Krank`}
        subtitle={`${fmtLongDay(day)} · Schicht ${berlinTime(s.starts_at)}–${berlinTime(s.ends_at)} Uhr`}
        onClose={props.onClose}
        footer={
          <>
            <button type="button" className="btn btn-outline" disabled={busy} onClick={() => setSick(false)}>Zurück</button>
            <button type="button" className="btn btn-primary" disabled={busy || !sickValid(s, sickFrom)} onClick={() => void setToSick()}>
              {busy ? "Speichert …" : "Auf Krank setzen"}
            </button>
          </>
        }
      >
        <SickChoice shift={s} creditOf={props.creditOf} from={sickFrom} onChange={setSickFrom} />
        {error && <Notice tone="error">{error}</Notice>}
      </Sheet>
    );
  }

  return (
    <Sheet
      title={name}
      subtitle={`${fmtLongDay(day)} · ${where}`}
      onClose={props.onClose}
      footer={
        <>
          <button type="button" className={confirm ? "btn btn-danger-solid" : "btn btn-danger"} disabled={busy}
            onClick={() => (confirm ? void remove() : setConfirm(true))}>
            {confirm ? "Wirklich löschen" : "Löschen"}
          </button>
          {isWork && props.canSick && (
            <button type="button" className="btn btn-outline" disabled={busy} onClick={() => { setSick(true); setError(undefined); }}>Krank</button>
          )}
          {isWork && (
            <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void save()}>Speichern</button>
          )}
        </>
      }
    >
      {isHelpShift(s) && <Notice>Automatisch eingetragen: eingestempelt ohne geplante Schicht (Aushilfe).</Notice>}
      {isWork ? (
        <>
          {props.canPlanNormal ? (
            <Segmented label="Art" value={acq ? "acq" : "work"} onChange={(v) => setAcq(v === "acq")}
              options={[{ id: "work", label: "Schicht" }, { id: "acq", label: "Akquise" }]} />
          ) : (
            <Notice>Akquise-Schicht – normale Schichten in diesem Studio plant die dortige Studioleitung.</Notice>
          )}
          <TimeFields from={from} to={to} onFrom={setFrom} onTo={setTo} />
        </>
      ) : (
        <p>
          {SHIFT_TYPE_LABEL[s.shift_type]}
          {isSickSwap(s) && ` ${berlinTime(s.starts_at)}–${berlinTime(s.ends_at)} Uhr (statt Schicht)`} · zählt mit{" "}
          {credit.minutes === undefined ? `anteiligem Tagesanteil (${TRAINEE_RULE})` : `${fmtHM(credit.minutes)} Std.`}
          {credit.trainee && credit.minutes !== undefined && ` (${TRAINEE_RULE})`}
        </p>
      )}
      {error && <Notice tone="error">{error}</Notice>}
    </Sheet>
  );
}
