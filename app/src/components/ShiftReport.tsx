// Nach „Gehen“: Statistik-Feedback der Schicht (alles vorausgefüllt mit 0, überall 0 geht nicht),
// danach Feierabend-Nachricht mit dem eigenen Blitzi (+1 Punkt).
import type { SupabaseClient } from "@supabase/supabase-js";
import { lazy, Suspense, useState } from "react";
import { dbMessage } from "../lib/errors";
import { emptyReport, REPORT_FIELDS, type ReportValues, reportProblem } from "../lib/shiftReport";
import { Notice, PageHeader } from "./ui";

const Feierabend = lazy(() => import("../notes/feierabend"));

export function ShiftReportForm(props: { db: SupabaseClient; firstName: string; onSaved: () => void }) {
  const [values, setValues] = useState<ReportValues>(emptyReport);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const problem = reportProblem(values);

  async function submit() {
    if (problem) return setError(problem);
    setBusy(true);
    const { error } = await props.db.rpc("shift_report_submit", { p_values: values });
    setBusy(false);
    if (error) return setError(dbMessage(error));
    props.onSaved();
  }

  return (
    <>
      <PageHeader title="Deine Schicht in Zahlen" subtitle={`Kurz eintragen, ${props.firstName} – dann ist Feierabend`} />
      <form className="panel form report-form" onSubmit={(e) => (e.preventDefault(), void submit())}>
        {REPORT_FIELDS.map((f, i) => (
          <label key={f.key} className="report-field">
            <span>{i + 1}. {f.label}</span>
            <input
              type="number" inputMode="numeric" min={0} step={1} value={values[f.key]}
              onFocus={(e) => e.target.select()}
              onChange={(e) => {
                setError(undefined);
                const n = e.target.value === "" ? 0 : Math.floor(Number(e.target.value));
                setValues((v) => ({ ...v, [f.key]: Number.isFinite(n) && n >= 0 ? n : 0 }));
              }}
            />
          </label>
        ))}
        {(error || problem) && <Notice tone={error ? "error" : "info"}>{error ?? problem}</Notice>}
        <button type="submit" className="btn btn-primary btn-block btn-lg" disabled={busy || Boolean(problem)}>
          {busy ? "Speichern …" : "Speichern & Feierabend"}
        </button>
      </form>
    </>
  );
}

/** Feierabend-Gruß mit dem persönlichen Blitzi (Modul aus src/notes) */
export function FeierabendScreen(props: { db: SupabaseClient; onDone: () => void }) {
  return (
    <Suspense fallback={<div className="panel stamp-hero"><h2>Feierabend! ⚡</h2></div>}>
      <Feierabend db={props.db} onDone={props.onDone} />
    </Suspense>
  );
}
