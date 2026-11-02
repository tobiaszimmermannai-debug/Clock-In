// 📌 Jede Aufgabe zur Tagesaufgabe machen (oben angepinnt, heute) – direkt an der Aufgabe, auch am Handy.
// Leitung pinnt für sich oder andere (sofort gültig), Mitarbeiter für sich (wartet auf Freigabe).
import { useState } from "react";
import { personDay } from "../daily/status";
import { useNotes } from "../state";
import type { Member, PageMeta } from "../types";
import { MenuItem, MenuLabel, Popover, usePopover } from "../ui/Popover";
import { today } from "../util";
import { focusEntry, MAX_FOCUS } from "./focus";
import { assigneesOf } from "./tasks";

/** Für wen darf ich diese Aufgabe anpinnen? Ich (handelnde Person) zuerst, dann Zuständige, dann das Studio */
export function pinTargets(input: { actor: Member | null; lead: boolean; members: Member[]; assignees: string[]; studioId?: string | null }): Member[] {
  const people = input.members.filter((m) => !m.device);
  const actor = input.actor && !input.actor.device ? input.actor : null;
  if (!input.lead) return actor ? [actor] : [];
  const out: Member[] = [];
  const add = (m: Member | undefined) => m && !out.some((x) => x.id === m.id) && out.push(m);
  add(actor ?? undefined);
  for (const id of input.assignees) add(people.find((m) => m.id === id));
  const studio = input.studioId ?? actor?.studioId;
  if (studio) for (const m of people.filter((x) => x.studioId === studio).sort((a, b) => a.name.localeCompare(b.name, "de"))) add(m);
  return out;
}

export function PinButton(props: { row: PageMeta; full?: boolean }) {
  const notes = useNotes();
  const pop = usePopover();
  const day = today();
  const actor = notes.actor && !notes.actor.device ? notes.actor : null;
  const mine = actor ? focusEntry(props.row, actor.id, day) : null;
  const others = pinnedToday(props.row, day).filter((p) => p.userId !== actor?.id).length;
  if (!notes.access.oversee && !actor) return null;
  const label = mine ? (mine.pending ? "Wartet auf Freigabe" : `Tagesaufgabe ${mine.rank}`) : "Als Tagesaufgabe";
  return (
    <>
      <button
        type="button"
        className={`nk-pin-btn${mine ? " is-on" : ""}${mine?.pending ? " is-pending" : ""}${props.full ? " is-full" : ""}`}
        aria-label={mine ? `${label} – ändern` : "Als Tagesaufgabe anpinnen"}
        title={mine ? label : "Als Tagesaufgabe anpinnen"}
        onClick={(e) => {
          e.stopPropagation();
          pop.toggle(e.currentTarget);
        }}
      >
        <span aria-hidden>{mine?.pending ? "⏳" : "📌"}</span>
        {props.full && <span>{label}</span>}
        {others > 0 && <small>+{others}</small>}
      </button>
      {pop.anchor && (
        <Popover anchor={pop.anchor} onClose={pop.close} width={300}>
          <PinMenu row={props.row} onDone={pop.close} />
        </Popover>
      )}
    </>
  );
}

function pinnedToday(row: PageMeta, day: string) {
  const raw = row.props.__focus as unknown;
  const map = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, string>) : {};
  return Object.keys(map)
    .map((userId) => ({ userId, entry: focusEntry(row, userId, day) }))
    .filter((x) => x.entry !== null);
}

function PinMenu(props: { row: PageMeta; onDone: () => void }) {
  const notes = useNotes();
  const day = today();
  const lead = notes.access.oversee;
  const db = props.row.parentId ? notes.pages.get(props.row.parentId) : undefined;
  const assignees = db?.schema ? assigneesOf(props.row, db.schema) : [];
  const targets = pinTargets({
    actor: notes.actor,
    lead,
    members: notes.members,
    assignees,
    studioId: notes.access.studio ? notes.access.studioLocationId : undefined,
  });
  const [extra, setExtra] = useState<string[]>([]);
  // Wer heute schon angepinnt hat, steht immer mit drin (zum Lösen)
  const pinned = pinnedToday(props.row, day).map((p) => p.userId);
  const list = [...targets, ...[...pinned, ...extra].map((id) => notes.members.find((m) => m.id === id)).filter((m): m is Member => Boolean(m))].filter(
    (m, i, all) => all.findIndex((x) => x.id === m.id) === i && (lead || targets.some((t) => t.id === m.id)),
  );
  const rest = lead ? notes.members.filter((m) => !m.device && !list.some((x) => x.id === m.id)).sort((a, b) => a.name.localeCompare(b.name, "de")) : [];

  return (
    <>
      <MenuLabel>📌 Heute als Tagesaufgabe{lead ? "" : " (Freigabe durch die Leitung)"}</MenuLabel>
      {list.map((m) => {
        const entry = focusEntry(props.row, m.id, day);
        const status = personDay(notes.dayStatus, m.id);
        const count = status?.focus.length ?? 0;
        const full = !entry && count >= MAX_FOCUS;
        const name = m.id === notes.actor?.id ? `Für mich (${m.name.split(" ")[0]})` : `Für ${m.name.split(" ")[0]}`;
        return (
          <MenuItem
            key={m.id}
            icon={<span>{entry ? (entry.pending ? "⏳" : "📌") : "＋"}</span>}
            label={name}
            hint={entry ? "lösen" : full ? `${MAX_FOCUS}/${MAX_FOCUS} belegt` : status?.absent ? "abwesend" : `${count}/${MAX_FOCUS}`}
            active={Boolean(entry)}
            disabled={full}
            onClick={() => {
              notes.setFocus(props.row.id, m.id, entry ? null : count + 1);
              notes.toast(entry ? "Tagesaufgabe gelöst" : lead ? `Tagesaufgabe für ${m.name.split(" ")[0]} angepinnt` : "Angepinnt – wartet auf Freigabe");
              props.onDone();
            }}
          />
        );
      })}
      {!list.length && <p className="nk-muted nk-pin-empty">Erst einchecken bzw. einen Reiter öffnen.</p>}
      {rest.length > 0 && (
        <select className="nk-input nk-pin-other" value="" onChange={(e) => e.target.value && setExtra((x) => [...x, e.target.value])} aria-label="Andere Person">
          <option value="">Andere Person …</option>
          {rest.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </select>
      )}
      {list.some((m) => !focusEntry(props.row, m.id, day) && (personDay(notes.dayStatus, m.id)?.focus.length ?? 0) >= MAX_FOCUS) && (
        <p className="nk-muted nk-pin-empty">Volle Tage: erst eine Tagesaufgabe erledigen oder lösen.</p>
      )}
    </>
  );
}
