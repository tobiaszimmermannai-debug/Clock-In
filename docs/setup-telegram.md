# Einrichtung: Telegram-Bot & 2FA

Einmalig, ca. 15 Minuten. Platzhalter in `<…>` ersetzen.
`<REF>` = Projekt-Referenz aus der Supabase-URL (`https://<REF>.supabase.co`).

## 1. Bot anlegen
1. In Telegram **@BotFather** öffnen → `/newbot` → Name und Benutzername vergeben.
2. Den **Token** kopieren (`123456:ABC…`), er wird nur im Supabase-Secret gespeichert.

## 2. Secrets erzeugen und setzen
```bash
NOTIFY_SECRET=$(openssl rand -hex 32)
WEBHOOK_SECRET=$(openssl rand -hex 32)
echo "NOTIFY_SECRET=$NOTIFY_SECRET"   # für Schritt 4 notieren

supabase link --project-ref <REF>
supabase secrets set TELEGRAM_BOT_TOKEN=<TOKEN> \
  NOTIFY_SECRET=$NOTIFY_SECRET TELEGRAM_WEBHOOK_SECRET=$WEBHOOK_SECRET
```

## 3. Datenbank & Functions deployen
```bash
supabase db push
# ohne JWT-Prüfung: Aufrufer sind DB bzw. Telegram, abgesichert über eigene Secrets
supabase functions deploy telegram-notify  --no-verify-jwt
supabase functions deploy telegram-webhook --no-verify-jwt
```

## 4. Vault-Secrets (Supabase → SQL-Editor)
```sql
select vault.create_secret('https://<REF>.supabase.co/functions/v1', 'edge_functions_url');
select vault.create_secret('<NOTIFY_SECRET>', 'notify_secret');
```

## 5. Webhook bei Telegram registrieren
```bash
curl -s "https://api.telegram.org/bot<TOKEN>/setWebhook" \
  -d "url=https://<REF>.supabase.co/functions/v1/telegram-webhook" \
  -d "secret_token=$WEBHOOK_SECRET" \
  -d 'allowed_updates=["message","callback_query"]'
```
Antwort muss `"ok":true` enthalten.

## 6. Admins verbinden
1. Jeder Admin öffnet den Bot und sendet `/start` → der Bot antwortet mit der **Chat-ID**.
2. Freischalten (bis der Admin-Bereich steht, im SQL-Editor):
   ```sql
   insert into public.telegram_links (user_id, chat_id)
   values ((select id from public.users where first_name = '<Vorname>' and role = 'admin'), <CHAT_ID>);
   ```
3. Erneut `/start` senden → „✅ Verbunden als …“.

Nur jede Stempelung stummschalten (Freigabe-Anfragen kommen weiter):
`update public.telegram_links set notify_bookings = false where chat_id = <CHAT_ID>;`

## 7. 2FA für Admins
- In Supabase ist TOTP-2FA standardmäßig aktiv (Authentication → Multi-Factor).
- Admin-Rechte gelten **nur** in Sitzungen mit zweitem Faktor (Authenticator-App).
  Ohne 2FA sieht ein Admin-Konto nur die normale Mitarbeiter-Ansicht.
- Die Einrichtung (QR-Code scannen) kommt in den Admin-Login der App (Schritt 4).
- Freigaben per Telegram-Button laufen ohne App-Login: Das verknüpfte Telegram-Konto
  ist dafür der Schlüssel. Tipp: In Telegram selbst die Zweistufige Bestätigung aktivieren.

## Was kommt wann?
| Ereignis | Nachricht |
|---|---|
| Kommen / Pause / Gehen am Tablet | 🔔 Name ist im Studio X eingestempelt (08:57) |
| Offline nachgesendet (selber Tag) | wie oben + „📶 offline nachgesendet“ |
| Auto-Checkout | 🤖 Name wurde automatisch ausgestempelt |
| Nachtrag durch Admin | ✍️ Nachtrag von … (nur Info) |
| Nachtrag durch Studioleitung / Offline-Sync vom Vortag | 📝 mit Buttons **✅ OK** / **❌ Ablehnen** |
