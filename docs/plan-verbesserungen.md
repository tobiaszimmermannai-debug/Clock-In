# Plan: Verbesserungen Clock-In (Stand 15.11.2026)

Ausführung paketweise. Nach jedem Paket: Tests (`npm test`, Build), lokale Test-Datenbank (Setup 2× + „Jetzt“-SQL 2×),
`supabase/setup_komplett.sql` ergänzen (nie ausführen), Commit + Push auf `claude/eloquent-fermat-ufl2mx`,
Artefakt „Jetzt“-Kasten aktualisieren, Cowork-Prompt für den Nutzer. Aufgaben-Code (`app/src/notes/**`) nur im
Notes-Repo ändern und per `npm run sync:clockin` übernehmen.

## Paket 1 – Fehler beheben (fast nur App)
**Stand 16.11.: erledigt** (Ladefehler sichtbar in Freigaben, Tausch, Stunden; übrige Stellen folgen bei Gelegenheit. „Rückgängig“ bei Freigaben ersetzt durch Ablehnen-Sheet mit Grund.)
1. **Portal-Abmeldung bei Netzfehler** (`portal/PortalApp.tsx` `load`): nur abmelden, wenn die Abfrage ohne Fehler
   leer ist; bei Fehler Hinweis „Keine Verbindung“ + „Erneut versuchen“. Gleiches Muster in `admin/AdminApp.tsx` prüfen.
2. **Meine Stunden** (`portal/Hours.tsx`, `components/DayTable.tsx`):
   - Kartentitel folgt der gewählten Woche („Diese Woche“ / „KW 46“).
   - Laufende Woche: Soll „bis heute“ = Summe der geplanten Minuten (`planned_minutes`) + Gutschriften bis heute;
     volles Wochensoll klein daneben. Monat: Soll = Wochenstunden ÷ Arbeitstage × Arbeitstage Mo–Sa bis heute.
3. **Urlaub Folgejahr**: ab 1.10. zusätzlich Karte/Zeilen fürs nächste Jahr (`portal/Vacation.tsx`, `vacation_overview(p_year)`).
4. **Freigaben** (`admin/Approvals.tsx`): Knöpfe während der Anfrage sperren; „Ablehnen“ öffnet Sheet mit optionalem
   Grund (Spalten `review_note` bzw. `decision_note` existieren); nach Entscheidung 6 Sek. „Rückgängig“ wo möglich
   (Überstunden/Nachtrag: Status zurück auf pending; Tausch: nicht rückgängig → Rückfrage vorher). „Alle freigeben“ je Abschnitt.
5. **Ladefehler sichtbar**: Hilfsfunktion `useLoad`/`<LoadError onRetry>` in `components/ui.tsx`; alle ~22 Stellen
   (`grep "const { data } = await\|then(({ data })"`) umstellen. Ladezustand „Lädt …“ statt „Keine Daten“.
6. **Feste Texte**: Namen der Freigeber aus `rule_settings` (neue Spalte `approver_names text default 'Tobias oder Dominik'`),
   App + Edge Functions lesen sie. „So wird gezählt“ nutzt Werte aus `rule_settings` statt 5/15/6,5.

## Paket 2 – Tausch, Stempeln, Früher gehen (SQL + App + Telegram)
1. **Tausch braucht Zustimmung der Zielperson**: `swap_requests.target_accepted_at`, Status-Ablauf
   Antrag → Zielperson „Annehmen/Ablehnen“ (Portal `Swap.tsx`, Mitteilung) → erst dann Telegram/Freigabe an Leitung.
   `swap_requests_validate` + RLS anpassen; Leitung sieht nur angenommene Anträge.
2. **Einstempeln ohne Schichtzuordnung**: beim Freigeben einer pending-Buchung (`clock_in`, `shift_id is null`)
   Aushilfsschicht nachträglich anlegen (Trigger auf Update von `approval_status`). `auto_checkout` schließt auch
   Sitzungen ohne Schicht (nach `help_shift_minutes`, spätestens zur Auto-Checkout-Stunde).
3. **Doppelbuchung**: `pg_advisory_xact_lock(hashtext(user_id))` am Anfang von `public.stamp`.
4. **Stündliche Jobs nachholen**: Tabelle `job_runs(job, day)`; `hourly_jobs` führt Auto-Checkout/Berichte aus, wenn
   Stunde ≥ Soll-Stunde und heute noch nicht gelaufen.
