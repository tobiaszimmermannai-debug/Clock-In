// Reiter „Wissen“: Einarbeitung im Duolingo-Stil (fest in der App – kein Nachladen, das nach Updates fehlschlagen kann)
import { ErrorBoundary } from "../components/ErrorBoundary";
import WissenApp from "./wissen/WissenApp";

export function Knowledge() {
  return (
    <ErrorBoundary label="Wissen">
      <WissenApp />
    </ErrorBoundary>
  );
}
