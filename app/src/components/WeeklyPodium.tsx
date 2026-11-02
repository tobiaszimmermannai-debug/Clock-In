// Siegerehrung der Vorwoche – montags nach „Kommen“, einmal pro Woche und Person (Modul unter src/notes).
import type { SupabaseClient } from "@supabase/supabase-js";
import { lazy, Suspense, useState } from "react";

const Ranking = lazy(() => import("../notes/ranking"));

const isBerlinMonday = () => new Intl.DateTimeFormat("en-US", { timeZone: "Europe/Berlin", weekday: "short" }).format(new Date()) === "Mon";

export function WeeklyPodium(props: { db: SupabaseClient; userKey: string }) {
  const [open, setOpen] = useState(isBerlinMonday);
  if (!open) return null;
  return (
    <Suspense fallback={null}>
      <Ranking db={props.db} userKey={props.userKey} onClose={() => setOpen(false)} />
    </Suspense>
  );
}
