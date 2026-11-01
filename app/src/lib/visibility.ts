// Regelmäßig nachladen – aber nur, solange der Tab sichtbar ist (spart Abfragen und Supabase-Logs).
// Wird der Tab wieder sichtbar, wird sofort einmal nachgeladen und der Takt läuft weiter.

/** fn alle ms aufrufen, solange der Tab sichtbar ist; beim Zurückkehren sofort. Gibt eine Stopp-Funktion zurück. */
export function everyWhileVisible(fn: () => void, ms: number): () => void {
  let timer: ReturnType<typeof setInterval> | undefined;
  const start = () => {
    if (!timer) timer = setInterval(fn, ms);
  };
  const pause = () => {
    if (timer) clearInterval(timer);
    timer = undefined;
  };
  const onChange = () => {
    if (document.visibilityState === "visible") {
      fn();
      start();
    } else pause();
  };
  if (document.visibilityState === "visible") start();
  document.addEventListener("visibilitychange", onChange);
  return () => {
    pause();
    document.removeEventListener("visibilitychange", onChange);
  };
}

/** Berliner Stunde (0–23) – unabhängig von Zeitzone und Sprache des Geräts */
export function berlinHour(d = new Date()): number {
  const part = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Berlin", hour: "numeric", hourCycle: "h23" })
    .formatToParts(d)
    .find((p) => p.type === "hour");
  return Number(part?.value ?? 0);
}
