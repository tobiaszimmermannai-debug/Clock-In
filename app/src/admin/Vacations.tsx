// Urlaub (nur Admin): genommene, geplante und noch offene Urlaubstage aller Mitarbeiter je Jahr.
// Person antippen → ihre Urlaubstage. Anspruch ändern: Team → Person → Arbeitsvertrag.
import { useCallback, useEffect, useState } from "react";
import { Avatar, Icon, Notice, PageHeader, Pill, Row, Section, Sheet, StudioFilter } from "../components/ui";
import { berlinDate, berlinToISO, fmtDay, vacationRanges } from "../lib/dates";
import { dbMessage } from "../lib/errors";
import { registerStudios, studioColor } from "../lib/studios";
import { adminDb } from "../lib/supabase";
import { type Location, ROLE_LABEL, type Role, studioShort } from "../lib/types";

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
        <div className="stat"><span className="stat-label">Geplant</span><span className="stat-value">{fmt(sum((v) => v.planned))} <small>Tage</small></span></div>
        <div className="stat"><span className="stat-label">Noch offen</span><span className="stat-value">{fmt(openTotal)} <small>Tage</small></span></div>
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
                  ? `${ROLE_LABEL[p.role]} · kein Anspruch hinterlegt${v?.taken || v?.planned ? ` · ${fmt(v.taken + v.planned)} Tage eingetragen` : ""}`
                  : `Anspruch ${fmt(Number(v.allowance))} · genommen ${fmt(v.taken)} · geplant ${fmt(v.planned)}`}
                trailing={left === null
                  ? <span className="muted">–</span>
                  : <strong className={`num${left < 0 ? " text-danger" : ""}`}>{days(left)} offen</strong>}
                chevron
                onClick={() => setSelected(p)}
              />
            );
          })}
        </Section>
      ))}
      <p className="muted small">Anspruch ändern: Team → Person → Arbeitsvertrag → „Urlaubstage pro Jahr“.</p>

      {selected && <PersonVacation person={selected} year={year} overview={overview[selected.id]} onClose={() => setSelected(null)} />}
    </>
  );
}

// Urlaubstage einer Person im Jahr (zusammengefasst)
function PersonVacation(props: { person: Person; year: number; overview?: Overview; onClose: () => void }) {
  const [list, setList] = useState<string[] | null>(null);
  const today = berlinDate();

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
    <Sheet title={`${props.person.first_name} ${props.person.last_name}`} subtitle={`Urlaub ${props.year}`} onClose={props.onClose}>
      {v && v.allowance !== null && (
        <Section>
          <Row title={<strong>Offen</strong>} trailing={<strong className={`num${left !== null && left < 0 ? " text-danger" : ""}`}>{days(left ?? 0)}</strong>} />
          <Row title="Anspruch" trailing={<span className="num">{days(Number(v.allowance))}</span>} />
          <Row title="Genommen" trailing={<span className="num">{days(v.taken)}</span>} />
          <Row title="Geplant" trailing={<span className="num">{days(v.planned)}</span>} />
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
