// Wer hat im Zeitraum gearbeitet? Teiler der Team-Wertung (null = unbekannt → alle zählen)
import { useEffect, useState } from "react";
import { useNotes } from "../state";

export function useWeekActive(fromDay: string, toDay?: string): string[] | null {
  const { store } = useNotes();
  const [active, setActive] = useState<string[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    store
      .weekActive(fromDay, toDay ?? "9999-12-31")
      .then((list) => !cancelled && setActive(list))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [store, fromDay, toDay]);
  return active;
}
