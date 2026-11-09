// Reiter „Wissen“: Einarbeitung im Duolingo-Stil (lädt Inhalte und Lernlogik erst beim Öffnen)
import { lazy, Suspense } from "react";

const WissenApp = lazy(() => import("./wissen/WissenApp"));

export function Knowledge() {
  return (
    <Suspense fallback={<p className="muted">Lädt …</p>}>
      <WissenApp />
    </Suspense>
  );
}
