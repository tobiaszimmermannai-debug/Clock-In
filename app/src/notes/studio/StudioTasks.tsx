// Wochen- & Monatsaufgaben: einmal anlegen, an alle oder ausgewählte Studios verteilen, Stand je Studio sehen
import { useState } from "react";
import { newView, optionById, STATUS_DEFAULTS } from "../database/logic";
import { Tag } from "../database/cells";
import { useNotes } from "../state";
import type { Color, DbSchema, PageMeta, PropDef, Studio } from "../types";
import { Icon } from "../ui/Icon";
import { Modal } from "../ui/Popover";
import { COLORS, formatDate, shortId, today, untitled } from "../util";
import { periodLabel, periodOf, periodRange, type Rhythm, shiftPeriod } from "./period";

export const STUDIO_DB_ROLE = "studio_tasks";

// Feste Eigenschafts-IDs, damit die Übersicht die Spalten findet
export const STUDIO_PROPS = { studio: "studio", rhythm: "rhythm", period: "period", status: "status", assignee: "assignee", due: "due", group: "group" } as const;
const P = STUDIO_PROPS;

function studioOptions(locations: Studio[]) {
  return locations.map((l, i) => ({ id: l.id, name: l.name, color: COLORS[1 + (i % (COLORS.length - 1))] as Color }));
}

function studioSchema(locations: Studio[]): DbSchema {
  const props: PropDef[] = [
    { id: "title", name: "Aufgabe", type: "title" },
    { id: P.studio, name: "Studio", type: "select", options: studioOptions(locations) },
    {
      id: P.rhythm,
      name: "Rhythmus",
      type: "select",
      options: [
        { id: "week", name: "Woche", color: "blue" },
        { id: "month", name: "Monat", color: "purple" },
      ],
    },
    { id: P.period, name: "Zeitraum", type: "text" },
    { id: P.status, name: "Status", type: "status", options: STATUS_DEFAULTS() },
    { id: P.assignee, name: "Zuständig", type: "person" },
    { id: P.due, name: "Fällig", type: "date" },
    { id: P.group, name: "Verteilung", type: "text" },
  ];
  const schema: DbSchema = { properties: props, views: [], role: STUDIO_DB_ROLE };
  const all = newView("table", schema, "Alle");
  all.hidden = [P.group];
  all.sorts = [{ prop: P.due, dir: "asc" }];
  const byStudio = newView("board", schema, "Nach Studio");
  byStudio.groupBy = P.studio;
  byStudio.hidden = [P.group, P.period];
  const byStatus = newView("board", schema, "Nach Status");
  byStatus.groupBy = P.status;
  byStatus.hidden = [P.group, P.period];
  schema.views = [all, byStudio, byStatus];
  return schema;
}

export function findStudioDb(pages: Map<string, PageMeta>, isLive: (id: string) => boolean): PageMeta | undefined {
  return [...pages.values()].find((p) => p.kind === "database" && p.schema?.role === STUDIO_DB_ROLE && isLive(p.id));
}

