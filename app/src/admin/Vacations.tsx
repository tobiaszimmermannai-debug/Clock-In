// Urlaub (nur Admin): genommene, geplante und noch offene Urlaubstage aller Mitarbeiter je Jahr.
// Person antippen → Urlaubsanspruch für dieses und nächstes Jahr eintragen (z. B. anteilig) + ihre Urlaubstage.
import { useCallback, useEffect, useState } from "react";
import { Avatar, Field, Icon, Notice, PageHeader, Pill, Row, Section, Sheet, StudioFilter } from "../components/ui";
import { berlinDate, berlinToISO, fmtDay, vacationRanges } from "../lib/dates";
import { dbMessage } from "../lib/errors";
import { registerStudios, studioColor } from "../lib/studios";
import { adminDb } from "../lib/supabase";
import { DEFAULT_VACATION_DAYS, type Location, ROLE_LABEL, type Role, studioShort } from "../lib/types";

type Person = { id: string; first_name: string; last_name: string; role: Role; home_location_id: string | null };
type Overview = { user_id: string; allowance: number | null; taken: number; planned: number };

const fmt = (n: number) => String(n).replace(".", ",");
const days = (n: number) => `${fmt(n)} ${n === 1 ? "Tag" : "Tage"}`;
const leftOf = (v?: Overview) => (v && v.allowance !== null ? Number(v.allowance) - v.taken - v.planned : null);

export function Vacations() {
  const thisYear = Number(berlinDate().slice(0, 4));
  const [year, setYear] = useState(thisYear);
  const [people, setPeople] = useState<Person[] | null>(null);
  const [locations, setLocations] = useState<Location[]>([]);
  const [overview, setOverview] = useState<Record<string, Overview>>({});
  const [studio, setStudio] = useState("");
  const [selected, setSelected] = useState<Person | null>(null);
  const [error, setError] = useState<string>();

  useEffect(() => {
    void Promise.all([
      adminDb.from("users").select("id, first_name, last_name, role, home_location_id").eq("is_active", true).neq("role", "admin").order("first_name"),
      adminDb.from("locations").select("id, code, name").eq("is_active", true).order("name"),
    ]).then(([users, locs]) => {
      registerStudios((locs.data ?? []) as Location[]);
      setLocations((locs.data ?? []) as Location[]);
      setPeople((users.data ?? []) as Person[]);
    });
  }, []);

  const loadYear = useCallback(async () => {
    const { data, error } = await adminDb.rpc("vacation_overview", { p_year: year });
    setError(error ? dbMessage(error) : undefined);
    setOverview(Object.fromEntries(((data ?? []) as Overview[]).map((v) => [v.user_id, v])));
  }, [year]);

  useEffect(() => {
    void loadYear();
  }, [loadYear]);

  if (people === null) return <p className="muted">Lädt …</p>;

  const visible = people.filter((p) => !studio || p.home_location_id === studio);
  const sum = (pick: (v: Overview) => number) => visible.reduce((n, p) => n + (overview[p.id] ? pick(overview[p.id]) : 0), 0);
  const openTotal = visible.reduce((n, p) => n + Math.max(0, leftOf(overview[p.id]) ?? 0), 0);
  const groups = [...locations, { id: "", code: "", name: "Ohne Studio" }]
    .filter((l) => !studio || l.id === studio)
    .map((l) => ({
      key: l.id || "none",
      title: studioShort(l.name),
      members: visible.filter((p) => (l.id ? p.home_location_id === l.id : !locations.some((x) => x.id === p.home_location_id))),
    }))
    .filter((g) => g.members.length > 0);

  return (
    <>
      <PageHeader title="Urlaub" subtitle="Genommene und offene Urlaubstage" />
      <div className="weeknav">
        <button type="button" className="icon-btn" aria-label="Vorjahr" onClick={() => setYear((y) => y - 1)}>
          <Icon name="chevronLeft" size={20} />
        </button>
        <div className="weeknav-label num"><strong>{year}</strong><span>Urlaubsjahr</span></div>
        <button type="button" className="icon-btn" aria-label="Nächstes Jahr" onClick={() => setYear((y) => y + 1)}>
          <Icon name="chevronRight" size={20} />
        </button>
        {year !== thisYear && (
          <button type="button" className="btn btn-outline btn-sm weeknav-today" onClick={() => setYear(thisYear)}>Heute</button>
        )}
      </div>
      <StudioFilter locations={locations} value={studio} onChange={setStudio} />
      {error && <Notice tone="error">{error}</Notice>}

      <div className="stats">
        <div className="stat"><span className="stat-label">Genommen</span><span className="stat-value">{fmt(sum((v) => v.taken))} <small>Tage</small></span></div>
        <div className="stat"><span className="stat-label">Eingetragen</span><span className="stat-value">{fmt(sum((v) => v.planned))} <small>Tage</small></span></div>
        <div className="stat"><span className="stat-label">Resturlaub</span><span className="stat-value">{fmt(openTotal)} <small>Tage</small></span></div>
      </div>

      {groups.map((g) => (
        <Section key={g.key} title={g.title} aside={<span>{g.members.length}</span>}>
          {g.members.map((p) => {
            const v = overview[p.id];
            const left = leftOf(v);
            return (
              <Row
                key={p.id}
                leading={<Avatar first={p.first_name} last={p.last_name} color={studioColor(p.home_location_id)} />}
                title={`${p.first_name} ${p.last_name}`}
                subtitle={!v || v.allowance === null
                  ? ROLE_LABEL[p.role]
                  : `Anspruch ${fmt(Number(v.allowance))} · genommen ${fmt(v.taken)} · eingetragen ${fmt(v.planned)}`}
                trailing={left === null
                  ? <span className="muted">–</span>
                  : <strong className={`num${left < 0 ? " text-danger" : ""}`}>{days(left)} Rest</strong>}
                chevron
                onClick={() => setSelected(p)}
              />
            );
          })}
        </Section>
      ))}
      <p className="muted small">Anspruch ändern: Person antippen. Ohne Eintrag gelten {DEFAULT_VACATION_DAYS} Tage.</p>

      {selected && (
        <PersonVacation person={selected} year={year} overview={overview[selected.id]}
          onClose={() => setSelected(null)}
          onSaved={() => { setSelected(null); void loadYear(); }} />
      )}
    </>
  );
}

