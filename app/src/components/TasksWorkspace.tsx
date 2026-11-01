import type { SupabaseClient } from "@supabase/supabase-js";
import { useMemo } from "react";
import { NotesWorkspace, SupabaseStore } from "../notes";

export default function TasksWorkspace(props: { db: SupabaseClient }) {
  const store = useMemo(() => new SupabaseStore(props.db), [props.db]);
  return <NotesWorkspace store={store} title="Aufgaben" routing="memory" embedded />;
}