5. **Früher gehen „wenig los“**: keine Freigabe mehr. `time_logs_assign_shift`: bei `early_reason = 'slow'`
   `early_status := 'rejected'` (= Minusstunden, nichts offen). Telegram: reine Info an Tobi + Domi ohne Knöpfe.
   Portal-Text: „Die fehlende Zeit zählt als Minusstunden.“ `Approvals.tsx`: Abschnitt zeigt nur noch „krank“ /
   ohne Grund. „Krank“ bleibt wie bisher (Freigabe). Offene alte „slow“-Einträge per Migration auf rejected.

## Paket 3 – Komfort
1. **Startseite „Heute“** (`portal/Stamp.tsx`): Karte mit nächster Schicht (Tag, Zeit, Studio), Stempelstatus,
   offenen Aufgaben (Anzahl), Resturlaub; QR-Knopf bleibt oben.
2. **Navigation**: 5 Reiter (Stempeln, Stunden, Dienstplan, Wissen, Aufgaben); „Konto“ als Avatar oben rechts im Kopf (`Shell.tsx`).
3. **Mitteilungen (Glocke)**: Tabelle `notifications(user_id, kind, title, body, link, read_at)` + RLS (nur eigene),
   Glocke im Kopf mit Zähler, Liste als Sheet. Auslöser per Trigger: Tausch angefragt/angenommen/entschieden,
   eigene Schicht geändert/gelöscht/neu (nur Zukunft, gebündelt pro Tag), Urlaubsantrag entschieden,
   Nachtrag/Überstunden entschieden. NICHT: „Früher gehen entschieden“.
4. **Planung** (`admin/Plan.tsx`): „Vorwoche kopieren“ (nur Arbeitsschichten, Konflikte überspringen, Vorschau);
   Warnungen beim Speichern (weniger als 11 Std. Ruhezeit, über Wochenstunden, mehr als 10 Std./Tag) – Hinweis, kein Verbot;
   „Rückgängig“ 8 Sek. nach Löschen. Ziehen zum Anlegen auch in der Wochenansicht.

## Paket 4 – Urlaubsantrag
Ablauf: Mitarbeiter beantragt (von–bis, Notiz; zeigt gezählte Tage und Resturlaub danach) → Studioleitung des
Heimatstudios stimmt zu/lehnt ab → Dominik gibt frei (Tobi bekommt nur Info per Telegram) → Urlaub wird als
`vacation`-Einträge in den Dienstplan geschrieben (Mo–Fr bzw. wie `absenceDays`), Resturlaub sinkt automatisch.
- Tabelle `vacation_requests(user_id, from_day, to_day, days, note, status: pending_lead|pending_final|approved|rejected|cancelled,
  lead_by, lead_at, final_by, final_at, decision_note)`.
- `rule_settings.vacation_approver_user_id` (Dominik) – einstellbar unter Einstellungen; Admin ohne diese Rolle sieht, darf nicht freigeben.
- RPCs: `vacation_request_create`, `_cancel`, `_decide_lead`, `_decide_final` (legt Einträge an; prüft Resturlaub und
  Überschneidung mit bestehenden Einträgen → verständliche Meldung; bestehende Arbeitsschichten im Zeitraum werden gemeldet, nicht gelöscht).
- Ist die Person selbst Studioleitung oder gibt es keine Leitung: Schritt 1 entfällt.
- App: Portal „Urlaub beantragen“ (Konto + Startseite), Leitung: Abschnitt in Freigaben, Admin: `Vacations.tsx`.
- Telegram: an Leitung (Knöpfe), dann an Dominik (Knöpfe) und Tobi (Info); Mitteilung an Mitarbeiter bei jeder Entscheidung.

## Paket 5 – Wissen: Punkte, Level, Thema NiSV
1. **Punkte fair**: XP vergibt der Server (RPC `wissen_answer(item, type, correct, mode, answer)`), App schickt kein XP mehr.
   Regeln: falsch = 0; richtig = XP nur, wenn die Frage neu oder fällig ist (Leitner `due_at <= now`); nicht fällige
   Wiederholung = 0 XP (Üben bleibt erlaubt, „Übung – keine Punkte“ anzeigen). Blitzrunde zieht nur neue/fällige;
   sonst 0 XP. Bonus „fehlerfrei“ nur, wenn mind. 5 Fragen der Lektion Punkte bringen konnten. Direktes Insert in
   `wissen_attempts` per RLS sperren. Bestehende XP bleiben.