// Urlaubstage einer Person im Jahr (zusammengefasst)
function PersonVacation(props: { person: Person; year: number; overview?: Overview; onClose: () => void; onSaved: () => void }) {
  const [list, setList] = useState<string[] | null>(null);
  const today = berlinDate();
  // Anspruch dieses und nächstes Jahr (manuell, z. B. anteilig); vorbelegt mit dem Standard
  const thisYear = Number(today.slice(0, 4));
  const years = [thisYear, thisYear + 1];
  const [allowance, setAllowance] = useState<Record<number, string>>({});
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void adminDb
      .from("vacation_allowances")
      .select("year, days")
      .eq("user_id", props.person.id)
      .in("year", [thisYear, thisYear + 1])
      .then(({ data }) => {
        const found = Object.fromEntries((data ?? []).map((r) => [r.year as number, fmt(Number(r.days))]));
        setAllowance({ [thisYear]: found[thisYear] ?? fmt(DEFAULT_VACATION_DAYS), [thisYear + 1]: found[thisYear + 1] ?? fmt(DEFAULT_VACATION_DAYS) });
      });
  }, [props.person.id, thisYear]);

  async function save() {
    const rows = years.map((y) => ({ user_id: props.person.id, year: y, days: Number((allowance[y] ?? "").replace(",", ".")) }));
    if (rows.some((r) => !Number.isFinite(r.days) || r.days < 0 || r.days > 365)) return setError("Bitte 0 bis 365 Tage eintragen (halbe Tage mit ,5).");
    setBusy(true);
    const { error } = await adminDb.from("vacation_allowances").upsert(rows, { onConflict: "user_id,year" });
    setBusy(false);
    if (error) return setError(dbMessage(error));
    props.onSaved();
  }

  useEffect(() => {
    void adminDb
      .from("shifts")
      .select("starts_at")
      .eq("user_id", props.person.id)
      .eq("shift_type", "vacation")
      .gte("starts_at", berlinToISO(`${props.year}-01-01`))
      .lt("starts_at", berlinToISO(`${props.year + 1}-01-01`))
      .order("starts_at")
      .then(({ data }) => setList((data ?? []).map((r) => berlinDate(r.starts_at as string))));
  }, [props.person.id, props.year]);

  const v = props.overview;
  const left = leftOf(v);
  return (
    <Sheet
      title={`${props.person.first_name} ${props.person.last_name}`}
      subtitle={`Urlaub ${props.year}`}
      onClose={props.onClose}
      footer={<button type="button" className="btn btn-primary" disabled={busy || !allowance[thisYear]} onClick={() => void save()}>
        {busy ? "Speichert …" : "Anspruch speichern"}
      </button>}
    >
      <Section title="Urlaubsanspruch" plain footer={`Manuell, z. B. anteilig im Eintrittsjahr. Standard ${DEFAULT_VACATION_DAYS} Tage.`}>
        <div className="grid-2">
          {years.map((y) => (
            <Field key={y} label={`${y} (Tage)`}>
              <input id={`allowance-${y}`} inputMode="decimal" value={allowance[y] ?? ""}
                onChange={(e) => setAllowance((a) => ({ ...a, [y]: e.target.value }))} />
            </Field>
          ))}
        </div>
      </Section>
      {error && <Notice tone="error">{error}</Notice>}
      {v && v.allowance !== null && (
        <Section>
          <Row title={<strong>Resturlaub {props.year}</strong>} trailing={<strong className={`num${left !== null && left < 0 ? " text-danger" : ""}`}>{days(left ?? 0)}</strong>} />
          <Row title="Anspruch" trailing={<span className="num">{days(Number(v.allowance))}</span>} />
          <Row title="Genommen" trailing={<span className="num">{days(v.taken)}</span>} />
          <Row title="Eingetragen (kommt noch)" trailing={<span className="num">{days(v.planned)}</span>} />
        </Section>
      )}
      <Section title="Urlaubstage">
        {list === null && <p className="list-empty">Lädt …</p>}
        {list?.length === 0 && <p className="list-empty">Keine Urlaubstage eingetragen.</p>}
        {list && vacationRanges(list).map((r) => (
          <Row
            key={r.from}
            title={r.from === r.to ? fmtDay(r.from) : `${fmtDay(r.from)} – ${fmtDay(r.to)}`}
            subtitle={days(r.count)}
            trailing={r.to <= today ? <Pill tone="ok">genommen</Pill> : r.from > today ? <Pill>geplant</Pill> : <Pill tone="accent">läuft</Pill>}
          />
        ))}
      </Section>
    </Sheet>
  );
}
