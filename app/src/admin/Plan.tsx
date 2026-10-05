// Dienstplan schreiben: Studio → Woche → Tag antippen → „Schicht hinzufügen“ (wer + von–bis).
// Studioleitung plant nur ihr eigenes Studio; wer an dem Tag schon eingetragen ist, fällt aus der Auswahl.
import { useEffect, useState } from "react";
import { type PlanShift, ShiftRow, isHelpShift, useWeekShifts } from "../components/WeekPlan";
import { Avatar, DayStrip, Empty, Field, Icon, Notice, PageHeader, Section, Segmented, Sheet, StudioFilter, WeekNav } from "../components/ui";
import { addDays, berlinDate, berlinTime, berlinToISO, fmtHM, fmtLongDay, weekStart } from "../lib/dates";
import { dbMessage } from "../lib/errors";
import { adminDb } from "../lib/supabase";
import { type Location, ROLE_LABEL, type Role, SHIFT_TYPE_LABEL, type ShiftType, studioShort } from "../lib/types";
import type { Profile } from "./AdminApp";

type Staffer = { id: string; first_name: string; last_name: string; role: Role; home_location_id: string | null };

// IST/Urlaub/Krank werden als Ganztag mit 6,5 Std. Gutschrift gespeichert
const ABSENCE_TIMES = { from: "08:00", to: "14:30" };
// Zuletzt eingetragene Zeiten als Vorschlag für die nächste Schicht
let lastTimes = { from: "09:00", to: "15:30" };

const minutesBetween = (from: string, to: string) => {
  const [fh, fm] = from.split(":").map(Number);
  const [th, tm] = to.split(":").map(Number);
  return th * 60 + tm - (fh * 60 + fm);
};
const fullName = (p: { first_name: string; last_name: string }) => `${p.first_name} ${p.last_name}`;

