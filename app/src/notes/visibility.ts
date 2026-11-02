// Regelmäßig nachladen – aber nur, solange der Tab sichtbar ist (spart Abfragen und Supabase-Logs).
// Wird der Tab wieder sichtbar, wird sofort einmal nachgeladen und der Takt läuft weiter.
// (Übernommen aus Clock-In app/src/lib/visibility.ts, damit das Modul eigenständig bleibt.)

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
  if (typeof document === "undefined") {
    start();
    return pause;
  }
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
