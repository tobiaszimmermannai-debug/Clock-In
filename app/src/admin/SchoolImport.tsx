// Schule (nur Admin): Termine aus dem IST-Bildungspartner-Portal in den Dienstplan übernehmen.
// IST-Seite „Termine“ kopieren → hier einfügen → Vorschau (neu / geändert / entfällt / Konflikte) → übernehmen.
// Alle 2 Wochen wiederholen: geänderte Zeiten werden angepasst, Abgesagtes entfernt; von Hand Eingetragenes bleibt.
import { type CSSProperties, useCallback, useEffect, useState } from "react";
import { Avatar, Empty, Field, Notice, PageHeader, Row, Section } from "../components/ui";
import { addDays, berlinDate, berlinTime, berlinToISO, fmtDay, groupDays } from "../lib/dates";
import { dbMessage } from "../lib/errors";
import {
  type DayEntry, IST_NOTE_PREFIX, IST_SOURCE, type IstParse, type SchoolDay, coverage, parseIst, planSync, schoolDays,
} from "../lib/istImport";
import { registerStudios, studioColor } from "../lib/studios";
import { adminDb } from "../lib/supabase";
import { type Location, SHIFT_TYPE_LABEL, type ShiftType } from "../lib/types";

type Person = { id: string; first_name: string; last_name: string; home_location_id: string | null };

const range = (from: string, to: string) => (from === to ? fmtDay(from) : `${fmtDay(from)} – ${fmtDay(to)}`);

// Manuelle Zuordnung nicht erkannter Namen merken (dieser Browser): erste zwei Wörter → Person
const ALIAS_KEY = "clockin-ist-aliases";
const aliasOf = (label: string) => label.toLowerCase().split(/\s+/).slice(0, 2).join(" ");
function loadAliases(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(ALIAS_KEY) ?? "{}") as Record<string, string>;
  } catch {
    return {};
  }
}
function saveAlias(label: string, userId: string) {
  try {
    const all = loadAliases();
    if (userId) all[aliasOf(label)] = userId;
    else delete all[aliasOf(label)];
    localStorage.setItem(ALIAS_KEY, JSON.stringify(all));
  } catch {
    // ohne Speicher: Zuordnung gilt nur für diesen Abgleich
  }
}

// Aufeinanderfolgende Tage je Person + Titel zu einer Zeile zusammenfassen
function blocks(days: SchoolDay[]) {
  const byKey = new Map<string, SchoolDay[]>();
  for (const d of days) byKey.set(`${d.userId}|${d.title}|${d.from}|${d.to}`, [...(byKey.get(`${d.userId}|${d.title}|${d.from}|${d.to}`) ?? []), d]);
  return [...byKey.values()].flatMap((list) => groupDays(list, (d) => d.date).map((g) => ({ ...g.items[0], start: g.from, end: g.to, count: g.items.length })))
    .sort((a, b) => a.start.localeCompare(b.start));
}

