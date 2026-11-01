// Vorlagen für neue Seiten und Datenbanken (eigene Texte)
import { newProperty, newView, STATUS_DEFAULTS } from "./database/logic";
import type { Blocks, DbSchema, PageKind, PropDef } from "./types";
import { shortId } from "./util";

export type Template = {
  id: string;
  name: string;
  description: string;
  icon: string;
  kind: PageKind;
  content: () => Blocks;
  schema?: () => DbSchema;
};

const h = (level: 1 | 2 | 3, text: string) => ({ type: "heading", props: { level }, content: text });
const p = (text = "") => ({ type: "paragraph", content: text });
const todo = (text: string, checked = false) => ({ type: "checkListItem", props: { checked }, content: text });
const bullet = (text: string) => ({ type: "bulletListItem", content: text });
const callout = (emoji: string, text: string, color = "default") => ({
  type: "callout",
  props: { emoji, backgroundColor: color },
  content: text,
});

export function taskSchema(): DbSchema {
  const title: PropDef = { id: "title", name: "Aufgabe", type: "title" };
  const status = { ...newProperty("status", "Status"), options: STATUS_DEFAULTS() };
  const person = newProperty("person", "Zuständig");
  const due = newProperty("date", "Fällig");
  const prio: PropDef = {
    ...newProperty("select", "Priorität"),
    options: [
      { id: shortId(), name: "Hoch", color: "red" },
      { id: shortId(), name: "Mittel", color: "yellow" },
      { id: shortId(), name: "Niedrig", color: "gray" },
    ],
  };
  const schema: DbSchema = { properties: [title, status, person, due, prio], views: [] };
  const board = newView("board", schema, "Board");
  board.groupBy = status.id;
  const mine = newView("table", schema, "Meine Aufgaben");
  mine.filters = [{ id: shortId(), prop: person.id, op: "contains", value: "me" }];
  mine.sorts = [{ prop: due.id, dir: "asc" }];
  const calendar = newView("calendar", schema, "Kalender");
  calendar.dateProp = due.id;
  schema.views = [newView("table", schema, "Alle Aufgaben"), board, mine, calendar];
  return schema;
}

function projectSchema(): DbSchema {
  const title: PropDef = { id: "title", name: "Projekt", type: "title" };
  const status = { ...newProperty("status", "Status"), options: STATUS_DEFAULTS() };
  const owner = newProperty("person", "Verantwortlich");
  const start = newProperty("date", "Start");
  const end = newProperty("date", "Ende");
  const area = { ...newProperty("multi_select", "Bereich") };
  const schema: DbSchema = { properties: [title, status, owner, start, end, area], views: [] };
  const board = newView("board", schema, "Nach Status");
  board.groupBy = status.id;
  const calendar = newView("calendar", schema, "Zeitplan");
  calendar.dateProp = end.id;
  schema.views = [board, newView("table", schema, "Tabelle"), calendar, newView("gallery", schema, "Galerie")];
  return schema;
}

function contactSchema(): DbSchema {
  const title: PropDef = { id: "title", name: "Name", type: "title" };
  const schema: DbSchema = {
    properties: [title, newProperty("text", "Firma"), newProperty("email", "E-Mail"), newProperty("phone", "Telefon"), newProperty("url", "Website")],
    views: [],
  };
  schema.views = [newView("table", schema, "Alle"), newView("gallery", schema, "Karten")];
  return schema;
}

export const TEMPLATES: Template[] = [
  {
    id: "tasks",
    name: "Aufgaben",
    description: "Aufgaben mit Status, Zuständigen und Fälligkeit – als Tabelle, Board und Kalender.",
    icon: "✅",
    kind: "database",
    content: () => [],
    schema: taskSchema,
  },
  {
    id: "projects",
    name: "Projekte",
    description: "Projekte im Board planen und im Zeitplan verfolgen.",
    icon: "🚀",
    kind: "database",
    content: () => [],
    schema: projectSchema,
  },
  {
    id: "meeting",
    name: "Besprechung",
    description: "Agenda, Notizen und To-dos für ein Meeting.",
    icon: "🗓️",
    kind: "page",
    content: () => [
      callout("👥", "Teilnehmer: "),
      h(2, "Agenda"),
      bullet(""),
      h(2, "Notizen"),
      p(),
      h(2, "To-dos"),
      todo(""),
    ],
  },
  {
    id: "wiki",
    name: "Wiki",
    description: "Wissen und Abläufe für das Team an einem Ort.",
    icon: "📚",
    kind: "page",
    content: () => [
      callout("💡", "Hier sammelt ihr Wissen, Abläufe und Ansprechpartner. Mit / fügst du neue Blöcke ein, mit + Unterseiten."),
      h(2, "Häufige Fragen"),
      { type: "toggleListItem", content: "Wo finde ich …?", children: [p("Antwort hier eintragen.")] },
      h(2, "Abläufe"),
      { type: "numberedListItem", content: "Erster Schritt" },
      { type: "numberedListItem", content: "Zweiter Schritt" },
    ],
  },
  {
    id: "contacts",
    name: "Kontakte",
    description: "Ansprechpartner, Lieferanten und Partner.",
    icon: "📇",
    kind: "database",
    content: () => [],
    schema: contactSchema,
  },
  {
    id: "journal",
    name: "Tagebuch",
    description: "Tägliche Notizen mit Datum.",
    icon: "📓",
    kind: "page",
    content: () => [h(2, "Heute"), p(), h(2, "Gelernt"), p(), h(2, "Morgen"), todo("")],
  },
];

/** Inhalt der Willkommensseite beim ersten Start */
export function welcomeContent(): Blocks {
  return [
    callout("👋", "Willkommen! Diese Seite zeigt dir die wichtigsten Funktionen. Du kannst sie jederzeit bearbeiten oder löschen.", "blue"),
    h(2, "Schreiben"),
    bullet("Tippe / für alle Blocktypen: Überschriften, Listen, To-dos, Tabellen, Bilder, Code und mehr."),
    bullet("Tippe @, um Personen, Seiten oder ein Datum zu erwähnen."),
    bullet("Markiere Text, um ihn zu formatieren, zu verlinken oder einzufärben."),
    bullet("Zieh Blöcke am Griff ⋮⋮ links neben der Zeile an eine andere Stelle."),
    h(2, "Organisieren"),
    todo("Lege mit + in der Seitenleiste eine neue Seite an", false),
    todo("Zieh Seiten in der Seitenleiste, um sie zu verschachteln", false),
    todo("Markiere wichtige Seiten mit ☆ als Favoriten", false),
    todo("Öffne die Suche mit Strg+K (Mac: ⌘K)", false),
    h(2, "Aufgaben"),
    p("Datenbanken zeigen dieselben Einträge als Tabelle, Board, Liste, Kalender oder Galerie. Jede Zeile ist eine eigene Seite mit Eigenschaften und Inhalt."),
    { type: "toggleListItem", content: "Privat oder Team?", children: [p("Private Seiten siehst nur du. Seiten im Bereich Team sehen und bearbeiten alle Kolleginnen und Kollegen.")] },
  ];
}
