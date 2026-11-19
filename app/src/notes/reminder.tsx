// Einstieg für Clock-In: Erinnerung mit eigener Supabase-Verbindung (lädt ohne den Editor)
import type { SupabaseClient } from "@supabase/supabase-js";
import { useMemo } from "react";
import { type ReminderReason, TaskReminder } from "./gamification/Reminder";
import { SupabaseStore } from "./store/supabase";
import { openTaskCount } from "./gamification/count";

/** Startseite in Clock-In: Zahl meiner offenen Aufgaben (null = gesperrt/unbekannt) */
export const countOpenTasks = (db: SupabaseClient) => openTaskCount(new SupabaseStore(db)).catch(() => null);

export default function ClockInReminder(props: { db: SupabaseClient; reason: ReminderReason; onOpen: () => void; onClose?: () => void }) {
  const store = useMemo(() => new SupabaseStore(props.db), [props.db]);
  return <TaskReminder store={store} reason={props.reason} onOpen={props.onOpen} onClose={props.onClose} />;
}
