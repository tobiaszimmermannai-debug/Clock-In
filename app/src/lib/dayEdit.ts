// Tag korrigieren (Admin): nur Kommen und Gehen je Einsatz – Pausen zieht das System automatisch ab.
// Regel wie in der Datenbank (private.required_break): bis 6 Std. keine Pause, ab 6 Std. 30 Min., ab 9 Std. 45 Min.
// (dazwischen gleitend, damit nie weniger als 6 bzw. 9 Std. übrig bleiben). Lücken ab 15 Min. zwischen zwei
// Einsätzen (Splitschicht) zählen als Pause.

export type Block = { key: number; from: string; to: string };
type StampLike = { event_type: string; recorded_at: string };

let blockKey = 0;
export const newBlock = (from = "09:00", to = "15:00"): Block => ({ key: blockKey++, from, to });

/** Pflichtpause in Minuten zu einer Anwesenheit (gleiche Regel wie die Datenbank) */
export function requiredBreak(presence: number): number {
  if (presence <= 360) return 0;
  if (presence <= 390) return presence - 360;
  if (presence <= 570) return 30;
  if (presence <= 585) return presence - 540;
  return 45;
}

const minutes = (t: string) => {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
};

/** Einsätze (Kommen → Gehen) aus den Stempelungen eines Tages; Pausen-Stempel werden ignoriert */
export function blocksFromStamps(stamps: StampLike[], timeOf: (iso: string) => string): Block[] {
  const out: Block[] = [];
  let open: string | null = null;
  for (const s of [...stamps].sort((a, b) => a.recorded_at.localeCompare(b.recorded_at))) {
    if (s.event_type === "clock_in") {
      if (open !== null) out.push(newBlock(open, ""));
      open = timeOf(s.recorded_at);
    } else if (s.event_type === "clock_out") {
      out.push(newBlock(open ?? "", timeOf(s.recorded_at)));
      open = null;
    }
  }
  if (open !== null) out.push(newBlock(open, ""));
  return out;
}

export type DayCalc = { presence: number; gaps: number; autoBreak: number; counted: number; problem: string | null };

/** Anwesenheit, automatische Pause und gezählte Zeit (vor Abgleich mit der Schicht) – plus erster Eingabefehler */
export function calcDay(blocks: Block[]): DayCalc {
  const sorted = [...blocks].sort((a, b) => a.from.localeCompare(b.from));
  let presence = 0;
  let gaps = 0;
  let problem: string | null = null;
  sorted.forEach((b, i) => {
    if (!b.from || !b.to) problem ??= "Bitte bei jedem Einsatz Kommen und Gehen eintragen.";
    else if (minutes(b.to) <= minutes(b.from)) problem ??= `Gehen (${b.to}) muss nach Kommen (${b.from}) liegen.`;
    else presence += minutes(b.to) - minutes(b.from);
    const prev = sorted[i - 1];
    if (prev?.to && b.from) {
      const gap = minutes(b.from) - minutes(prev.to);
      if (gap < 0) problem ??= "Zwei Einsätze überschneiden sich.";
      else if (gap >= 15) gaps += gap;
    }
  });
  const autoBreak = Math.max(0, requiredBreak(presence) - gaps);
  return { presence, gaps, autoBreak, counted: Math.max(0, presence - autoBreak), problem };
}

/** Buchungen zum Speichern (replace_day_logs): je Einsatz Kommen und Gehen, sortiert */
export const blocksToEvents = (blocks: Block[]) =>
  [...blocks].sort((a, b) => a.from.localeCompare(b.from)).flatMap((b) => [
    { event: "clock_in" as const, time: b.from },
    { event: "clock_out" as const, time: b.to },
  ]);