export function Plan({ profile }: { profile: Profile }) {
  const today = berlinDate();
  const [start, setStart] = useState(weekStart(today));
  const [day, setDay] = useState(today);
  const [locations, setLocations] = useState<Location[] | null>(null);
  const [studio, setStudio] = useState("");
  const [people, setPeople] = useState<Staffer[]>([]);
  const [sheet, setSheet] = useState<{ shift?: PlanShift } | null>(null);
  const [flash, setFlash] = useState<string>();
  const { shifts, error, reload } = useWeekShifts(adminDb, start);

  useEffect(() => {
    void (async () => {
      const [users, locs, managed] = await Promise.all([
        adminDb.from("users").select("id, first_name, last_name, role, home_location_id").eq("is_active", true).neq("role", "admin").order("first_name"),
        adminDb.from("locations").select("id, code, name").eq("is_active", true).order("name"),
        adminDb.from("location_managers").select("location_id").eq("user_id", profile.id),
      ]);
      const mine = new Set((managed.data ?? []).map((m) => m.location_id as string));
      // Admin plant alle Studios, Studioleitung nur die eigenen
      const allowed = ((locs.data ?? []) as Location[]).filter((l) => profile.role === "admin" || mine.has(l.id));
      setPeople((users.data ?? []) as Staffer[]);
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

  const studioName = studioShort(locations.find((l) => l.id === studio)?.name ?? "");
  const inStudio = (s: PlanShift) =>
    s.location_id === studio || (s.location_id === null && s.user?.home_location_id === studio);
  const counts: Record<string, number> = {};
  for (const s of shifts) if (inStudio(s)) counts[berlinDate(s.starts_at)] = (counts[berlinDate(s.starts_at)] ?? 0) + 1;
  const dayEntries = shifts.filter((s) => berlinDate(s.starts_at) === day && inStudio(s));
  // Wer an diesem Tag schon irgendwo eingetragen ist, kann nicht erneut gewählt werden
  const taken = new Set(shifts.filter((s) => berlinDate(s.starts_at) === day).map((s) => s.user_id));

  const done = (text: string) => {
    setSheet(null);
    setFlash(text);
    void reload();
  };

  return (
    <>
      <PageHeader title="Dienstplan" subtitle={locations.length === 1 ? `Studio ${studioName}` : undefined} />
      {locations.length > 1 && <StudioFilter all={false} locations={locations} value={studio} onChange={setStudio} />}
      <WeekNav start={start} onChange={goWeek} />
      <DayStrip start={start} value={day} onChange={(d) => { setDay(d); setFlash(undefined); }} counts={counts} />
      {error && <Notice tone="error">{error}</Notice>}
      {flash && <Notice tone="ok">{flash}</Notice>}

      <Section title={fmtLongDay(day)} aside={<span>{dayEntries.length} {dayEntries.length === 1 ? "Eintrag" : "Einträge"}</span>}>
        {dayEntries.length === 0 && <p className="list-empty">Noch niemand eingetragen.</p>}
        {dayEntries.map((s) => <ShiftRow key={s.id} shift={s} onClick={() => setSheet({ shift: s })} />)}
      </Section>
      <button type="button" className="btn btn-primary btn-block" onClick={() => setSheet({})}>
        <Icon name="plus" size={20} /> Schicht hinzufügen
      </button>

      {sheet && !sheet.shift && (
        <AddShift
          day={day}
          studio={studio}
          studioName={studioName}
          people={people}
          taken={taken}
          onClose={() => setSheet(null)}
          onSaved={done}
        />
      )}
      {sheet?.shift && (
        <EditShift shift={sheet.shift} studioName={studioName} onClose={() => setSheet(null)} onSaved={done} />
      )}
    </>
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

function AddShift(props: {
  day: string;
  studio: string;
  studioName: string;
  people: Staffer[];
  taken: Set<string>;
  onClose: () => void;
  onSaved: (text: string) => void;
}) {
  const [type, setType] = useState<ShiftType>("work");
  const [userId, setUserId] = useState("");
  const [from, setFrom] = useState(lastTimes.from);
  const [to, setTo] = useState(lastTimes.to);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const isWork = type === "work";

  const free = props.people.filter((p) => !props.taken.has(p.id));
  const own = free.filter((p) => p.home_location_id === props.studio);
  // Aushilfen aus anderen Studios nur für Schichten (Abwesenheiten trägt das Heimatstudio ein)
  const others = isWork ? free.filter((p) => p.home_location_id !== props.studio) : [];
  const person = free.find((p) => p.id === userId);

  async function save() {
    if (!person) return;
    const times = isWork ? { from, to } : ABSENCE_TIMES;
    if (minutesBetween(times.from, times.to) <= 0) return setError("Das Ende muss nach dem Beginn liegen.");
    setBusy(true);
    const { error } = await adminDb.from("shifts").insert({
      user_id: person.id,
      shift_type: type,
      location_id: isWork ? props.studio : null,
      starts_at: berlinToISO(props.day, times.from),
      ends_at: berlinToISO(props.day, times.to),
    });
    setBusy(false);
    if (error) return setError(dbMessage(error));
    if (isWork) lastTimes = { from, to };
    props.onSaved(`${fullName(person)}: ${isWork ? `${from}–${to} Uhr` : SHIFT_TYPE_LABEL[type]} eingetragen.`);
  }

  const option = (p: Staffer) => (
    <label key={p.id} className="list-row has-leading">
      <input type="radio" name="shift-user" value={p.id} checked={userId === p.id} onChange={() => setUserId(p.id)} />
      <Avatar first={p.first_name} last={p.last_name} />
      <span className="list-row-main">
        <span className="list-row-title">{fullName(p)}</span>
        <span className="list-row-sub">{ROLE_LABEL[p.role]}</span>
      </span>
    </label>
  );

  return (
    <Sheet
      title={isWork ? "Schicht hinzufügen" : `${SHIFT_TYPE_LABEL[type]} eintragen`}
      subtitle={`${fmtLongDay(props.day)} · ${props.studioName}`}
      onClose={props.onClose}
      footer={
        <button type="button" className="btn btn-primary" disabled={!person || busy} onClick={() => void save()}>
          {busy ? "Speichert …" : "Speichern"}
        </button>
      }
    >
      <Segmented
        label="Art"
        value={type}
        onChange={(t) => { setType(t); setUserId(""); setError(undefined); }}
        options={(Object.keys(SHIFT_TYPE_LABEL) as ShiftType[]).map((t) => ({ id: t, label: SHIFT_TYPE_LABEL[t] }))}
      />
      {own.length + others.length === 0 ? (
        <Empty icon="users" title="Alle sind schon eingetragen">
          Bestehende Einträge lassen sich über den Tag bearbeiten oder löschen.
        </Empty>
      ) : (
        <>
          <Section title={`Wer? · ${props.studioName}`}>
            {own.length === 0 && <p className="list-empty">Alle aus diesem Studio sind schon eingetragen.</p>}
            {own.map(option)}
          </Section>
          {others.length > 0 && <Section title="Aushilfe aus anderen Studios">{others.map(option)}</Section>}
        </>
      )}
      {isWork ? (
        <Section title="Wann?" plain>
          <TimeFields from={from} to={to} onFrom={setFrom} onTo={setTo} />
        </Section>
      ) : (
        <p className="muted small">{SHIFT_TYPE_LABEL[type]} zählt als ganzer Tag mit 6,5 Std.</p>
      )}
      {error && <Notice tone="error">{error}</Notice>}
    </Sheet>
  );
}

function EditShift(props: { shift: PlanShift; studioName: string; onClose: () => void; onSaved: (text: string) => void }) {
  const s = props.shift;
  const isWork = s.shift_type === "work";
  const day = berlinDate(s.starts_at);
  const name = s.user ? fullName(s.user) : "?";
  const [from, setFrom] = useState(berlinTime(s.starts_at));
  const [to, setTo] = useState(berlinTime(s.ends_at));
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  async function save() {
    if (minutesBetween(from, to) <= 0) return setError("Das Ende muss nach dem Beginn liegen.");
    setBusy(true);
    const { error } = await adminDb
      .from("shifts")
      .update({ starts_at: berlinToISO(day, from), ends_at: berlinToISO(day, to) })
      .eq("id", s.id);
    setBusy(false);
    if (error) return setError(dbMessage(error));
    props.onSaved(`${name}: jetzt ${from}–${to} Uhr.`);
  }

  async function remove() {
    setBusy(true);
    const { error } = await adminDb.from("shifts").delete().eq("id", s.id);
    setBusy(false);
    if (error) return setError(dbMessage(error));
    props.onSaved(`Eintrag von ${name} gelöscht.`);
  }

  return (
    <Sheet
      title={name}
      subtitle={`${fmtLongDay(day)} · ${isWork ? props.studioName : SHIFT_TYPE_LABEL[s.shift_type]}`}
      onClose={props.onClose}
      footer={
        <>
          <button type="button" className={confirm ? "btn btn-danger-solid" : "btn btn-danger"} disabled={busy}
            onClick={() => (confirm ? void remove() : setConfirm(true))}>
            {confirm ? "Wirklich löschen" : "Löschen"}
          </button>
          {isWork && (
            <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void save()}>Speichern</button>
          )}
        </>
      }
    >
      {isHelpShift(s) && <Notice>Automatisch eingetragen: eingestempelt ohne geplante Schicht (Aushilfe).</Notice>}
      {isWork ? (
        <TimeFields from={from} to={to} onFrom={setFrom} onTo={setTo} />
      ) : (
        <p>{SHIFT_TYPE_LABEL[s.shift_type]} · zählt mit 6,5 Std.</p>
      )}
      {error && <Notice tone="error">{error}</Notice>}
    </Sheet>
  );
}