export function StudioTasks() {
  const notes = useNotes();
  const [rhythm, setRhythm] = useState<Rhythm>("week");
  const [period, setPeriod] = useState(() => periodOf("week", today()));
  const [distribute, setDistribute] = useState(false);
  const db = findStudioDb(notes.pages, notes.isLive);
  const admin = notes.access.admin;
  const ownStudio = notes.access.studio ? notes.access.studioLocationId : notes.actor?.studioId;

  const rowsOf = (p: string) => (db ? notes.childrenOf(db.id).filter((r) => r.props[P.rhythm] === rhythm && r.props[P.period] === p) : []);
  const rows = rowsOf(period);
  const statusProp = db?.schema?.properties.find((p) => p.id === P.status);
  const isDoneRow = (r: PageMeta) => optionById(statusProp ?? { id: "", name: "", type: "status" }, r.props[P.status])?.group === "done";

  // Spalten: alle Studios, eigenes Studio zuerst
  const studios = [...notes.locations].sort((a, b) => Number(b.id === ownStudio) - Number(a.id === ownStudio));
  const groups = new Map<string, PageMeta[]>();
  for (const r of rows) {
    const key = String(r.props[P.group] ?? r.id);
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  const done = rows.filter(isDoneRow).length;

  const switchRhythm = (r: Rhythm) => {
    setRhythm(r);
    setPeriod(periodOf(r, today()));
  };

  // Aufgaben des vorigen Zeitraums übernehmen (nur, was hier noch fehlt)
  const copyPrevious = async () => {
    if (!db?.schema) return;
    const prev = rowsOf(shiftPeriod(period, -1));
    const existing = new Set(rows.map((r) => `${r.title}|${r.props[P.studio]}`));
    const prevGroups = new Map<string, PageMeta[]>();
    for (const r of prev) prevGroups.set(String(r.props[P.group] ?? r.id), [...(prevGroups.get(String(r.props[P.group] ?? r.id)) ?? []), r]);
    let n = 0;
    for (const list of prevGroups.values()) {
      const group = shortId();
      for (const r of list) {
        if (existing.has(`${r.title}|${r.props[P.studio]}`)) continue;
        await createRow(db, { title: r.title, studio: String(r.props[P.studio]), rhythm, period, group, due: periodRange(period).end, content: await notes.loadContent(r.id) });
        n++;
      }
    }
    notes.toast(n ? `${n} Aufgaben übernommen` : "Nichts zu übernehmen – alles schon da.");
  };

  const createRow = (target: PageMeta, v: { title: string; studio: string; rhythm: Rhythm; period: string; group: string; due: string; content?: unknown[] }) => {
    const todo = target.schema?.properties.find((p) => p.id === P.status)?.options?.find((o) => (o.group ?? "todo") === "todo");
    return notes.createPage({
      parentId: target.id,
      title: v.title,
      props: { [P.studio]: v.studio, [P.rhythm]: v.rhythm, [P.period]: v.period, [P.status]: todo?.id ?? null, [P.due]: v.due, [P.group]: v.group },
      content: v.content,
    });
  };

  const ensureDb = async (): Promise<PageMeta> => {
    const found = findStudioDb(notes.pages, notes.isLive);
    if (found?.schema) {
      // Neue Studios als Auswahl ergänzen
      const studioProp = found.schema.properties.find((p) => p.id === P.studio);
      const missing = studioOptions(notes.locations).filter((o) => !studioProp?.options?.some((x) => x.id === o.id));
      if (studioProp && missing.length) {
        notes.updatePage(found.id, {
          schema: { ...found.schema, properties: found.schema.properties.map((p) => (p.id === P.studio ? { ...p, options: [...(p.options ?? []), ...missing] } : p)) },
        });
      }
      return found;
    }
    return notes.createPage({ space: "team", kind: "database", title: "Wochen- & Monatsaufgaben", icon: "🗓️", schema: studioSchema(notes.locations) });
  };

  return (
    <div className="nk-page is-full">
      <div className="nk-page-inner nk-studio-tasks">
        <div className="nk-st-head">
          <h1 className="nk-st-title">🗓️ Wochen- & Monatsaufgaben</h1>
          <span className="nk-spacer" />
          {admin && (
            <button type="button" className="nk-btn is-primary" onClick={() => setDistribute(true)}>
              <Icon name="plus" /> Aufgabe verteilen
            </button>
          )}
        </div>
        <div className="nk-st-bar">
          <div className="nk-segmented">
            {(["week", "month"] as const).map((r) => (
              <button key={r} type="button" aria-pressed={rhythm === r} onClick={() => switchRhythm(r)}>
                {r === "week" ? "Woche" : "Monat"}
              </button>
            ))}
          </div>
          <button type="button" className="nk-icon-btn" aria-label="Voriger Zeitraum" onClick={() => setPeriod(shiftPeriod(period, -1))}>
            <Icon name="chevronLeft" />
          </button>
          <b className="nk-st-period">{periodLabel(period)}</b>
          <button type="button" className="nk-icon-btn" aria-label="Nächster Zeitraum" onClick={() => setPeriod(shiftPeriod(period, 1))}>
            <Icon name="chevronRight" />
          </button>
          {period !== periodOf(rhythm, today()) && (
            <button type="button" className="nk-btn is-ghost" onClick={() => setPeriod(periodOf(rhythm, today()))}>
              {rhythm === "week" ? "Diese Woche" : "Dieser Monat"}
            </button>
          )}
          <span className="nk-spacer" />
          {rows.length > 0 && (
            <div className="nk-st-progress" title={`${done} von ${rows.length} erledigt`}>
              <span style={{ width: `${(done / rows.length) * 100}%` }} />
              <b>
                {done}/{rows.length} erledigt
              </b>
            </div>
          )}
        </div>

        {groups.size ? (
          <div className="nk-st-matrix-wrap">
            <table className="nk-st-matrix">
              <thead>
                <tr>
                  <th>Aufgabe</th>
                  {studios.map((s) => (
                    <th key={s.id} className={s.id === ownStudio ? "is-own" : ""}>
                      {s.name}
                    </th>
                  ))}
                  <th>Stand</th>
                </tr>
              </thead>
              <tbody>
                {[...groups.values()].map((list) => {
                  const first = list[0];
                  const groupDone = list.filter(isDoneRow).length;
                  return (
                    <tr key={String(first.props[P.group] ?? first.id)}>
                      <th scope="row">
                        <span className="nk-st-task">{untitled(first)}</span>
                        {first.props[P.due] ? <small className="nk-muted"> · bis {formatDate(String(first.props[P.due]))}</small> : null}
                      </th>
                      {studios.map((s) => {
                        const r = list.find((x) => x.props[P.studio] === s.id);
                        const o = r && statusProp ? optionById(statusProp, r.props[P.status]) : undefined;
                        return (
                          <td key={s.id} className={s.id === ownStudio ? "is-own" : ""}>
                            {r ? (
                              <button type="button" className="nk-st-cell" onClick={() => notes.openPeek(r.id)} title="Öffnen">
                                {o ? <Tag option={o} status /> : <span className="nk-muted">offen</span>}
                              </button>
                            ) : (
                              <span className="nk-faint">–</span>
                            )}
                          </td>
                        );
                      })}
                      <td className="nk-st-sum">
                        {groupDone}/{list.length}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr>
                  <th>Erledigt je Studio</th>
                  {studios.map((s) => {
                    const mine = rows.filter((r) => r.props[P.studio] === s.id);
                    const pct = mine.length ? Math.round((mine.filter(isDoneRow).length / mine.length) * 100) : null;
                    return (
                      <td key={s.id} className={s.id === ownStudio ? "is-own" : ""}>
                        {pct === null ? <span className="nk-faint">–</span> : <span className={`nk-st-pct${pct === 100 ? " is-full" : ""}`}>{pct} %</span>}
                      </td>
                    );
                  })}
                  <td />
                </tr>
              </tfoot>
            </table>
          </div>
        ) : (
          <div className="nk-home-empty">
            <p className="nk-muted">
              Für {periodLabel(period)} gibt es noch keine {rhythm === "week" ? "Wochen" : "Monats"}aufgaben.
              {admin ? " Lege eine Aufgabe an und verteile sie an die Studios." : " Sobald Tobias oder Dominik etwas verteilen, erscheint es hier."}
            </p>
            {admin && (
              <div className="nk-row-gap">
                <button type="button" className="nk-btn is-primary" onClick={() => setDistribute(true)}>
                  <Icon name="plus" /> Aufgabe verteilen
                </button>
                {db && rowsOf(shiftPeriod(period, -1)).length > 0 && (
                  <button type="button" className="nk-btn" onClick={() => void copyPrevious()}>
                    Aus {rhythm === "week" ? "Vorwoche" : "Vormonat"} übernehmen
                  </button>
                )}
              </div>
            )}
          </div>
        )}
        {admin && groups.size > 0 && db && rowsOf(shiftPeriod(period, -1)).length > 0 && (
          <button type="button" className="nk-btn is-ghost nk-st-copy" onClick={() => void copyPrevious()}>
            Fehlende Aufgaben aus {rhythm === "week" ? "Vorwoche" : "Vormonat"} übernehmen
          </button>
        )}
        {db && (
          <button type="button" className="nk-btn is-ghost nk-st-copy" onClick={() => notes.navigate(db.id)}>
            <Icon name="database" /> Alle Einträge als Datenbank öffnen
          </button>
        )}
      </div>
      {distribute && (
        <DistributeModal
          rhythm={rhythm}
          period={period}
          studios={notes.locations}
          onClose={() => setDistribute(false)}
          onSubmit={async (v) => {
            const target = await ensureDb();
            const group = shortId();
            const content = v.description.trim() ? v.description.split("\n").map((line) => ({ type: "paragraph", content: line })) : undefined;
            for (const studio of v.studios) await createRow(target, { ...v, studio, group, content });
            setRhythm(v.rhythm);
            setPeriod(v.period);
            notes.toast(`„${v.title}“ an ${v.studios.length} ${v.studios.length === 1 ? "Studio" : "Studios"} verteilt`);
          }}
        />
      )}
    </div>
  );
}

function DistributeModal(props: {
  rhythm: Rhythm;
  period: string;
  studios: Studio[];
  onClose: () => void;
  onSubmit: (v: { title: string; description: string; rhythm: Rhythm; period: string; due: string; studios: string[] }) => Promise<void>;
}) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [rhythm, setRhythm] = useState<Rhythm>(props.rhythm);
  const current = periodOf(rhythm, today());
  const [period, setPeriod] = useState(props.period >= current ? props.period : current);
  const [due, setDue] = useState("");
  const [selected, setSelected] = useState<string[]>(props.studios.map((s) => s.id));
  const [busy, setBusy] = useState(false);
  const choices = [current, shiftPeriod(current, 1), shiftPeriod(current, 2)];
  const effectiveDue = due || periodRange(period).end;
  const all = selected.length === props.studios.length;

  return (
    <Modal onClose={props.onClose} label="Aufgabe verteilen" className="nk-distribute">
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (!title.trim() || !selected.length) return;
          setBusy(true);
          try {
            await props.onSubmit({ title: title.trim(), description, rhythm, period, due: effectiveDue, studios: selected });
            props.onClose();
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="nk-modal-head">
          <b>Aufgabe an Studios verteilen</b>
          <span className="nk-spacer" />
          <button type="button" className="nk-icon-btn" aria-label="Schließen" onClick={props.onClose}>
            <Icon name="close" />
          </button>
        </div>
        <div className="nk-distribute-body">
          <label>
            <span>Aufgabe</span>
            <input autoFocus required className="nk-input" placeholder="z. B. Geräte-Check und Elektroden reinigen" value={title} onChange={(e) => setTitle(e.target.value)} />
          </label>
          <label>
            <span>Beschreibung (optional)</span>
            <textarea className="nk-input nk-textarea" rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />
          </label>
          <div className="nk-distribute-row">
            <label>
              <span>Rhythmus</span>
              <div className="nk-segmented">
                {(["week", "month"] as const).map((r) => (
                  <button
                    key={r}
                    type="button"
                    aria-pressed={rhythm === r}
                    onClick={() => {
                      setRhythm(r);
                      setPeriod(periodOf(r, today()));
                    }}
                  >
                    {r === "week" ? "Woche" : "Monat"}
                  </button>
                ))}
              </div>
            </label>
            <label>
              <span>Zeitraum</span>
              <select className="nk-input" value={period} onChange={(e) => setPeriod(e.target.value)}>
                {choices.map((c) => (
                  <option key={c} value={c}>
                    {periodLabel(c)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>Fällig</span>
              <input type="date" className="nk-input" value={effectiveDue} onChange={(e) => setDue(e.target.value)} />
            </label>
          </div>
          <fieldset className="nk-distribute-studios">
            <legend>
              Studios{" "}
              <button type="button" className="nk-btn is-ghost" onClick={() => setSelected(all ? [] : props.studios.map((s) => s.id))}>
                {all ? "Keine" : "Alle"}
              </button>
            </legend>
            {props.studios.map((s) => (
              <label key={s.id} className="nk-check-label">
                <input
                  type="checkbox"
                  checked={selected.includes(s.id)}
                  onChange={(e) => setSelected((cur) => (e.target.checked ? [...cur, s.id] : cur.filter((x) => x !== s.id)))}
                />
                {s.name}
              </label>
            ))}
            {!props.studios.length && <p className="nk-muted">Keine Studios gefunden.</p>}
          </fieldset>
        </div>
        <div className="nk-modal-foot">
          <span className="nk-muted">Jedes Studio bekommt einen eigenen Eintrag mit eigenem Status.</span>
          <span className="nk-spacer" />
          <button type="button" className="nk-btn" onClick={props.onClose}>
            Abbrechen
          </button>
          <button type="submit" className="nk-btn is-primary" disabled={busy || !title.trim() || !selected.length}>
            An {selected.length} {selected.length === 1 ? "Studio" : "Studios"} verteilen
          </button>
        </div>
      </form>
    </Modal>
  );
}
