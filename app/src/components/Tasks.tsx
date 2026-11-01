// Bereich „Aufgaben“: Seiten, Notizen und Aufgaben-Datenbanken (Modul unter src/notes, synchronisiert aus dem Notion-Klon-Repo)
import type { SupabaseClient } from "@supabase/supabase-js";
import { lazy, Suspense } from "react";

// Der Editor ist groß – erst laden, wenn der Bereich geöffnet wird (Stempeln bleibt schnell)
const Workspace = lazy(() => import("./TasksWorkspace"));

export function Tasks(props: { db: SupabaseClient }) {
  return (
    <Suspense fallback={<div className="screen center muted">Aufgaben werden geladen …</div>}>
      <Workspace db={props.db} />
    </Suspense>
  );
}
