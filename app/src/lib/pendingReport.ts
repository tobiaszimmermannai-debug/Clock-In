// Offene Schicht-Statistik nach dem Ausstempeln merken: Reiterwechsel, App-Update oder iPhone im Hintergrund
// dürfen die Abfrage nicht verschlucken. Gilt 12 Std. (so lange nimmt die Datenbank die Zahlen an).
const KEY = "clockin.pendingReport";
const DRAFT = "clockin.reportDraft";
export const PENDING_HOURS = 12;

export type PendingReport<T> = { userId: string; at: string; done: T };

const read = <T,>(key: string): T | null => {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
};
const write = (key: string, value: unknown) => {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* ohne Speicher: nur für diese Ansicht */
  }
};

export const savePendingReport = <T,>(userId: string, at: string, done: T) => write(KEY, { userId, at, done });

/** Offene Abfrage dieser Person (nicht älter als 12 Std.) oder null */
export function pendingReport<T>(userId: string, now = Date.now()): PendingReport<T> | null {
  const p = read<PendingReport<T>>(KEY);
  if (!p || p.userId !== userId || Number.isNaN(Date.parse(p.at))) return null;
  if (now - Date.parse(p.at) > PENDING_HOURS * 3600e3) {
    write(KEY, null);
    return null;
  }
  return p;
}

export function clearPendingReport() {
  write(KEY, null);
  write(DRAFT, null);
}

/** Schon eingetippte Zahlen (überleben ebenfalls ein Neuladen) */
export const reportDraft = <T,>(): T | null => read<T>(DRAFT);
export const saveReportDraft = (values: unknown) => write(DRAFT, values);
