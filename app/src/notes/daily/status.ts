// Tagesstand – die EINE Stelle, die berechnet, wer heute offen ist, wer abwesend ist und was fällig ist.
// Benutzt von der Tagesaufgaben-Ansicht (Startseite, Team-Übersicht, Studio-PC) und vom Telegram-Reminder
// (supabase/functions/aufgaben). Keine Abfragen hier: alle Daten kommen als Eingabe, damit App und Server
// garantiert dasselbe rechnen. Abwesenheiten liefert ausschließlich note_day_plan (ClockIn-Dienstplan).
import { focusTasks } from "../gamification/focus";
import { allTasks, tasksOf, type TaskItem } from "../gamification/tasks";
import type { Member, PageMeta } from "../types";

/** Dienstplan des Tages aus ClockIn: eingeplant (Arbeitsschicht) und abwesend (Krank, Schule, Urlaub) */
export type DayPlan = { planned: string[]; absent: string[] };

export type FocusItem = TaskItem & { rank: number; pending: boolean };

/** absent = krank/Schule/Urlaub („-“), none = keine Tagesaufgabe, open = noch offen, done = alles erledigt */
export type PersonState = "absent" | "none" | "open" | "done";

export type PersonDay = {
  member: Member;
  absent: boolean;
  planned: boolean;
  /** gehört in den Tagesstand: eingeplant, abwesend oder mit Tagesaufgabe (ohne Dienstplan: alle) */
  relevant: boolean;
  focus: FocusItem[];
  /** offene Tagesaufgaben – bei Abwesenheit immer 0 */
  open: number;
  done: number;
  /** fällig heute oder überfällig, nicht erledigt */
  due: TaskItem[];
  state: PersonState;
};

export type DayStatus = {
  day: string;
  /** alle Personen (ohne Geräte) */
  all: PersonDay[];
  /** nur die für heute relevanten, nach Studio und Name */
  people: PersonDay[];
  absent: PersonDay[];
  /** stehen noch aus: offene Tagesaufgaben oder noch keine eingetragen */
  outstanding: PersonDay[];
  finished: PersonDay[];
  withoutFocus: PersonDay[];
  /** Tagesaufgaben, die auf Freigabe warten */
  pending: { person: PersonDay; item: FocusItem }[];
  dueToday: number;
  overdue: number;
};

/** Lebt eine Seite noch (nicht archiviert/gelöscht, auch keine ihrer Eltern)? */
export function liveCheck(pages: Map<string, PageMeta>): (id: string) => boolean {
  const cache = new Map<string, boolean>();
  const check = (id: string, depth = 0): boolean => {
    const known = cache.get(id);
    if (known !== undefined) return known;
    const p = pages.get(id);
    // Unsichtbare Elternseite (fremde Liste einer zugewiesenen Aufgabe) gilt als lebend
    const ok = Boolean(
      p && !p.archivedAt && !p.deletedAt && (!p.parentId || !pages.has(p.parentId) || (depth < 50 && check(p.parentId, depth + 1))),
    );
    cache.set(id, ok);
    return ok;
  };
  return (id) => check(id);
}

export function dailyStatus(input: {
  day: string;
  pages: Map<string, PageMeta>;
  members: Member[];
  /** null = Dienstplan unbekannt (lokaler Modus, ältere Datenbank) */
  plan: DayPlan | null;
  isLive?: (id: string) => boolean;
  /** Studio-Reihenfolge für die Sortierung */
  studioName?: (id: string | null | undefined) => string;
}): DayStatus {
  const { day, plan } = input;
  const isLive = input.isLive ?? liveCheck(input.pages);
  const items = allTasks(input.pages, isLive, () => true, day);
  const byRow = new Map(items.map((t) => [t.row.id, t]));
  const rows = items.map((t) => t.row);
  const absentSet = new Set(plan?.absent ?? []);
  const plannedSet = new Set(plan?.planned ?? []);
  const studio = input.studioName ?? (() => "");

  const all: PersonDay[] = input.members
    .filter((m) => !m.device)
    .map((member) => {
      const focus: FocusItem[] = focusTasks(rows, member.id, day).map((f) => ({ ...byRow.get(f.row.id)!, rank: f.rank, pending: f.pending }));
      const absent = absentSet.has(member.id);
      const planned = plannedSet.has(member.id);
      const done = focus.filter((f) => f.done).length;
      const open = absent ? 0 : focus.length - done;
      const due = absent ? [] : tasksOf(items, member.id).filter((t) => !t.done && t.due !== null && t.due.slice(0, 10) <= day);
      const state: PersonState = absent ? "absent" : !focus.length ? "none" : open ? "open" : "done";
      return { member, absent, planned, relevant: plan === null || planned || absent || focus.length > 0, focus, open, done, due, state };
    });

  const people = all
    .filter((p) => p.relevant)
    .sort((a, b) => studio(a.member.studioId).localeCompare(studio(b.member.studioId), "de") || a.member.name.localeCompare(b.member.name, "de"));
  const present = people.filter((p) => !p.absent);
  return {
    day,
    all,
    people,
    absent: people.filter((p) => p.absent),
    outstanding: present.filter((p) => p.state === "open" || p.state === "none"),
    finished: present.filter((p) => p.state === "done"),
    withoutFocus: present.filter((p) => p.state === "none"),
    pending: people.flatMap((person) => person.focus.filter((f) => f.pending).map((item) => ({ person, item }))),
    dueToday: present.reduce((n, p) => n + p.due.filter((t) => t.due!.slice(0, 10) === day).length, 0),
    overdue: present.reduce((n, p) => n + p.due.filter((t) => t.due!.slice(0, 10) < day).length, 0),
  };
}

/** Tagesstand einer einzelnen Person (aus derselben Berechnung) */
export const personDay = (status: DayStatus, userId: string) => status.all.find((p) => p.member.id === userId);
