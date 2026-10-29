// Einstellungen für Formel, Verknüpfung und Rollup (im Menü einer Eigenschaft)
import { useRef, useState } from "react";
import { useNotes } from "../state";
import type { DbSchema, PageMeta, PropDef, RollupFn } from "../types";
import { Icon } from "../ui/Icon";
import { MenuItem, MenuLabel, Modal } from "../ui/Popover";
import { shortId, untitled } from "../util";
import { TYPE_ICONS, ValueView } from "./cells";
import { FUNCTION_NAMES } from "./formula";
import { formulaResult, ROLLUP_LABELS, rollupFnsFor } from "./logic";

type Props = { db: PageMeta; prop: PropDef; updateSchema: (fn: (s: DbSchema) => DbSchema) => void };

export function RelationConfig(props: Props) {
  const notes = useNotes();
  const { db, prop } = props;
  const dbs = [...notes.pages.values()].filter((p) => p.kind === "database" && p.schema && notes.isLive(p.id));
  const tid = prop.relation?.dbId;
  const target = tid ? notes.pages.get(tid) : undefined;
  const back = prop.relation?.backPropId;

  const setOwn = (relation: PropDef["relation"], extra: PropDef[] = [], drop?: string) =>
    props.updateSchema((s) => ({
      ...s,
      properties: [...s.properties.filter((p) => p.id !== drop).map((p) => (p.id === prop.id ? { ...p, relation } : p)), ...extra],
    }));

  const dropBackInTarget = () => {
    if (!back || !tid || tid === db.id) return;
    const t = notes.pages.get(tid);
    if (t?.schema) notes.updatePage(tid, { schema: { ...t.schema, properties: t.schema.properties.filter((p) => p.id !== back) } });
  };

  const chooseTarget = (id: string) => {
    if (id === tid) return;
    dropBackInTarget();
    setOwn({ dbId: id }, [], tid === db.id ? back : undefined);
  };

  const toggleTwoWay = () => {
    if (!tid || !target?.schema) return;
    if (back) {
      dropBackInTarget();
      return setOwn({ dbId: tid }, [], tid === db.id ? back : undefined);
    }
    const backId = shortId();
    const backProp: PropDef = { id: backId, name: untitled(db), type: "relation", relation: { dbId: db.id, backPropId: prop.id } };
    if (tid === db.id) setOwn({ dbId: tid, backPropId: backId }, [backProp]);
    else {
      setOwn({ dbId: tid, backPropId: backId });
      notes.updatePage(tid, { schema: { ...target.schema, properties: [...target.schema.properties, backProp] } });
    }
    // Bestehende Verknüpfungen auf der Gegenseite eintragen
    const reverse = new Map<string, string[]>();
    for (const r of notes.childrenOf(db.id)) {
      const ids = r.props[prop.id];
      if (Array.isArray(ids)) for (const id of ids) reverse.set(id, [...(reverse.get(id) ?? []), r.id]);
    }
    for (const [id, list] of reverse) {
      const t = notes.pages.get(id);
      if (t) notes.updatePage(id, { props: { ...t.props, [backId]: list } });
    }
  };

  return (
    <>
      <MenuLabel>Verknüpfen mit</MenuLabel>
      <div className="nk-pad">
        <select className="nk-input" value={tid ?? ""} onChange={(e) => e.target.value && chooseTarget(e.target.value)}>
          <option value="">– Datenbank wählen –</option>
          {dbs.map((d) => (
            <option key={d.id} value={d.id}>
              {d.icon ? `${d.icon} ` : ""}
              {untitled(d)}
              {d.id === db.id ? " (diese Datenbank)" : ""}
            </option>
          ))}
        </select>
      </div>
      {target && (
        <MenuItem
          icon="relation"
          label={tid === db.id ? "Gegenseitig verknüpfen" : `Auch in „${untitled(target)}“ anzeigen`}
          active={Boolean(back)}
          onClick={toggleTwoWay}
        />
      )}
    </>
  );
}

