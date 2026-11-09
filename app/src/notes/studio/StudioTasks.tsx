// Wochen- & Monatsaufgaben: einmal anlegen, an alle oder ausgewählte Studios verteilen, Stand je Studio sehen
import { useState } from "react";
import { optionById } from "../database/logic";
import { Tag } from "../database/cells";
import { useNotes } from "../state";
import type { PageMeta, Studio } from "../types";
import { Icon } from "../ui/Icon";
import { Modal } from "../ui/Popover";
import { formatDate, shortId, today, untitled } from "../util";
import { useStudioRecurrence } from "./recurrence";
import { periodLabel, periodOf, periodRange, type Rhythm, shiftPeriod } from "./period";
import { createStudioRow, creatableStudios, ensureStudioDb, findStudioDb, RHYTHM_OWNER, STUDIO_PROPS } from "./studioDb";

export { findStudioDb, STUDIO_DB_ROLE, STUDIO_PROPS } from "./studioDb";
const P = STUDIO_PROPS;
const RHYTHM_LABEL: Record<Rhythm, string> = { week: "Woche", month: "Monat" };

export function StudioTasks() {
  const notes = useNotes();
  useStudioRecurrence();
  const [rhythm, setRhythm] = useState<Rhythm>("week");
  const [period, setPeriod] = useState(() => periodOf("week", today()));
  const [distribute, setDistribute] = useState(false);
  const db = findStudioDb(notes.pages, notes.isLive);
  const admin = notes.access.admin;
  // Wochenaufgaben: Studioleitung/Studio-PC fürs eigene Studio, Monatsaufgaben: Tobias & Dominik
  const allowedFor = (r: Rhythm) => creatableStudios(notes.access, notes.me, notes.locations, r);
  const allowed = allowedFor(rhythm);
  const canCreate = allowed.length > 0;
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
    const prev = rowsOf(shiftPeriod(period, -1)).filter((r) => allowed.includes(String(r.props[P.studio])));
    const existing = new Set(rows.map((r) => `${r.title}|${r.props[P.studio]}`));
    const prevGroups = new Map<string, PageMeta[]>();
    for (const r of prev) prevGroups.set(String(r.props[P.group] ?? r.id), [...(prevGroups.get(String(r.props[P.group] ?? r.id)) ?? []), r]);
    let n = 0;
    for (const list of prevGroups.values()) {
      const group = shortId();
      for (const r of list) {
        if (existing.has(`${r.title}|${r.props[P.studio]}`)) continue;
        await createStudioRow(notes, db, { title: r.title, studio: String(r.props[P.studio]), rhythm, period, group, due: periodRange(period).end, content: await notes.loadContent(r.id) });
        n++;
      }
    }
    notes.toast(n ? `${n} Aufgaben übernommen` : "Nichts zu übernehmen – alles schon da.");
  };

  return (
    <div className="nk-page is-full">
      <div className="nk-page-inner nk-studio-tasks">
        <div className="nk-st-head">
          <h1 className="nk-st-title">🗓️ Wochen- & Monatsaufgaben</h1>
          <span className="nk-spacer" />
          {canCreate && (
            <button type="button" className="nk-btn is-primary" onClick={() => setDistribute(true)}>
              <Icon name="plus" /> {admin ? "Aufgabe verteilen" : "Wochenaufgabe anlegen"}
            </button>
          )}
        </div>
        <div className="nk-st-bar">
          <div className="nk-segmented">
            {(["week", "month"] as const).map((r) => (
              <button key={r} type="button" aria-pressed={rhythm === r} onClick={() => switchRhythm(r)}>
                {RHYTHM_LABEL[r]} <small className="nk-muted">· {RHYTHM_OWNER[r]}</small>
              </button>
            ))}
          </div>
          <div className="nk-st-nav">
          <button type="button" className="nk-icon-btn" aria-label="Voriger Zeitraum" onClick={() => setPeriod(shiftPeriod(period, -1))}>
            <Icon name="chevronLeft" />
          </button>
          <b className="nk-st-period">{periodLabel(period)}</b>
          <button type="button" className="nk-icon-btn" aria-label="Nächster Zeitraum" onClick={() => setPeriod(shiftPeriod(period, 1))}>
            <Icon name="chevronRight" />
          </button>
          </div>
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
        <p className="nk-muted nk-st-hint">
          {rhythm === "week"
            ? "Wochenaufgaben legt die Studioleitung oder der Studio-PC fürs eigene Studio an – ohne Freigabe."
            : "Monatsaufgaben verteilen Tobias & Dominik an die Studios."}
        </p>

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
              {canCreate
                ? admin
                  ? " Lege eine Aufgabe an und verteile sie an die Studios."
                  : " Lege eine Wochenaufgabe für dein Studio an."
                : rhythm === "month"
                  ? " Sobald Tobias oder Dominik etwas verteilen, erscheint es hier."
                  : " Die Studioleitung legt sie an."}
            </p>
            {canCreate && (
              <div className="nk-row-gap">
                <button type="button" className="nk-btn is-primary" onClick={() => setDistribute(true)}>
                  <Icon name="plus" /> {admin ? "Aufgabe verteilen" : "Wochenaufgabe anlegen"}
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
        {canCreate && groups.size > 0 && db && rowsOf(shiftPeriod(period, -1)).length > 0 && (
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
          lead={notes.access.oversee}
          rhythm={rhythm}
          period={period}
          studiosFor={(r) => notes.locations.filter((l) => allowedFor(r).includes(l.id))}
          onClose={() => setDistribute(false)}
          onSubmit={async (v) => {
            const target = await ensureStudioDb(notes);
            const group = shortId();
            const content = v.description.trim() ? v.description.split("\n").map((line) => ({ type: "paragraph", content: line })) : undefined;
            for (const studio of v.studios) await createStudioRow(notes, target, { ...v, studio, group, content });
            setRhythm(v.rhythm);
            setPeriod(v.period);
            notes.toast(v.studios.length === 1 ? `„${v.title}“ angelegt` : `„${v.title}“ an ${v.studios.length} Studios verteilt`);
          }}
        />
      )}
    </div>
  );
}

function DistributeModal(props: {
  rhythm: Rhythm;
  period: string;
  /** Studios, für die ich Aufgaben dieses Rhythmus anlegen darf (leer = Rhythmus nicht erlaubt) */
  studiosFor: (rhythm: Rhythm) => Studio[];
  onClose: () => void;
  onSubmit: (v: { title: string; description: string; rhythm: Rhythm; period: string; due: string; studios: string[]; repeat: boolean; photo: boolean }) => Promise<void>;
  lead: boolean;
}) {
  const [repeat, setRepeat] = useState(false);
  const [photo, setPhoto] = useState(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const rhythms = (["week", "month"] as const).filter((r) => props.studiosFor(r).length > 0);
  const [rhythm, setRhythm] = useState<Rhythm>(rhythms.some((r) => r === props.rhythm) ? props.rhythm : (rhythms[0] ?? "week"));
  const studios = props.studiosFor(rhythm);
  const current = periodOf(rhythm, today());
  const [period, setPeriod] = useState(props.period >= current ? props.period : current);
  const [due, setDue] = useState("");
  const [selected, setSelected] = useState<string[]>(studios.map((s) => s.id));
  const [busy, setBusy] = useState(false);
  const choices = [current, shiftPeriod(current, 1), shiftPeriod(current, 2)];
  const effectiveDue = due || periodRange(period).end;
  const all = selected.length === studios.length;
  const single = studios.length === 1;

  return (
    <Modal onClose={props.onClose} label={single ? "Aufgabe anlegen" : "Aufgabe verteilen"} className="nk-distribute">
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (!title.trim() || !selected.length) return;
          setBusy(true);
          try {
            await props.onSubmit({ title: title.trim(), description, rhythm, period, due: effectiveDue, studios: selected, repeat, photo });
            props.onClose();
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="nk-modal-head">
          <b>{single ? `${rhythm === "week" ? "Wochenaufgabe" : "Monatsaufgabe"} für ${studios[0].name}` : "Aufgabe an Studios verteilen"}</b>
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
                {rhythms.map((r) => (
                  <button
                    key={r}
                    type="button"
                    aria-pressed={rhythm === r}
                    onClick={() => {
                      setRhythm(r);
                      setPeriod(periodOf(r, today()));
                      const next = props.studiosFor(r).map((s) => s.id);
                      setSelected((cur) => cur.filter((id) => next.includes(id)));
                    }}
                  >
                    {RHYTHM_LABEL[r]}
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
          <div className="nk-distribute-flags">
            <label>
              <input type="checkbox" checked={repeat} onChange={(e) => setRepeat(e.target.checked)} /> 🔁 {rhythm === "week" ? "jede Woche" : "jeden Monat"} neu anlegen
            </label>
            {props.lead && (
              <label>
                <input type="checkbox" checked={photo} onChange={(e) => setPhoto(e.target.checked)} /> 📷 Fotonachweis verlangen
              </label>
            )}
          </div>
          {!single && (
          <fieldset className="nk-distribute-studios">
            <legend>
              Studios{" "}
              <button type="button" className="nk-btn is-ghost" onClick={() => setSelected(all ? [] : studios.map((s) => s.id))}>
                {all ? "Keine" : "Alle"}
              </button>
            </legend>
            {studios.map((s) => (
              <label key={s.id} className="nk-check-label">
                <input
                  type="checkbox"
                  checked={selected.includes(s.id)}
                  onChange={(e) => setSelected((cur) => (e.target.checked ? [...cur, s.id] : cur.filter((x) => x !== s.id)))}
                />
                {s.name}
              </label>
            ))}
            {!studios.length && <p className="nk-muted">Keine Studios gefunden.</p>}
          </fieldset>
          )}
        </div>
        <div className="nk-modal-foot">
          <span className="nk-muted">{single ? "Gilt sofort – keine Freigabe nötig." : "Jedes Studio bekommt einen eigenen Eintrag mit eigenem Status."}</span>
          <span className="nk-spacer" />
          <button type="button" className="nk-btn" onClick={props.onClose}>
            Abbrechen
          </button>
          <button type="submit" className="nk-btn is-primary" disabled={busy || !title.trim() || !selected.length}>
            {single ? "Anlegen" : `An ${selected.length} ${selected.length === 1 ? "Studio" : "Studios"} verteilen`}
          </button>
        </div>
      </form>
    </Modal>
  );
}