export function SchoolImport() {
  const [people, setPeople] = useState<Person[]>([]);
  const [text, setText] = useState("");
  const [parsed, setParsed] = useState<IstParse | null>(null);
  const [assign, setAssign] = useState<Record<number, string>>({});
  const [existing, setExisting] = useState<DayEntry[] | null>(null);
  const [keep, setKeep] = useState<Set<string>>(new Set());
  const [message, setMessage] = useState<{ tone: "ok" | "error" | "warn"; text: string }>();
  const [busy, setBusy] = useState(false);
  const [lastSync, setLastSync] = useState<string | null>(null);

  const loadLast = useCallback(async () => {
    const { data } = await adminDb.from("shifts").select("updated_at").eq("import_source", IST_SOURCE)
      .order("updated_at", { ascending: false }).limit(1);
    setLastSync((data?.[0]?.updated_at as string | undefined) ?? null);
  }, []);

  useEffect(() => {
    void Promise.all([
      adminDb.from("users").select("id, first_name, last_name, home_location_id").eq("is_active", true).neq("role", "admin").order("first_name"),
      adminDb.from("locations").select("id, code, name").order("name"),
    ]).then(([users, locs]) => {
      registerStudios((locs.data ?? []) as Location[]);
      setPeople((users.data ?? []) as Person[]);
    });
    void loadLast();
  }, [loadLast]);

  const records = (parsed?.records ?? []).map((r, i) => (r.userId || !assign[i] ? r : { ...r, userId: assign[i] }));
  const cov = coverage(records);
  const plan = existing && cov ? planSync(schoolDays(records), existing, cov) : null;
  const name = (id: string) => {
    const p = people.find((x) => x.id === id);
    return p ? `${p.first_name} ${p.last_name}` : "?";
  };
  const avatar = (id: string) => {
    const p = people.find((x) => x.id === id);
    return <Avatar first={p?.first_name ?? "?"} last={p?.last_name} color={studioColor(p?.home_location_id)} />;
  };

  async function check() {
    setMessage(undefined);
    setKeep(new Set());
    const result = parseIst(text, people);
    // gemerkte Zuordnungen anwenden
    const aliases = loadAliases();
    setAssign(Object.fromEntries(result.records.flatMap((r, i) =>
      !r.userId && aliases[aliasOf(r.label)] && people.some((p) => p.id === aliases[aliasOf(r.label)]) ? [[i, aliases[aliasOf(r.label)]]] : [])));
    setParsed(result);
    setExisting(null);
    const c = coverage(result.records);
    if (!c) return setMessage({ tone: "warn", text: "Keine Termine erkannt. Bitte die ganze IST-Seite „Termine“ markieren (Strg+A), kopieren und hier einfügen." });
    const { data, error } = await adminDb
      .from("shifts")
      .select("*")
      .gte("starts_at", berlinToISO(c.from))
      .lt("starts_at", berlinToISO(addDays(c.to, 1)));
    if (error) return setMessage({ tone: "error", text: dbMessage(error) });
    setExisting((data ?? []) as DayEntry[]);
  }

  async function apply() {
    if (!plan) return;
    setBusy(true);
    const problems: string[] = [];
    const removeIds = plan.remove.filter((e) => !keep.has(e.id)).map((e) => e.id);
    if (removeIds.length) {
      const { error } = await adminDb.from("shifts").delete().in("id", removeIds);
      if (error) problems.push(`Löschen: ${dbMessage(error)}`);
    }
    for (const u of plan.update) {
      const { error } = await adminDb.from("shifts").update({
        starts_at: berlinToISO(u.day.date, u.day.from),
        ends_at: berlinToISO(u.day.date, u.day.to),
        note: IST_NOTE_PREFIX + u.day.title,
      }).eq("id", u.entry.id);
      if (error) problems.push(`${name(u.day.userId)} ${fmtDay(u.day.date)}: ${dbMessage(error)}`);
    }
    const rows = plan.add.map((d) => ({
      user_id: d.userId,
      shift_type: "vocational_school",
      location_id: null,
      starts_at: berlinToISO(d.date, d.from),
      ends_at: berlinToISO(d.date, d.to),
      note: IST_NOTE_PREFIX + d.title,
      import_source: IST_SOURCE,
    }));
    if (rows.length) {
      const { error } = await adminDb.from("shifts").insert(rows);
      // Fehler bei einem Tag (z. B. inzwischen eingetragene Schicht) → einzeln eintragen, Rest übernehmen
      if (error) {
        for (const row of rows) {
          const single = await adminDb.from("shifts").insert(row);
          if (single.error) problems.push(`${name(row.user_id)} ${fmtDay(berlinDate(row.starts_at))}: ${dbMessage(single.error)}`);
        }
      }
    }
    setBusy(false);
    const done = `${plan.add.length} neu, ${plan.update.length} angepasst, ${removeIds.length} entfernt.`;
    setMessage(problems.length
      ? { tone: "warn", text: `Übernommen mit Hinweisen (${done}) ${problems.join(" · ")}` }
      : { tone: "ok", text: `Schule übernommen: ${done}${plan.conflicts.length ? ` ${plan.conflicts.length} Tag(e) mit Schicht-Konflikt bitte im Dienstplan klären.` : ""}` });
    setParsed(null);
    setExisting(null);
    setText("");
    void loadLast();
  }

  const unknown = (parsed?.records ?? []).map((r, i) => ({ r, i })).filter(({ r }) => !r.userId && !r.cancelled);
  const cancelled = (parsed?.records ?? []).filter((r) => r.cancelled).length;
  const changes = plan ? plan.add.length + plan.update.length + plan.remove.filter((e) => !keep.has(e.id)).length : 0;

  return (
    <>
      <PageHeader title="Schule" subtitle="Termine aus dem IST-Bildungspartner übernehmen" />
      {message && <Notice tone={message.tone}>{message.text}</Notice>}

      {!plan && (
        <>
          <Section title="So geht's" footer={lastSync ? `Zuletzt abgeglichen: ${fmtDay(berlinDate(lastSync))} · alle 2 Wochen wiederholen.` : "Alle 2 Wochen wiederholen – geänderte Zeiten werden angepasst, Abgesagtes entfernt."}>
            <Row title="1. bildungspartner.ist.de → „Termine“ öffnen" subtitle="Liste einmal ganz nach unten scrollen, damit alle Termine geladen sind" />
            <Row title="2. Alles markieren und kopieren" subtitle="Strg+A, dann Strg+C (Mac: ⌘A, ⌘C)" />
            <Row title="3. Hier einfügen → „Prüfen“" subtitle="Fehlen Termine, einzeln nach Namen suchen und die Ausschnitte untereinander einfügen" />
          </Section>
          <Field label="Kopierte IST-Termine">
            <textarea id="ist-text" rows={8} value={text} onChange={(e) => setText(e.target.value)}
              placeholder="03.08.26 09:00 Uhr - 05.08.26 16:00 Uhr Adrian Hajdari Rückentraining …" />
          </Field>
          <button type="button" className="btn btn-primary btn-block" disabled={!text.trim() || people.length === 0} onClick={() => void check()}>
            Prüfen
          </button>
        </>
      )}

      {plan && parsed && (
        <>
          <div className="stats is-compact">
            <div className="stat"><span className="stat-label">Neu</span><span className="stat-value">{plan.add.length} <small>Tage</small></span></div>
            <div className="stat"><span className="stat-label">Geändert</span><span className="stat-value">{plan.update.length} <small>Tage</small></span></div>
            <div className="stat"><span className="stat-label">Entfällt</span><span className="stat-value">{plan.remove.length} <small>Tage</small></span></div>
            <div className="stat"><span className="stat-label">Konflikte</span><span className="stat-value">{plan.conflicts.length} <small>Tage</small></span></div>
          </div>
          <p className="muted small">
            {parsed.records.length} Termine erkannt · {plan.unchanged} Tage schon aktuell
            {cancelled ? ` · ${cancelled} abgesagt (übersprungen)` : ""}
            {parsed.monthOnly ? ` · ${parsed.monthOnly} nur mit Monat (noch ohne Datum, übersprungen)` : ""}
          </p>

          {unknown.length > 0 && (
            <Section title={`Name nicht erkannt (${unknown.length})`}
              footer="Person auswählen – wird für die nächsten Abgleiche gemerkt. Ohne Auswahl wird der Termin übersprungen. Tipp: Vor- und Nachname im Team wie bei IST schreiben.">
              {unknown.map(({ r, i }) => (
                <div key={i} className="list-item">
                  <Row title={r.label} subtitle={`${range(r.from, r.to)}${r.title ? ` · ${r.title}` : ""}`} />
                  <div className="list-actions">
                    <select aria-label="Person" value={assign[i] ?? ""}
                      onChange={(e) => { const v = e.target.value; saveAlias(r.label, v); setAssign((a) => ({ ...a, [i]: v })); }}>
                      <option value="">– überspringen –</option>
                      {people.map((p) => <option key={p.id} value={p.id}>{p.first_name} {p.last_name}</option>)}
                    </select>
                  </div>
                </div>
              ))}
            </Section>
          )}

          {plan.add.length > 0 && (
            <Section title="Neu eintragen">
              {blocks(plan.add).map((b) => (
                <Row key={`${b.userId}${b.start}${b.title}`} leading={avatar(b.userId)} title={name(b.userId)}
                  subtitle={`${range(b.start, b.end)} · ${b.from}–${b.to} Uhr${b.title ? ` · ${b.title}` : ""}`}
                  trailing={<span className="num">{b.count} {b.count === 1 ? "Tag" : "Tage"}</span>} />
              ))}
            </Section>
          )}

          {plan.update.length > 0 && (
            <Section title="Geändert">
              {plan.update.map((u) => (
                <Row key={u.entry.id} leading={avatar(u.day.userId)} title={name(u.day.userId)}
                  subtitle={`${fmtDay(u.day.date)} · vorher ${berlinTime(u.entry.starts_at)}–${berlinTime(u.entry.ends_at)}, jetzt ${u.day.from}–${u.day.to}${u.day.title ? ` · ${u.day.title}` : ""}`} />
              ))}
            </Section>
          )}

          {plan.remove.length > 0 && (
            <Section title="Entfällt (nicht mehr bei IST)" footer="Haken raus = Eintrag bleibt.">
              {plan.remove.map((e) => (
                <label key={e.id} className="list-row has-leading">
                  <input type="checkbox" checked={!keep.has(e.id)}
                    onChange={() => setKeep((k) => { const n = new Set(k); if (n.has(e.id)) n.delete(e.id); else n.add(e.id); return n; })} />
                  {avatar(e.user_id)}
                  <span className="list-row-main">
                    <span className="list-row-title">{name(e.user_id)}</span>
                    <span className="list-row-sub">{fmtDay(berlinDate(e.starts_at))}{e.note ? ` · ${e.note.replace(IST_NOTE_PREFIX, "")}` : ""}</span>
                  </span>
                </label>
              ))}
            </Section>
          )}

          {plan.conflicts.length > 0 && (
            <Section title="Konflikt mit geplanter Schicht" footer="Diese Schultage werden nicht eingetragen. Schicht im Dienstplan ändern oder löschen und erneut abgleichen.">
              {plan.conflicts.map((c) => (
                <Row key={`${c.day.userId}${c.day.date}`} className="has-studio" style={{ "--studio": "var(--warn)" } as CSSProperties}
                  leading={avatar(c.day.userId)} title={name(c.day.userId)}
                  subtitle={`${fmtDay(c.day.date)} · Schule ${c.day.from}–${c.day.to}, Schicht ${berlinTime(c.entry.starts_at)}–${berlinTime(c.entry.ends_at)}`} />
              ))}
            </Section>
          )}

          {plan.absent.length > 0 && (
            <Section title="Schon eingetragen / abwesend" footer="Bleibt wie es ist.">
              {plan.absent.map((a) => (
                <Row key={`${a.day.userId}${a.day.date}`} leading={avatar(a.day.userId)} title={name(a.day.userId)}
                  subtitle={`${fmtDay(a.day.date)} · ${SHIFT_TYPE_LABEL[a.entry.shift_type as ShiftType] ?? a.entry.shift_type}`} />
              ))}
            </Section>
          )}

          {changes === 0 && plan.conflicts.length === 0 && (
            <Empty icon="checkCircle" title="Alles aktuell">Der Dienstplan stimmt schon mit den IST-Terminen überein.</Empty>
          )}

          <div className="form-actions">
            <button type="button" className="btn btn-outline" disabled={busy} onClick={() => { setParsed(null); setExisting(null); }}>Zurück</button>
            <button type="button" className="btn btn-primary" disabled={busy || changes === 0} onClick={() => void apply()}>
              {busy ? "Übernimmt …" : `Übernehmen (${changes})`}
            </button>
          </div>
        </>
      )}
    </>
  );
}
