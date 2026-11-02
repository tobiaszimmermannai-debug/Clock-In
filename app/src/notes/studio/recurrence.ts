// Wiederkehrende Teamaufgaben: jede neue Woche bzw. jeder neue Monat bekommt eine frische Kopie.
// Läuft dort, wo Wochen- & Monatsaufgaben zu sehen sind (Studio-Dashboard am PC ist immer offen).
// Feste IDs aus Serie + Zeitraum + Studio: mehrere Geräte legen nie doppelt an.
import { useEffect, useRef } from "react";
import { freshProps, repeatOf, seriesOf, stableId, addMonth } from "../gamification/recur";
import { useNotes } from "../state";
import type { PageMeta, PropValue } from "../types";
import { addDays, today } from "../util";
import { periodOf, periodRange, type Rhythm } from "./period";
import { findStudioDb, STUDIO_PROPS as P } from "./StudioTasks";

export type Copy = { id: string; title: string; icon: string | null; props: Record<string, PropValue> };

/** Welche Kopien fehlen für den laufenden Zeitraum? (rein rechnerisch, testbar) */
export function missingCopies(rows: PageMeta[], db: PageMeta, day: string): Copy[] {
  const out: Copy[] = [];
  for (const rhythm of ["week", "month"] as Rhythm[]) {
    const current = periodOf(rhythm, day);
    const latest = new Map<string, PageMeta>();
    for (const r of rows) {
      if (r.props[P.rhythm] !== rhythm || typeof r.props[P.period] !== "string") continue;
      const key = `${seriesOf(r)}|${String(r.props[P.studio])}`;
      const prev = latest.get(key);
      if (!prev || String(r.props[P.period]) > String(prev.props[P.period])) latest.set(key, r);
    }
    for (const [key, r] of latest) {
      if (repeatOf(r) !== "period" || String(r.props[P.period]) >= current) continue;
      const oldDue = typeof r.props[P.due] === "string" ? (r.props[P.due] as string).slice(0, 10) : null;
      const end = periodRange(current).end;
      const shifted = oldDue ? (rhythm === "week" ? addDays(oldDue, 7) : addMonth(oldDue)) : end;
      const due = shifted >= periodRange(current).start && shifted <= end ? shifted : end;
      out.push({
        id: stableId(key, current),
        title: r.title,
        icon: r.icon,
        props: freshProps(r, db.schema!, { [P.period]: current, [P.due]: due }),
      });
    }
  }
  return out;
}

export function useStudioRecurrence() {
  const notes = useNotes();
  const tried = useRef(new Set<string>());
  const { loaded, pages, isLive, childrenOf, createPage } = notes;
  useEffect(() => {
    if (!loaded) return;
    const db = findStudioDb(pages, isLive);
    if (!db?.schema) return;
    for (const copy of missingCopies(childrenOf(db.id), db, today())) {
      if (tried.current.has(copy.id) || pages.has(copy.id)) continue;
      tried.current.add(copy.id);
      void createPage({ ...copy, parentId: db.id, ifMissing: true }).catch(() => undefined);
    }
  }, [loaded, pages, isLive, childrenOf, createPage]);
}
