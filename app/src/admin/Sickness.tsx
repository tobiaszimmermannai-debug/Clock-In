// Krankheit (nur Admin): Krankheitsfälle je Person – Attest / Karenztag-Zettel abhaken.
// Zusammenhängende Krank-Tage (Wochenende dazwischen zählt mit) bilden einen Fall; die Haken gelten für alle Tage.
import { useCallback, useEffect, useState } from "react";
import { Avatar, Empty, Icon, Notice, PageHeader, Pill, Row, Section, Segmented } from "../components/ui";
import { addDays, berlinDate, berlinTime, berlinToISO, fmtDay, groupDays } from "../lib/dates";
import { dbMessage } from "../lib/errors";
import { registerStudios, studioColor } from "../lib/studios";
import { adminDb } from "../lib/supabase";
import { type Location, studioShort } from "../lib/types";

type SickEntry = {
  id: string;
  user_id: string;
  starts_at: string;
  ends_at: string;
  note: string | null;
  attest_received: boolean;
  karenz_received: boolean;
  user: { first_name: string; last_name: string; home_location_id: string | null } | null;
};
type SickCase = { key: string; entries: SickEntry[]; from: string; to: string; days: number; attest: boolean; karenz: boolean };
type Doc = "attest_received" | "karenz_received";

const LOOKBACK_DAYS = 365;

function toCases(entries: SickEntry[]): SickCase[] {
  const byUser = new Map<string, SickEntry[]>();
  for (const e of entries) byUser.set(e.user_id, [...(byUser.get(e.user_id) ?? []), e]);
  const cases: SickCase[] = [];
  for (const list of byUser.values()) {
    for (const g of groupDays(list, (e) => berlinDate(e.starts_at))) {
      cases.push({
        key: g.items[0].id,
        entries: g.items,
        from: g.from,
        to: g.to,
        days: new Set(g.items.map((e) => berlinDate(e.starts_at))).size,
        attest: g.items.every((e) => e.attest_received),
        karenz: g.items.every((e) => e.karenz_received),
      });
    }
  }
  return cases.sort((a, b) => b.from.localeCompare(a.from));
}

export function Sickness() {
  const [entries, setEntries] = useState<SickEntry[] | null>(null);
  const [locations, setLocations] = useState<Location[]>([]);
  const [filter, setFilter] = useState<"open" | "all">("open");
  const [error, setError] = useState<string>();

  const load = useCallback(async () => {
    const [sick, locs] = await Promise.all([
      adminDb
        .from("shifts")
        .select("id, user_id, starts_at, ends_at, note, attest_received, karenz_received, user:users!shifts_user_id_fkey(first_name, last_name, home_location_id)")
        .eq("shift_type", "sick")
        .gte("starts_at", berlinToISO(addDays(berlinDate(), -LOOKBACK_DAYS)))
        .order("starts_at"),
      adminDb.from("locations").select("id, code, name").order("name"),
    ]);
    if (sick.error) setError(dbMessage(sick.error));
    registerStudios((locs.data ?? []) as Location[]);
    setLocations((locs.data ?? []) as Location[]);
    setEntries((sick.data ?? []) as unknown as SickEntry[]);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Haken für alle Tage des Falls setzen/entfernen
  async function toggle(c: SickCase, doc: Doc) {
    const value = !(doc === "attest_received" ? c.attest : c.karenz);
    const ids = c.entries.map((e) => e.id);
    setEntries((list) => list?.map((e) => (ids.includes(e.id) ? { ...e, [doc]: value } : e)) ?? null);
    const { error } = await adminDb.from("shifts").update({ [doc]: value }).in("id", ids);
    if (error) {
      setError(dbMessage(error));
      void load();
    }
  }

  if (entries === null) return <p className="muted">Lädt …</p>;
  const cases = toCases(entries);
  const open = cases.filter((c) => !c.attest && !c.karenz);
  const shown = filter === "open" ? open : cases;
  const studio = (id: string | null | undefined) => studioShort(locations.find((l) => l.id === id)?.name ?? "");

  return (
    <>
      <PageHeader title="Krankheit" subtitle="Atteste und Karenztag-Zettel abhaken" />
      <Segmented
        label="Filter"
        value={filter}
        onChange={setFilter}
        options={[{ id: "open", label: `Offen (${open.length})` }, { id: "all", label: `Alle (${cases.length})` }]}
      />
      {error && <Notice tone="error">{error}</Notice>}
      {shown.length === 0 ? (
        <Empty icon="checkCircle" title={filter === "open" ? "Alles abgehakt" : "Keine Krank-Einträge"}>
          {filter === "open" ? "Zu allen Krankheitsfällen liegt ein Attest oder Karenztag-Zettel vor." : `In den letzten ${LOOKBACK_DAYS} Tagen.`}
        </Empty>
      ) : (
        <Section footer="Ein Fall = zusammenhängende Krank-Tage einer Person (Wochenende zählt mit). Die Haken gelten für alle Tage des Falls.">
          {shown.map((c) => {
            const u = c.entries[0].user;
            const partial = c.entries.length === 1 && c.entries[0].note?.startsWith("Krank statt Schicht")
              ? ` · ${berlinTime(c.entries[0].starts_at)}–${berlinTime(c.entries[0].ends_at)}` : "";
            return (
              <div key={c.key} className="list-item">
                <Row
                  leading={<Avatar first={u?.first_name ?? "?"} last={u?.last_name} color={studioColor(u?.home_location_id)} />}
                  title={u ? `${u.first_name} ${u.last_name}` : "?"}
                  subtitle={`${c.from === c.to ? fmtDay(c.from) : `${fmtDay(c.from)} – ${fmtDay(c.to)}`}${partial} · ` +
                    `${c.days} ${c.days === 1 ? "Tag" : "Tage"}${studio(u?.home_location_id) ? ` · ${studio(u?.home_location_id)}` : ""}`}
                  trailing={c.attest || c.karenz ? <Pill tone="ok">erledigt</Pill> : <Pill tone="warn">fehlt</Pill>}
                />
                <div className="list-actions indent">
                  <button type="button" className="btn btn-outline btn-sm btn-check" aria-pressed={c.attest}
                    onClick={() => void toggle(c, "attest_received")}>
                    {c.attest && <Icon name="check" size={16} />} Attest da
                  </button>
                  <button type="button" className="btn btn-outline btn-sm btn-check" aria-pressed={c.karenz}
                    onClick={() => void toggle(c, "karenz_received")}>
                    {c.karenz && <Icon name="check" size={16} />} Karenztag-Zettel da
                  </button>
                </div>
              </div>
            );
          })}
        </Section>
      )}
    </>
  );
}
