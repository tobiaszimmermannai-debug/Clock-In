// Einwilligungstext für biometrische Daten. Bei inhaltlichen Änderungen VERSION erhöhen:
// gespeichert wird immer der exakt angezeigte Text samt Version und Unterschrift.
import { COMPANY_NAME } from "./config";

export const CONSENT_VERSION = "2026-10-v1";

export function consentText(fullName: string): string {
  const employer = COMPANY_NAME || "mein Arbeitgeber (Vertragspartner laut Arbeitsvertrag)";
  return `Einwilligung in die Verarbeitung biometrischer Daten zur Arbeitszeiterfassung

Ich, ${fullName}, willige ein, dass ${employer} zur Erfassung meiner Arbeitszeiten (Kommen, Pause, Gehen) an den Studio-Tablets eine Gesichtserkennung einsetzt und dafür biometrische Daten von mir verarbeitet.

1. Was verarbeitet wird
Aus dem Kamerabild wird ein Merkmalsvektor berechnet: 128 Zahlenwerte, die mein Gesicht mathematisch beschreiben. Fotos oder Videos werden weder gespeichert noch übertragen. Bei jeder Stempelung wird das Kamerabild nur auf dem Tablet ausgewertet und sofort verworfen. Zum Schutz vor Täuschung mit Fotos werde ich dabei gebeten, den Kopf kurz zur Seite zu drehen.

2. Wo die Daten liegen und wer Zugriff hat
Die Merkmalsvektoren werden in der Datenbank der Zeiterfassung (Anbieter Supabase, Rechenzentrum in Frankfurt am Main, EU) gespeichert und, damit die Erfassung auch ohne Internet funktioniert, auf den Studio-Tablets zwischengespeichert. Zugriff haben ausschließlich die Geschäftsführung und die Tablets. Eine Weitergabe an Dritte erfolgt nicht; technische Dienstleister arbeiten nur im Auftrag (Art. 28 DSGVO).

3. Speicherdauer
Bis zu meinem Widerruf oder bis zum Ende meines Beschäftigungsverhältnisses. Danach werden die Daten gelöscht.

4. Freiwilligkeit
Die Einwilligung ist freiwillig. Wenn ich nicht einwillige oder später widerrufe, entstehen mir keine Nachteile; meine Arbeitszeit wird dann auf andere Weise erfasst.

5. Widerruf
Ich kann diese Einwilligung jederzeit ohne Angabe von Gründen mit Wirkung für die Zukunft widerrufen, formlos gegenüber der Studioleitung oder der Geschäftsführung. Meine Gesichtsdaten werden dann sofort gelöscht. Die Rechtmäßigkeit der bis dahin erfolgten Verarbeitung bleibt unberührt.

6. Meine Rechte
Ich habe das Recht auf Auskunft, Berichtigung, Löschung und Einschränkung der Verarbeitung sowie auf Beschwerde bei einer Datenschutz-Aufsichtsbehörde.

Rechtsgrundlage: Art. 9 Abs. 2 lit. a DSGVO i. V. m. § 26 Abs. 2 BDSG. Textversion ${CONSENT_VERSION}.`;
}
