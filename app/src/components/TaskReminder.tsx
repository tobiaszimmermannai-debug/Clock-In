// Erinnerung an offene Aufgaben (Blitzi) – beim Login, nach „Kommen“ und zur Pause.
// Lädt erst bei Bedarf und ohne den Editor.
import type { SupabaseClient } from "@supabase/supabase-js";
import { lazy, Suspense } from "react";

const Reminder = lazy(() => import("../notes/reminder"));

export function TaskReminder(props: { db: SupabaseClient; reason: "login" | "clock_in" | "break"; onOpen: () => void; onClose?: () => void }) {
  return (
    <Suspense fallback={null}>
      <Reminder {...props} />
    </Suspense>
  );
}
