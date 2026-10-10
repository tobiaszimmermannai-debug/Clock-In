# Einrichtung im Browser (ohne Terminal)

Dauer ca. 20 Minuten. Platzhalter in `<…>` ersetzen.
Die Dateien liegen auf GitHub unter `supabase/` – Datei öffnen → Button **„Copy raw file“**.

---

## Teil A – Supabase-Projekt anlegen
1. [supabase.com/dashboard](https://supabase.com/dashboard) → anmelden → **New project**
2. Name: `clock-in` · Datenbank-Passwort: **Generate** → im Passwort-Manager speichern
3. Region: **Central EU (Frankfurt)** (DSGVO) · Plan: **Free** → **Create new project**
4. ~2 Minuten warten.

`<REF>` = Projekt-ID, steht in der Adresszeile: `supabase.com/dashboard/project/<REF>`

> Free Tier pausiert nur nach 7 Tagen ohne Nutzung – durch die täglichen Stempelungen kein Thema.

## Teil B – Datenbank-Schema einspielen
1. Links **SQL Editor** → **New query**
2. Inhalt von **`supabase/setup_komplett.sql`** komplett einfügen → **Run**
3. Ergebnis: „✅ Clock-In Datenbank eingerichtet · 4“

Bei Fehler einfach erneut ausführen – das Skript räumt halbfertige Versuche selbst auf
(und bricht ab, sobald echte Stempeldaten existieren).

## Teil C – Admin-Konten anlegen (du + Dominik)
1. **Authentication → Users → Add user → Create new user**
   E-Mail + Passwort, Haken bei **Auto Confirm User**.
2. SQL Editor (pro Person einmal):
   ```sql
   insert into public.users (auth_user_id, first_name, last_name, role)
   select id, '<Vorname>', '<Nachname>', 'admin' from auth.users where email = '<E-Mail>';
   ```

## Teil D – Telegram-Function deployen
1. **Edge Functions → Deploy a new function → Via Editor**
2. Name: `telegram` → Beispielcode komplett ersetzen durch `supabase/functions/telegram/index.ts` → **Deploy**
3. In der Function → **Details/Settings** → **Verify JWT** (JWT-Prüfung) **ausschalten** → speichern.
   (Aufrufer sind Datenbank und Telegram; abgesichert über eigene Secrets.)

## Teil E – Secrets erzeugen
1. SQL Editor (`<REF>` ersetzen):
   ```sql
   select vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'notify_secret');
   select vault.create_secret('https://<REF>.supabase.co/functions/v1', 'edge_functions_url');
   select
     (select decrypted_secret from vault.decrypted_secrets where name = 'notify_secret') as notify_secret,
     encode(extensions.gen_random_bytes(32), 'hex') as webhook_secret;
   ```
   Beide angezeigten Werte kopieren.
2. **Edge Functions → Secrets** → drei Einträge anlegen:

   | Name | Wert |
   |---|---|
   | `TELEGRAM_BOT_TOKEN` | Token von @BotFather |
   | `NOTIFY_SECRET` | `notify_secret` aus Schritt 1 |
   | `TELEGRAM_WEBHOOK_SECRET` | `webhook_secret` aus Schritt 1 |

## Teil F – Bot mit Supabase verbinden
Diese Adresse in den Browser eingeben (alles eine Zeile):
```
https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://<REF>.supabase.co/functions/v1/telegram&secret_token=<WEBHOOK_SECRET>
```
Antwort muss `"ok":true` enthalten.

## Teil G – Euch im Bot freischalten
1. Bot in Telegram öffnen → **Start** → Bot antwortet mit deiner **Chat-ID**.
2. SQL Editor:
   ```sql
   insert into public.telegram_links (user_id, chat_id)
   select id, <CHAT_ID> from public.users where first_name = '<Vorname>' and role = 'admin';
   ```
3. Erneut `/start` senden → „✅ Verbunden als …“. Dasselbe für Dominik.

## Teil H – Test
SQL Editor – erzeugt eine Test-Freigabe-Anfrage:
```sql
insert into public.time_logs (user_id, location_id, event_type, recorded_at, source, note, approval_status)
select u.id, l.id, 'clock_in', now(), 'manual', 'Test', 'pending'
from public.users u, public.locations l
where u.first_name = '<Vorname>' and l.code = 'KRAILLING';
```
→ In Telegram kommt „📝 Nachtrag wartet auf Freigabe“ mit ✅/❌. Button drücken → Nachricht zeigt „Freigegeben von …“.
Testeintrag danach löschen: `delete from public.time_logs where note = 'Test';`

---

## Teil I – Updates einspielen (nur wenn Teil B schon lief)
**SQL Editor → New query** → nacheinander ausführen:
1. `supabase/migrations/20261006090000_consent_kiosk_accounts.sql`
2. `supabase/migrations/20261006120000_rules_engine.sql`
3. `supabase/migrations/20261006150000_portal_swaps_report.sql`
4. `supabase/migrations/20261006180000_studio_staffing.sql`
5. `supabase/migrations/20261007120000_phone_stamping.sql` (Stempeln mit Handy + Tablet statt Gesichtserkennung)
6. `supabase/migrations/20261007150000_forgotten_checkout.sql` (Ausstempeln vergessen = nur mit Freigabe)
7. `supabase/migrations/20261008090000_tablet_delete.sql` (Tablets löschen in der Verwaltung)
8. `supabase/migrations/20261008120000_acquisition_shifts.sql` (Akquise-Schichten, auch in anderen Studios)
9. `supabase/migrations/20261008150000_vacation_sick.sql` (Urlaub mit Zähler, Krank statt Schicht, Schule)
10. `supabase/migrations/20261009090000_sick_days_good_boy.sql` (Krank-Tage, „Good Boy“ am Tablet, „Noch nicht da“-Meldung)
11. `supabase/migrations/20261009120000_help_requests.sql` (Aushilfe anfragen und stellen)
12. `supabase/migrations/20261009150000_help_without_request.sql` (Aushilfe stellen auch ohne Anfrage)
13. `supabase/migrations/20261009180000_sick_documents.sql` (Krankheit: Attest / Karenztag-Zettel abhaken)
14. `supabase/migrations/20261010090000_unknown_phone.sql` (anderes Handy/Browser → Buchung zur Freigabe statt Sperre)
15. `supabase/migrations/20261010120000_vacation_allowances.sql` (Urlaubsanspruch je Jahr, Standard 20 Tage)
16. `supabase/migrations/20261011090000_school_import.sql` (Schul-Abgleich mit dem IST-Bildungspartner)
17. `supabase/migrations/20261011120000_saturday_auto_free.sql` (Samstag automatisch frei)

Danach `select jobname, schedule from cron.job;` → Zeilen `clockin-hourly` (Auto-Checkout, 18-Uhr-Abfrage,
Wochenbericht) und `clockin-staffing` (Studio besetzt?). Fehlen sie: **Integrations → Cron** aktivieren und
Datei 2 und 4 erneut ausführen.
Die Funktion `telegram` mit dem neuen Code neu deployen (Teil D).
(Bei Neuinstallation ist alles bereits in `setup_komplett.sql` enthalten.)

## Teil J – Funktion `account-admin` (Tablet-Konten und Mitarbeiter-Zugänge)
1. **Edge Functions → Deploy a new function → Via Editor**
2. Name: `account-admin` → Code aus `supabase/functions/account-admin/index.ts` → **Deploy**
3. **Verify JWT bleibt AN** (Standard) – nur angemeldete Admins mit 2FA dürfen sie nutzen.

## Teil K – App online stellen (Vercel, kostenlos)
1. [vercel.com](https://vercel.com) → **Sign up with GitHub**
2. **Add New → Project** → Repository `Clock-In` importieren (Zugriff erlauben)
3. **Root Directory:** `app` (Edit) · Framework: Vite (wird erkannt)
4. **Environment Variables:**

   | Name | Wert |
   |---|---|
   | `VITE_SUPABASE_URL` | `https://<REF>.supabase.co` |
   | `VITE_SUPABASE_ANON_KEY` | Supabase → Project Settings → API Keys → **anon / publishable** (öffentlicher Schlüssel) |

5. **Deploy** → Adresse z. B. `clock-in-xyz.vercel.app`. Jede Änderung im Repository wird automatisch neu veröffentlicht.

## Teil L – Tablets einrichten
1. Am Handy/PC `https://<deine-vercel-adresse>/#/admin` öffnen → anmelden → 2FA einrichten.
2. **Tablets → Neues Tablet**: Name, Benutzername (z. B. `krailling`), Studio → Passwort notieren.
3. Am Tablet in Chrome die Vercel-Adresse öffnen → Menü → **Zum Startbildschirm hinzufügen**.
4. App öffnen → Benutzername + Passwort → das Tablet zeigt Uhr und QR-Code.
   Das Tablet muss im **Studio-WLAN** sein (nicht über mobile Daten).
5. Android: **Bildschirm fixieren** aktivieren (Einstellungen → Sicherheit), damit niemand die App verlässt.

## Teil M – Mitarbeiter aufs Handy
1. Verwaltung → **Team** → Person antippen → **Zugang anlegen** → Benutzername (Vorschlag `vorname.nachname`) + Startpasswort weitergeben.
2. Mitarbeiter öffnet `https://<deine-vercel-adresse>/#/portal` → anmelden → Menü → **Zum Startbildschirm hinzufügen**.
3. Erstes Stempeln: im Studio-WLAN **Stempeln → Scannen** → QR-Code am Tablet. Dieses Handy wird dabei
   automatisch als Stempel-Handy registriert (ihr bekommt eine Telegram-Meldung).
4. Im Portal außerdem: Stunden (Soll/Ist), Dienstplan aller Studios, Schichttausch, Passwort ändern.

---

## Gut zu wissen
- **2FA:** Admin-Rechte in der App gelten nur mit zweitem Faktor (Authenticator-App).
  Die Einrichtung per QR-Code kommt mit dem Admin-Login der App. Der SQL Editor ist davon nicht betroffen.
- **Telegram absichern:** Freigaben per Button laufen über euer Telegram-Konto → dort
  *Einstellungen → Datenschutz → Zweistufige Bestätigung* aktivieren.
- **Nur Freigaben, keine Einzelmeldungen:**
  `update public.telegram_links set notify_bookings = false where chat_id = <CHAT_ID>;`
- **Fehlersuche:** Edge Functions → `telegram` bzw. `account-admin` → **Logs**.
- **Regeln (änderbar in `rule_settings`):** bis 5 Min. zu spät = pünktlich · Überstunden nur nach Freigabe ·
  jede Pause mind. 15 Min., gesetzlich 30/45 Min. ab 6/9 Std. · Ausstempeln vergessen → um 23 Uhr
  automatisch zur geplanten Endzeit eingetragen, zählt aber erst nach Freigabe per Telegram · 18 Uhr Abfrage
  Krank/Schule/Urlaub (Samstag: automatisch frei, gefragt wird nur, wenn im eigenen Studio niemand eingestempelt
  hat) · Einstempeln ohne Schicht = Aushilfsschicht im Dienstplan.
- **Urlaub, Krank, Schule:** Urlaub/Schule je Tag 6,5 Std., Krank statt Schicht mit den Stunden der Schicht
  (ab Uhrzeit nur der Rest). Azubis: je Tag Wochenstunden ÷ 5,25 (`absence_week_days`), Krank ab Uhrzeit anteilig.
  Krank setzt nur die Studioleitung (eigenes Studio und eigene Leute) oder ein Admin – gegen eine geplante
  Schicht oder als ganzer Tag (pauschal, Uhrzeiten zählen nicht). Urlaubsanspruch pro Jahr steht im
  Arbeitsvertrag (Team → Person); Mitarbeiter sehen ihre Urlaubstage im Portal unter Konto und Stunden.
- **Verwaltung:** Dienstplan · Team (Personen / Urlaub / Krankheit) · Zeiten (Freigaben / Stempelzeiten) ·
  Einstellungen (Tablets, Studios; nur Admin). „Krankheit“: Krankheitsfälle mit Haken „Attest da“ /
  „Karenztag-Zettel da“. „Urlaub“: je Jahr und Studio Anspruch, genommen, eingetragen, Resturlaub; Person
  antippen → Anspruch für dieses und nächstes Jahr (manuell, z. B. anteilig; Standard 20 =
  `rule_settings.default_vacation_days`).
- **Schul-Abgleich (IST):** Team → Schule. bildungspartner.ist.de → Termine → alles kopieren → einfügen →
  Vorschau (neu / geändert / entfällt / Konflikt mit Schicht; jeden Eintrag einzeln abhaken) → zweite
  Bestätigung („Ja, so übernehmen“) – erst dann wird etwas geändert. Alle 2 Wochen wiederholen.
  Importierte Schultage tragen `import_source = 'ist'` und werden beim nächsten Abgleich angepasst oder entfernt;
  von Hand eingetragene bleiben. Abgesagte Termine und reine Monatsangaben werden übersprungen.
- **Resturlaub für Mitarbeiter:** Startseite (Stempeln), Konto und Stunden – zählt runter, sobald Urlaub im
  Dienstplan eingetragen ist.
- **Stempel-Handy:** Der Schlüssel liegt im Browser-Speicher (iPhone: installierte App und Safari getrennt).
  Unbekanntes Handy/Browser → Buchung wartet auf Freigabe (📱 in Telegram / Freigaben); mit ✅ zählt sie und das
  Handy wird gemerkt. Handy einer anderen Person → gesperrt. Der QR-Code führt immer zur Hauptadresse
  (`PRODUCTION_URL` in `app/src/lib/config.ts`, eigene Domain: `VITE_PUBLIC_URL`).
- **Noch nicht da:** 5 Min. (Verspätungs-Toleranz) nach Schichtbeginn nicht eingestempelt → ⏰-Meldung per
  Telegram (je Schicht einmal, an alle mit Studio-Meldungen). Prüfung jede Minute (Job `clockin-staffing`).
- **Tablet „Good Job“:** Gehen spätestens zum Schichtende → 3 Sekunden Bild `app/public/good-job.webp`.
- **Aushilfe:** Studio fragt im Dienstplan an (Eintragen → Art „Aushilfe anfragen“); alle sehen die Anfrage unter
  „Aushilfe gesucht“. Eine andere Studioleitung tippt „Stellen“ und wählt einen eigenen Mitarbeiter – die Schicht
  steht dann im anfragenden Studio. Auch ohne Anfrage (telefonisch/WhatsApp abgesprochen): Eintragen → „Aushilfe
  stellen“ → Studio, Mitarbeiter, Zeit. Die Studioleitung plant so nur ihre eigenen Leute in fremden Studios.
- **Akquise:** zählt wie eine Schicht, aber nicht als „Studio besetzt“. Studioleitung darf eigene Leute auch
  in anderen Studios zur Akquise einplanen.
- **Schichttausch:** normal nur im eigenen Studio (Studioleitung gibt frei). Knopf „Mit anderem Studio“:
  beide Studioleitungen müssen zustimmen; ein Admin (auch per Telegram) gibt für beide frei.
- **Studio besetzt:** erste Stempelung des Tages je Studio → 🟢-Meldung; 10 Min. nach der ersten geplanten
  Schicht noch niemand da → 🔴-Warnung. Im Bot: `/kurz` = nur Wichtiges, `/alle` = jede Stempelung.
- **Wochenbericht:** freitags 19 Uhr per Telegram (Stunden, Verspätungen, Überstunden, wie oft nicht ausgestempelt,
  offene Freigaben).
- **Stempeln (Handy + Tablet):** Das Tablet zeigt einen QR-Code, der alle 30 Sek. wechselt. Gebucht wird nur, wenn
  (1) das Konto mit seinem **eigenen registrierten Handy** stempelt, (2) der QR-Code frisch ist (also vor Ort gescannt) und
  (3) Handy und Tablet im **selben Netz** sind (gleiche Internet-Adresse des Studio-WLANs).
  Ein Handy gehört genau einer Person – Kollegen können niemanden mit dem eigenen Handy einstempeln.
  Neues Handy: Verwaltung → Team → Person → **Stempel-Handy zurücksetzen**. Schutz gegen normales Mogeln, nicht gegen Hacker.
  Ohne Handy oder bei Problemen: Anruf bei Tobias oder Dominik → Nachtrag in der Verwaltung.
