// Schichtwünsche: Mitarbeitende wählen pro Tag nur eine Lage (früh / mittel / spät), keine freien Uhrzeiten.
// Die Studioleitung gibt frei (→ feste Schicht mit den Zeiten der Lage) oder lehnt ab. Admins bekommen nichts.
import type { SupabaseClient } from "@supabase/supabase-js";
import { useCallback, useEffect, useState } from "react";
import { addDays, berlinDate, berlinToISO } from "./dates";

export type Slot = "early" | "mid" | "late";
export const SLOTS: Slot[] = ["early", "mid", "late"];
export const SLOT_LABEL: Record<Slot, string> = { early: "früh", mid: "mittel", late: "spät" };
/** Wortlaut vorgegeben – überall, wo ein Wunsch zu sehen ist */
export const WISH_NOTICE = "Achtung ein Dienstplanwunsch ist noch keine fixe Schichteinteilung.";
/** Wünsche nur bis heute + 56 Tage (8 Wochen), Europe/Berlin */
export const WISH_MAX_DAYS = 56;

export type SlotTime = { location_id: string | null; slot: Slot; starts: string; ends: string };
export type Wish = {
  id: string;
  user_id: string;
  location_id: string;
  day: string;
  slot: Slot;
  status: "open" | "approved" | "rejected";
  user: { first_name: string; last_name: string; home_location_id: string | null } | null;
};

/** Erster und letzter wählbarer Tag */
export function wishRange(today = berlinDate()) {
  return { from: today, to: addDays(today, WISH_MAX_DAYS) };
}

/** Zeiten einer Lage im Studio (Studio vor Standard), „08:00–14:30“ */
export function slotTime(slots: SlotTime[], location: string | null, slot: Slot): { starts: string; ends: string } | null {
  const hit = slots.find((s) => s.slot === slot && s.location_id === location) ?? slots.find((s) => s.slot === slot && s.location_id === null);
  return hit ? { starts: hit.starts.slice(0, 5), ends: hit.ends.slice(0, 5) } : null;
}
export const slotText = (slots: SlotTime[], location: string | null, slot: Slot) => {
  const t = slotTime(slots, location, slot);
  return t ? `${SLOT_LABEL[slot]} (${t.starts}–${t.ends})` : SLOT_LABEL[slot];
};

/** Wünsche einer Woche (RLS: eigene; Studioleitung ihre Studios) und die Zeiten der Lagen */
export function useWishes(db: SupabaseClient, start: string, days = 7) {
  const [wishes, setWishes] = useState<Wish[]>([]);
  const [slots, setSlots] = useState<SlotTime[]>([]);
  const reload = useCallback(async () => {
    const [w, s] = await Promise.all([
      db
        .from("shift_wishes")
        .select("id, user_id, location_id, day, slot, status, user:users!shift_wishes_user_id_fkey(first_name, last_name, home_location_id)")
        .gte("day", start)
        .lt("day", addDays(start, days))
        .neq("status", "approved")
        .order("day"),
      db.from("shift_slots").select("location_id, slot, starts, ends"),
    ]);
    // Ohne SQL-Update gibt es die Tabellen noch nicht – dann einfach keine Wünsche
    setWishes(w.error ? [] : ((w.data ?? []) as unknown as Wish[]));
    setSlots(s.error ? [] : ((s.data ?? []) as SlotTime[]));
  }, [db, start, days]);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { wishes, slots, reload };
}

/** Zeitpunkt (für die Sortierung im Kalender): Beginn der Lage */
export const wishStartISO = (w: Wish, slots: SlotTime[]) => berlinToISO(w.day, slotTime(slots, w.location_id, w.slot)?.starts ?? "08:00");
