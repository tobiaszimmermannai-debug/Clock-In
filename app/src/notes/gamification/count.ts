// Offene Aufgaben zählen (für die Startseite in Clock-In) – dieselbe Auswahl wie die Erinnerung
import type { NotesStore, PageMeta } from "../types";
import { allTasks, tasksOf } from "./tasks";

/** Lebt die Seite noch (nicht archiviert/gelöscht, auch kein Elternteil)? */
export function liveCheck(pages: Map<string, PageMeta>) {
  return (id: string) => {
    let p: PageMeta | undefined = pages.get(id);
    for (let i = 0; p && i < 50; i++) {
      if (p.archivedAt || p.deletedAt) return false;
      if (!p.parentId) return true;
      p = pages.get(p.parentId);
    }
    return false;
  };
}

/** Anzahl meiner offenen Aufgaben; null = gesperrt (nicht eingecheckt) oder Gerät */
export async function openTaskCount(store: NotesStore): Promise<number | null> {
  if ((await store.access()).locked) return null;
  const [me, list] = await Promise.all([store.me(), store.listPages()]);
  if (me.device) return null;
  const pages = new Map(list.map((p) => [p.id, p]));
  const items = allTasks(pages, liveCheck(pages), (db) => db.space === "team" || db.ownerId === me.id);
  return tasksOf(items, me.id).filter((t) => !t.done).length;
}