2. **Level**: aus Gesamt-XP, Kurve `xp(level) = 50·level·(level+1)`; Titel in 5er-Schritten (Starter, Kenner, Profi,
   Experte, Meister); Fortschrittsbalken zum nächsten Level, Level-Up-Animation + Sound. Zusätzlich je Thema ein
   Meisterschafts-Ring (Anteil Fragen in Box ≥ 4). Rangliste „Wissen“ pro Woche (nur Server-XP).
3. **Themen**: `units.json` bekommt `topicId`; neue `topics.json` (Einarbeitung, NiSV). Startseite: Themenwahl,
   Freischaltung je Thema getrennt (`unlockedUnits` pro Thema).
4. **Thema NiSV** (`app/src/content/wissen/`): Units nach den Lernzielen der Fachkunde-Richtlinie für EMS
   (Grundlagen NiSV/Recht und Pflichten, Physik/Technik Niederfrequenz-Strom, Anatomie/Physiologie Haut–Nerv–Muskel,
   Wirkungen und Risiken, Kontraindikationen, Beratung/Aufklärung/Dokumentation, Geräte/Hygiene/Notfall).
   Ziel ~150–200 Fragen (single/multi) mit Erklärung und Quelle, plus Karteikarten-Decks. Inhalte aus dem
   Schulungsmaterial des Nutzers; fehlt es, Entwurf aus Verordnung + Richtlinie, vom Nutzer gegenzulesen.
   `docs/wissen-fragen-und-loesungen.md` ergänzen, `wissen.test.ts` prüft Konsistenz (eindeutige IDs, korrekte Optionen).

## Paket 6 – Aufgaben: Punkte, Serie, Blitzi (Notes-Repo, danach `sync:clockin`)
**Stand 16.11.: erledigt sind 1, 2, 4, 6 (Tagesanzeige) und die Siegerehrung (Treppchen blieb leer, wenn das Gerät
Animationen abschaltet) – Migration `20261116090000_notes_fair_points.sql`. Akku-Reserve (5) ebenfalls erledigt. Offen: 3 (eine Quelle für Punkte).**
Zuerst je Punkt einen Test schreiben, der den Fehler zeigt (`gamification/stats.test.ts`, `server/aufgaben.test.ts`).
1. **Abhaken → wieder öffnen → abhaken**: Die Gutschrift wird gelöscht und mit neuem Datum neu angelegt
   (`state.tsx` `recordCompletion`). Damit hält eine einzige Aufgabe die Serie täglich am Leben und alte Punkte wandern
   in die aktuelle Woche. Lösung: Gutschrift serverseitig (RPC/Trigger), je Aufgabe und Person nur einmal; erneutes
   Abhaken behält das erste Datum; Zurücknehmen nur am selben Tag punktwirksam. Wiederkehrende Aufgaben: je Fälligkeit einmal.
2. **Punkte gehen bei Netzfehler still verloren**: `store.setCompletion(...).catch(() => undefined)` – Anzeige zeigt
   Punkte, Server hat sie nicht. Lösung: Warteschlange mit erneutem Versuch + sichtbarer Hinweis.
3. **Punkte werden nur in der App gerechnet** (Tageslimit 3 in `pointsByDay`), Rangliste/Telegram rechnen separat
   (`server/aufgaben.ts`). Eine gemeinsame Quelle: View/RPC `note_points(from, to)`; App und Telegram nutzen sie.
4. **Team-Wertung**: teilt durch alle Personen des Heimatstudios – auch Urlaub, Krank, Schule, ohne Zeiterfassung.
   Teiler = Personen mit mindestens einem Arbeitstag in der Woche (aus `workDays`).
5. **Serie/Blitzi**: ein verpasster Arbeitstag setzt von Stufe 29 auf 1. Vorschlag: 1 „Akku-Reserve“ je Woche
   (verdient durch volles Tagesziel), die einen verpassten Tag überbrückt; Anzeige „Reserve: 1“.
   Prüfen: Tag mit Arbeitsschicht, aber krank/früher gegangen → neutral.
6. **Kleinkram**: `speech()` nutzt UTC-Tag statt Berliner Tag; `weekStart` nutzt Gerätezeit – auf Berliner Zeit vereinheitlichen.
