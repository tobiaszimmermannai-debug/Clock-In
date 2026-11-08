// Ausstempel-Statistik: 10 Kennzahlen je Schicht – Wortlaut vorgegeben, gleich in Formular, Statistik und Export.
// (Clock-In nutzt diese Liste für das Formular beim „Gehen“; Spalten in public.shift_reports.)
export const REPORT_FIELDS = [
  { key: "trainings", label: "Gegebene Trainings (einzelne Personen)", short: "Trainings" },
  { key: "kvs", label: "Gemachte KVs", short: "KVs" },
  { key: "pts_given", label: "Gegebene PTs (einzelne Personen)", short: "PTs gegeben" },
  { key: "direct_contacts", label: "Direktansprachen", short: "Direktansprachen" },
  { key: "vip_contacts", label: "VIP Ansprachen", short: "VIP Ansprachen" },
  { key: "flyers", label: "Verteilte Flyer", short: "Flyer" },
  { key: "called_former", label: "Angerufene Ehemalige", short: "Ehemalige" },
  { key: "called_wellpass", label: "Angerufene Wellpassler", short: "Wellpassler" },
  { key: "called_leads", label: "Angerufene Interessenten/Leads", short: "Interessenten/Leads" },
  { key: "pts_booked", label: "Ausgemachte PTs", short: "PTs ausgemacht" },
] as const;

export type ReportKey = (typeof REPORT_FIELDS)[number]["key"];
export type ReportValues = Record<ReportKey, number>;

export const emptyReport = (): ReportValues => Object.fromEntries(REPORT_FIELDS.map((f) => [f.key, 0])) as ReportValues;

export const ALL_ZERO_TEXT = "Bitte trag mindestens eine Kennzahl ein – überall 0 geht nicht.";

/** Fehlertext oder null: ganze Zahlen ≥ 0, mindestens eine > 0 */
export function reportProblem(v: ReportValues): string | null {
  const values = REPORT_FIELDS.map((f) => v[f.key]);
  if (values.some((n) => !Number.isInteger(n) || n < 0)) return "Bitte nur ganze Zahlen ab 0 eintragen.";
  if (values.every((n) => n === 0)) return ALL_ZERO_TEXT;
  return null;
}

export const reportSum = (v: Partial<Record<string, number>>) => REPORT_FIELDS.reduce((s, f) => s + (v[f.key] ?? 0), 0);

/** Summe mehrerer Abgaben */
export function sumReports(list: { values: Record<string, number> }[]): ReportValues {
  const out = emptyReport();
  for (const r of list) for (const f of REPORT_FIELDS) out[f.key] += r.values[f.key] ?? 0;
  return out;
}

/** 10 Feierabend-Nachrichten – {name} = Spitzname bzw. Vorname */
export const FEIERABEND_LINES = [
  "Schicht vorbei – Blitzi lädt die Füße hoch. Bis morgen, {name}!",
  "Sauberer Feierabend, {name}! Heute war Strom im Studio.",
  "Blitz aus, Training aus – gönn dir jetzt etwas Gutes, {name}.",
  "Feierabend-Modus an. Du und Blitzi habt heute abgeliefert.",
  "Letzte Wiederholung des Tages: nach Hause gehen. Stark, {name}!",
  "Studio zu, Akku voll. Morgen zünden wir wieder.",
  "Tschüss Schicht! Blitzi schickt eine Ladung Stolz mit.",
  "Heute war kein Ruhetag – Respekt, {name}. Bis zum nächsten Impuls.",
  "Feierabend-Highfive von Blitzi. Hast du verdient, {name}.",
  "Licht aus, Blitz an. Schlaf dich stark!",
];
