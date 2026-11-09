// Schichtwünsche im Portal: Tag (heute bis 8 Wochen), Studio und genau eine Lage – früh, mittel oder spät.
// Keine freien Uhrzeiten: Die Zeiten der Lagen werden nur angezeigt. Die Studioleitung gibt frei oder lehnt ab.
import { useCallback, useEffect, useState } from "react";
import { WishNotice, WishRow } from "../components/Wishes";
import { Field, Notice, Section, Sheet } from "../components/ui";
import { berlinDate, fmtLongDay } from "../lib/dates";
import { dbMessage } from "../lib/errors";
import { portalDb } from "../lib/supabase";
import { type Location, studioShort } from "../lib/types";
import { SLOT_LABEL, SLOTS, type Slot, type SlotTime, type Wish, wishRange } from "../lib/wishes";
import type { Me } from "./PortalApp";

/** Eigene Wünsche ab heute (offen und abgelehnt) – fürs Portal */
function useMyWishes(meId: string) {
  const [wishes, setWishes] = useState<Wish[]>([]);
  const [slots, setSlots] = useState<SlotTime[]>([]);
  const [missing, setMissing] = useState(false);
  const reload = useCallback(async () => {
    const [w, s] = await Promise.all([
      portalDb
        .from("shift_wishes")
        .select("id, user_id, location_id, day, slot, status, user:users!shift_wishes_user_id_fkey(first_name, last_name, home_location_id)")
        .eq("user_id", meId)
        .gte("day", berlinDate())
        .neq("status", "approved")
        .order("day"),
      portalDb.from("shift_slots").select("location_id, slot, starts, ends"),
    ]);
    setMissing(Boolean(w.error));
    setWishes(w.error ? [] : ((w.data ?? []) as unknown as Wish[]));
    setSlots(s.error ? [] : ((s.data ?? []) as SlotTime[]));
  }, [meId]);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { wishes, slots, missing, reload };
}

export function MyWishes(props: { me: Me; locations: Location[]; onChanged?: () => void }) {
  const { wishes, slots, missing, reload } = useMyWishes(props.me.id);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string>();
  if (missing) return null; // SQL-Update noch nicht eingespielt
  const studioName = (id: string) => studioShort(props.locations.find((l) => l.id === id)?.name ?? "");

  async function withdraw(w: Wish) {
    setBusy(w.id);
    const { error } = await portalDb.rpc("shift_wish_withdraw", { p_id: w.id });
    setBusy(null);
    setError(error ? dbMessage(error) : undefined);
    void reload();
    props.onChanged?.();
  }

  return (
    <>
      <Section title="Meine Schichtwünsche" aside={<span>{wishes.filter((w) => w.status === "open").length} offen</span>}>
        {wishes.length === 0 && <p className="list-empty">Noch keine Wünsche eingetragen.</p>}
        {wishes.map((w) => (
          <WishRow key={w.id} wish={w} slots={slots} showDay studioName={studioName(w.location_id)} busy={busy === w.id}
            onWithdraw={w.status === "open" ? () => void withdraw(w) : undefined} />
        ))}
      </Section>
      {wishes.length > 0 && <WishNotice />}
      {error && <Notice tone="error">{error}</Notice>}
      <button type="button" className="btn btn-outline btn-block" onClick={() => setOpen(true)}>Schichtwunsch eintragen</button>
      {open && (
        <WishSheet me={props.me} locations={props.locations} slots={slots} onClose={() => setOpen(false)}
          onSaved={() => {
            setOpen(false);
            void reload();
            props.onChanged?.();
          }} />
      )}
    </>
  );
}

function WishSheet(props: { me: Me; locations: Location[]; slots: SlotTime[]; onClose: () => void; onSaved: () => void }) {
  const range = wishRange();
  const [day, setDay] = useState(range.from);
  const [studio, setStudio] = useState(props.me.home_location_id ?? props.locations[0]?.id ?? "");
  const [slot, setSlot] = useState<Slot | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const valid = Boolean(day && day >= range.from && day <= range.to && studio && slot);

  async function save() {
    if (!valid || !slot) return;
    setBusy(true);
    const { error } = await portalDb.rpc("shift_wish_create", { p_location: studio, p_day: day, p_slot: slot });
    setBusy(false);
    if (error) return setError(dbMessage(error));
    props.onSaved();
  }

  return (
    <Sheet title="Schichtwunsch" subtitle="früh, mittel oder spät" onClose={props.onClose}
      footer={<button type="button" className="btn btn-primary btn-block" disabled={!valid || busy} onClick={() => void save()}>{busy ? "Speichern …" : "Wunsch eintragen"}</button>}>
      <WishNotice />
      <Field label="Tag" hint={`Heute bis ${fmtLongDay(range.to)} (8 Wochen)`}>
        <input id="wish-day" type="date" value={day} min={range.from} max={range.to} required
          onChange={(e) => setDay(e.target.value)} />
      </Field>
      <Field label="Studio">
        <select id="wish-studio" value={studio} onChange={(e) => setStudio(e.target.value)}>
          {props.locations.map((l) => <option key={l.id} value={l.id}>{studioShort(l.name)}</option>)}
        </select>
      </Field>
      <div className="wish-slots" role="group" aria-label="Lage">
        {SLOTS.map((s) => (
          <button key={s} type="button" className="wish-slot" aria-pressed={slot === s} onClick={() => setSlot(s)}>
            {SLOT_LABEL[s]}
          </button>
        ))}
      </div>
      <p className="muted small">Die genauen Zeiten legt die Studioleitung beim Eintragen fest.</p>
      {error && <Notice tone="error">{error}</Notice>}
    </Sheet>
  );
}
