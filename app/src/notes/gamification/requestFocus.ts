// Tagesaufgabe direkt anfragen (ohne den ganzen Aufgaben-Bereich zu laden, z. B. in der Erinnerung nach „Kommen“):
// legt die Aufgabe in der Team-Liste des Studios an und pinnt sie als Tagesaufgabe an.
// Mitarbeiter: wartet auf Freigabe (Leitung bekommt eine Telegram-Nachricht, die Datenbank erzwingt das);
// Leitung: direkt eingetragen.
import { teamListId, teamListSchema, newTaskProps } from "../studio/teamList";
import type { Member, NewPage, NotesStore, PageMeta } from "../types";
import { today, uid } from "../util";
import { withFocus } from "./focus";

const isDuplicate = (e: unknown) => /duplicate|23505|409/i.test(`${(e as { code?: string })?.code ?? ""} ${(e as Error)?.message ?? ""}`);

function newPage(base: Partial<NewPage> & Pick<NewPage, "id" | "kind" | "title" | "space">, who: Member): NewPage {
  const now = new Date().toISOString();
  return {
    parentId: null, ownerId: who.id, icon: null, cover: null, props: {}, schema: null, options: {}, position: 1,
    archivedAt: null, deletedAt: null, deletedBy: null, createdAt: now, createdBy: who.id, updatedAt: now, updatedBy: who.id,
    content: [], plain: "", ...base,
  };
}

/**
 * Aufgabe anlegen und als Tagesaufgabe auf Rang `rank` anpinnen.
 * pages: aktuelle Seiten (für die Team-Liste und die Position); studioId: Studio, in dem die Person heute ist.
 */
export async function requestFocusTask(input: {
  store: NotesStore;
  me: Member;
  pages: PageMeta[];
  studioId: string;
  studioName: string;
  title: string;
  rank: number;
  direct: boolean;
}): Promise<PageMeta> {
  const { store, me } = input;
  const listId = teamListId(input.studioId);
  let list = input.pages.find((p) => p.id === listId && !p.deletedAt && !p.archivedAt);
  if (!list) {
    const page = newPage({ id: listId, kind: "database", space: "team", title: `Aufgaben ${input.studioName}`, icon: "✅", schema: teamListSchema() }, me);
    try {
      await store.create(page);
    } catch (e) {
      if (!isDuplicate(e)) throw e; // schon von einem anderen Gerät angelegt
    }
    const { content: _c, plain: _p, ...meta } = page;
    list = (await store.listPages()).find((p) => p.id === listId) ?? meta;
  }
  const schema = list.schema ?? teamListSchema();
  const siblings = input.pages.filter((p) => p.parentId === list!.id);
  const day = today();
  const props = withFocus(newTaskProps(schema, me, day), me.id, day, input.rank, !input.direct);
  const page = newPage(
    {
      id: uid(), kind: "page", space: list.space, ownerId: list.ownerId, parentId: list.id, title: input.title.trim(), props,
      position: siblings.length ? Math.max(...siblings.map((p) => p.position)) + 1 : 1,
    },
    me,
  );
  await store.create(page);
  const { content: _c, plain: _p, ...meta } = page;
  return meta;
}