export function RollupConfig(props: { db: PageMeta; prop: PropDef; setProp: (patch: Partial<PropDef>) => void }) {
  const notes = useNotes();
  const schema = notes.pages.get(props.db.id)?.schema;
  const cfg = props.prop.rollup;
  const relations = schema?.properties.filter((p) => p.type === "relation" && p.relation) ?? [];
  const rel = relations.find((p) => p.id === cfg?.relationPropId);
  const targetSchema = rel?.relation ? notes.pages.get(rel.relation.dbId)?.schema : undefined;
  const target = targetSchema?.properties.find((p) => p.id === cfg?.targetPropId);
  const fns = rollupFnsFor(target?.type);
  const set = (patch: Partial<NonNullable<PropDef["rollup"]>>) => {
    const next = { relationPropId: "", targetPropId: "title", fn: "show" as RollupFn, ...cfg, ...patch };
    if (patch.relationPropId !== undefined && patch.relationPropId !== cfg?.relationPropId) next.targetPropId = "title";
    const t = notes.pages.get(relations.find((p) => p.id === next.relationPropId)?.relation?.dbId ?? "")?.schema?.properties.find((p) => p.id === next.targetPropId);
    if (!rollupFnsFor(t?.type).includes(next.fn)) next.fn = "show";
    props.setProp({ rollup: next });
  };

  if (!relations.length) return <div className="nk-empty-hint">Für ein Rollup braucht die Datenbank zuerst eine Verknüpfung.</div>;
  return (
    <>
      <MenuLabel>Rollup</MenuLabel>
      <div className="nk-pad nk-rollup-config">
        <label>
          <span className="nk-muted">Verknüpfung</span>
          <select className="nk-input" value={cfg?.relationPropId ?? ""} onChange={(e) => set({ relationPropId: e.target.value })}>
            <option value="">– wählen –</option>
            {relations.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        {targetSchema && (
          <label>
            <span className="nk-muted">Eigenschaft</span>
            <select className="nk-input" value={cfg?.targetPropId ?? "title"} onChange={(e) => set({ targetPropId: e.target.value })}>
              {targetSchema.properties.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
        )}
        {targetSchema && (
          <label>
            <span className="nk-muted">Berechnen</span>
            <select className="nk-input" value={cfg?.fn ?? "show"} onChange={(e) => set({ fn: e.target.value as RollupFn })}>
              {fns.map((f) => (
                <option key={f} value={f}>
                  {ROLLUP_LABELS[f]}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
    </>
  );
}

const FUNCTION_HELP: { sig: string; text: string }[] = [
  { sig: 'prop("Name")', text: "Wert einer Eigenschaft dieser Zeile" },
  { sig: "if(Bedingung, dann, sonst)", text: "Wert abhängig von einer Bedingung; ifs(b1, w1, b2, w2, sonst) für mehrere" },
  { sig: "a ? b : c", text: "Kurzform von if" },
  { sig: "and / or / not", text: "Bedingungen verknüpfen (auch && || !)" },
  { sig: "empty(x)", text: "Wahr, wenn x leer ist" },
  { sig: "concat(a, b, …)", text: "Texte aneinanderhängen (auch mit +)" },
  { sig: 'join(Liste, ", ")', text: "Listenwerte mit Trennzeichen verbinden" },
  { sig: "length(x) · contains(x, y)", text: "Länge; enthält Text oder Listeneintrag" },
  { sig: "lower · upper · trim · replace(t, a, b)", text: "Text umformen" },
  { sig: "round(x, Stellen) · floor · ceil · abs", text: "Runden und Beträge" },
  { sig: "min · max · sum · mean · count", text: "Über mehrere Werte oder Listen" },
  { sig: "today() · now()", text: "Heutiges Datum, aktueller Zeitpunkt" },
  { sig: 'dateAdd(Datum, 3, "days")', text: "Datum verschieben (days, weeks, months, years, hours, minutes)" },
  { sig: 'dateBetween(a, b, "days")', text: "Abstand zweier Daten in der Einheit" },
  { sig: 'formatDate(Datum, "DD.MM.YYYY")', text: "Datum als Text (YYYY, MM, DD, HH, mm, dddd, MMMM)" },
  { sig: "year · month · day · weekday", text: "Teile eines Datums" },
];

export function FormulaModal(props: { db: PageMeta; prop: PropDef; onClose: () => void; onSave: (formula: string) => void }) {
  const notes = useNotes();
  const [draft, setDraft] = useState(props.prop.formula ?? "");
  const area = useRef<HTMLTextAreaElement>(null);
  const schema = notes.pages.get(props.db.id)?.schema;
  const rows = notes.childrenOf(props.db.id).slice(0, 4);
  const temp: PropDef = { ...props.prop, formula: draft };
  const ctx = { pages: notes.pages, members: notes.members };
  const firstError = draft.trim() ? (rows.length ? rows.map((r) => formulaResult(r, temp, ctx).error).find(Boolean) : undefined) : undefined;

  const insert = (text: string) => {
    const el = area.current;
    const start = el?.selectionStart ?? draft.length;
    const end = el?.selectionEnd ?? draft.length;
    const next = draft.slice(0, start) + text + draft.slice(end);
    setDraft(next);
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(start + text.length, start + text.length);
    });
  };

  return (
    <Modal onClose={props.onClose} label="Formel bearbeiten" className="nk-formula-modal">
      <div className="nk-modal-head">
        <Icon name="formula" />
        <b>Formel: {props.prop.name}</b>
        <span className="nk-spacer" />
        <button type="button" className="nk-icon-btn" aria-label="Schließen" onClick={props.onClose}>
          <Icon name="close" />
        </button>
      </div>
      <div className="nk-formula-body">
        <textarea
          ref={area}
          autoFocus
          spellCheck={false}
          className="nk-formula-input"
          placeholder='z. B. prop("Preis") * prop("Menge")'
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
              props.onSave(draft);
              props.onClose();
            }
          }}
        />
        <div className={`nk-formula-status${firstError ? " is-error" : ""}`}>{firstError ? firstError : draft.trim() ? "Formel ist gültig." : "Noch keine Formel."}</div>
        {rows.length > 0 && draft.trim() && (
          <div className="nk-formula-preview">
            <div className="nk-menu-section">Vorschau</div>
            {rows.map((r) => (
              <div key={r.id} className="nk-formula-row">
                <span className="nk-muted">{untitled(r)}</span>
                <span>{formulaResult(r, temp, ctx).error ? <span className="nk-formula-error">Fehler</span> : <ValueView row={r} prop={temp} />}</span>
              </div>
            ))}
          </div>
        )}
        <div className="nk-formula-help">
          <div>
            <div className="nk-menu-section">Eigenschaften</div>
            <div className="nk-formula-chips">
              {schema?.properties
                .filter((p) => p.id !== props.prop.id)
                .map((p) => (
                  <button key={p.id} type="button" className="nk-chip is-filter" onClick={() => insert(`prop("${p.name}")`)}>
                    <Icon name={TYPE_ICONS[p.type]} size={12} /> {p.name}
                  </button>
                ))}
            </div>
            <div className="nk-menu-section">Funktionen</div>
            <div className="nk-formula-chips">
              {FUNCTION_NAMES.filter((f) => !["format", "tostring"].includes(f)).map((f) => (
                <button key={f} type="button" className="nk-chip is-filter" onClick={() => insert(`${f}(`)}>
                  {f}
                </button>
              ))}
            </div>
          </div>
          <dl className="nk-formula-docs">
            {FUNCTION_HELP.map((h) => (
              <div key={h.sig}>
                <dt>{h.sig}</dt>
                <dd>{h.text}</dd>
              </div>
            ))}
          </dl>
        </div>
      </div>
      <div className="nk-modal-foot">
        <span className="nk-muted">Strg+Enter übernimmt</span>
        <span className="nk-spacer" />
        <button type="button" className="nk-btn" onClick={props.onClose}>
          Abbrechen
        </button>
        <button
          type="button"
          className="nk-btn is-primary"
          onClick={() => {
            props.onSave(draft);
            props.onClose();
          }}
        >
          Übernehmen
        </button>
      </div>
    </Modal>
  );
}
