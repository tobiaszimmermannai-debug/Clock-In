// Fängt Fehler in einem Bereich ab: statt leerer Seite eine Meldung mit „Neu laden“.
// Fehlt nach einem Update eine nachgeladene Datei (alte App-Version im Speicher), lädt die Seite einmal automatisch neu.
import { Component, type ReactNode } from "react";
import { Notice } from "./ui";

const RELOAD_KEY = "clockin-chunk-reload";
const isChunkError = (e: unknown) => /dynamically imported module|Importing a module script failed|Loading chunk|ChunkLoadError/i.test(String((e as Error)?.message ?? e));

export class ErrorBoundary extends Component<{ children: ReactNode; label?: string }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.error("Bereich abgestürzt:", error);
    try {
      if (isChunkError(error) && sessionStorage.getItem(RELOAD_KEY) !== "1") {
        sessionStorage.setItem(RELOAD_KEY, "1");
        location.reload();
      }
    } catch {
      // egal
    }
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="stack" style={{ padding: "16px 0" }}>
        <Notice tone="error">
          {this.props.label ?? "Dieser Bereich"} konnte nicht geladen werden. Bitte neu laden – hilft das nicht, App einmal schließen und wieder öffnen.
        </Notice>
        <p className="muted small">Fehler: {this.state.error.message}</p>
        <button type="button" className="btn btn-primary" onClick={() => location.reload()}>Neu laden</button>
      </div>
    );
  }
}
