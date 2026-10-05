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

## Teil I – Update: Einwilligung, Tablet-Konten, Regeln, Portal (nur wenn Teil B schon lief)
**SQL Editor → New query** → nacheinander ausführen:
1. `supabase/migrations/20261006090000_consent_kiosk_accounts.sql`
2. `supabase/migrations/20261006120000_rules_engine.sql`
3. `supabase/migrations/20261006150000_portal_swaps_report.sql`
4. `supabase/migrations/20261006180000_studio_staffing.sql`
5. `supabase/migrations/20261007090000_studio_names.sql` (Studionamen Krailling, Germering, Starnberg, Moosach)

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
4. App öffnen → Benutzername + Passwort → Kamera erlauben.
5. Android: **Bildschirm fixieren** aktivieren (Einstellungen → Sicherheit), damit niemand die App verlässt.

## Teil M – Mitarbeiter aufs Handy
1. Verwaltung → **Team** → Person antippen → **Zugang anlegen** → Benutzername (Vorschlag `vorname.nachname`) + Startpasswort weitergeben.
2. Mitarbeiter öffnet `https://<deine-vercel-adresse>/#/portal` → anmelden → Menü → **Zum Startbildschirm hinzufügen**.
3. Im Portal: Stunden (Soll/Ist), Dienstplan aller Studios, Schichttausch, Passwort ändern, Einwilligung widerrufen.

---

## Gut zu wissen
- **2FA:** Admin-Rechte in der App gelten nur mit zweitem Faktor (Authenticator-App).
  Die Einrichtung per QR-Code kommt mit dem Admin-Login der App. Der SQL Editor ist davon nicht betroffen.
- **Telegram absichern:** Freigaben per Button laufen über euer Telegram-Konto → dort
  *Einstellungen → Datenschutz → Zweistufige Bestätigung* aktivieren.
- **Nur Freigaben, keine Einzelmeldungen:**
  `update public.telegram_links set notify_bookings = false where chat_id = <CHAT_ID>;`
- **Fehlersuche:** Edge Functions → `telegram` bzw. `kiosk-admin` → **Logs**.
- **Regeln (änderbar in `rule_settings`):** bis 5 Min. zu spät = pünktlich · Überstunden nur nach Freigabe ·
  jede Pause mind. 15 Min., gesetzlich 30/45 Min. ab 6/9 Std. · Auto-Checkout 23 Uhr · 18 Uhr Abfrage
  Krank/IST/Urlaub (je 6,5 Std.) · Einstempeln ohne Schicht = Aushilfsschicht im Dienstplan.
- **Schichttausch:** normal nur im eigenen Studio (Studioleitung gibt frei). Knopf „Mit anderem Studio“:
  beide Studioleitungen müssen zustimmen; ein Admin (auch per Telegram) gibt für beide frei.
- **Studio besetzt:** erste Stempelung des Tages je Studio → 🟢-Meldung; 10 Min. nach der ersten geplanten
  Schicht noch niemand da → 🔴-Warnung. Im Bot: `/kurz` = nur Wichtiges, `/alle` = jede Stempelung.
- **Wochenbericht:** freitags 19 Uhr per Telegram (Stunden, Verspätungen, Überstunden, offene Freigaben).
- **Gesichtserkennung & Datenschutz:** Gesichtsdaten nur nach digital unterschriebener Einwilligung.
  Widerruf oder Deaktivierung eines Mitarbeiters löscht die Gesichtsdaten sofort. Am Kiosk schützt eine
  zufällige Kopfdrehung vor Fotos (nicht vor professionell vorbereiteten Videos oder Masken).
