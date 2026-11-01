# Clipper – selbstgehostetes Clipping-Tool (Videos & Livestreams)

Clipper läuft lokal auf deinem Mac und macht aus langen Videos, Stream-Aufzeichnungen und **laufenden
Livestreams** automatisch 9:16-Hochkant-Clips mit eingebrannten Untertiteln. Du gibst die Clips vor dem
Posten frei. Hochgeladen wird **immer nur als Entwurf bzw. privat**.

Alle Bausteine sind kostenlos: yt-dlp, ffmpeg, faster-whisper (lokal), Ollama (lokal) oder deine
Claude-CLI. Es gibt kein AssemblyAI, kein OpenAI und keine Testversionen.

```
Link ─► yt-dlp (Infos, Heatmap/Chat, Audio/Video) ─► Abschnitte à 12 min (+60 s Überlappung)
     ─► faster-whisper (Wort-Zeitstempel) ─► KI wählt 20–60-s-Kandidaten auf Satzgrenzen
     ─► Score = 50 % KI + 50 % Beliebtheit ─► ab 80 %: ffmpeg 9:16 + Untertitel ─► Freigabe
     ─► „Posten“ = YouTube (privat) · Facebook-Reel (Entwurf) · Buffer (Entwurf)
```

## Funktionen

| Bereich | Umsetzung |
|---|---|
| Oberfläche | `http://localhost:8000`: Warteschlange mit Status (wartet / lädt / transkribiert / analysiert / schneidet / fertig / Fehler) und Fortschrittsbalken; dazu die Tabs Freigabe, Entwürfe und Archiv |
| Download | yt-dlp (YouTube, Twitch und alles andere, was yt-dlp kann) |
| Beliebtheit | YouTube-**Heatmap** („Am häufigsten wiedergegeben“). Fehlt sie, wird die **Chat-Aktivität** aus dem Live-Chat-Replay genutzt: Nachrichten pro Minute, Ausschläge bei Emotes, „LOL“, „KEKW“ oder „!!!“ zählen mehr. Gibt es beides nicht, zählt nur die KI. |
| Lange VODs (2–8 h+) | Zuerst wird **nur das Audio** geladen. Transkription und Analyse laufen in Abschnitten von 12 min mit 60 s Überlappung. Für jeden Clip wird **nur dieser Zeitabschnitt** des Videos nachgeladen und gerendert. Nach einem Abbruch geht es an der letzten Stelle weiter. |
| Livestreams | Mitschnitt in Segmenten zu je 10 min. Jedes fertige Segment geht sofort durch die Pipeline, Clips erscheinen also schon **während** des Streams in der Freigabe. Start und Stopp per Button. Der Live-Chat wird mitgeschnitten (YouTube über yt-dlp, Twitch über anonymes IRC). |
| Transkription | faster-whisper lokal, Wort-Zeitstempel, Modellgröße einstellbar |
| KI | `claude_cli` (dein Claude-Login), `anthropic_api` (Key nur aus `.env`) oder `ollama` (komplett lokal). Umschalten in `config.toml`. |
| Schnitt | 1080×1920, Ausschnitt mittig bzw. auf das Gesicht des Sprechers (OpenCV), gut lesbare Wort-für-Wort-Untertitel |
| Posten | Nur als Entwurf: YouTube `privacyStatus=private`, Facebook-Reel `video_state=DRAFT`, Buffer `saveToDraft`. Diese Werte sind fest im Code verdrahtet. |

## Installation (macOS)

### 1. Homebrew-Pakete

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"   # falls Homebrew fehlt
brew install python@3.12 ffmpeg yt-dlp deno
```

`deno` braucht yt-dlp inzwischen für viele YouTube-Formate. Die yt-dlp-Python-Version installiert
`start.sh` zusätzlich automatisch in die virtuelle Umgebung.

### 2. KI-Backend wählen (eines reicht)

**a) Claude-CLI (Standard).** Nutzt dein vorhandenes Claude-Abo und hat keine API-Kosten.

```bash
brew install node
npm install -g @anthropic-ai/claude-code
claude          # einmal einloggen, danach mit /exit beenden
```

Clipper entfernt beim Aufruf der CLI bewusst `ANTHROPIC_API_KEY` aus der Umgebung, damit nie
versehentlich über die kostenpflichtige API abgerechnet wird.

**b) Ollama (optional, 100 % lokal und kostenlos)**

```bash
brew install ollama
ollama serve &          # oder die Ollama-App starten
ollama pull qwen2.5:7b  # gute Wahl für 16 GB RAM; bei 8 GB: qwen2.5:3b
```

Dann in `config.toml`: `backend = "ollama"`.

**c) Anthropic-API.** Das ist pay-per-use und deshalb nur optional. Key in `.env` als `ANTHROPIC_API_KEY`
eintragen und `backend = "anthropic_api"` setzen.

### 3. Projekt holen und starten

```bash
git clone <dein-repo> && cd <dein-repo>/clipper
./start.sh
```

Beim ersten Start legt `start.sh` die virtuelle Umgebung `.venv` an, installiert die Pakete und
kopiert `.env.example` nach `.env`. Danach öffnet sich der Browser unter **http://localhost:8000**.
Ab dem zweiten Mal genügt `./start.sh`.

### 4. faster-whisper-Modell

Das Modell aus `config.toml` (`[whisper] model`, Standard `small`) wird beim ersten Transkribieren
automatisch heruntergeladen und im Cache gespeichert. Vorab laden geht so:

```bash
.venv/bin/python -c "from faster_whisper import WhisperModel; WhisperModel('small', compute_type='int8')"
```

| Modell | RAM | Geschwindigkeit (M1/M2, CPU) | Qualität |
|---|---|---|---|
| `base` | ~1 GB | sehr schnell | ok für klare Sprache |
| `small` | ~2 GB | ~3–5× Echtzeit | **guter Standard** |
| `medium` | ~5 GB | ~1–2× Echtzeit | besser bei Dialekt und Lärm |
| `large-v3` | ~10 GB | langsamer als Echtzeit | beste Qualität |

Für Livestreams muss die Transkription schneller sein als der Stream, deshalb dort `small` oder `base` nutzen.

### 5. `.env` ausfüllen (nur für das Posten nötig)

Alle Zugangsdaten stehen **ausschließlich** in `clipper/.env`. Die Datei ist in `.gitignore`, und eine
Vorlage ohne echte Werte liegt in `.env.example`. Leere Werte bedeuten, dass die Plattform deaktiviert
ist (ausgegraut in der Oberfläche).

**YouTube (privat in YouTube Studio).** Die API ist kostenlos; das Kontingent reicht für etwa 6 Uploads pro Tag.
1. [Google Cloud Console](https://console.cloud.google.com/): Projekt anlegen und **YouTube Data API v3** aktivieren.
2. OAuth-Zustimmungsbildschirm einrichten (Typ „Extern“) und dich selbst als Testnutzer eintragen.
3. Anmeldedaten → OAuth-Client-ID → Typ **Desktop-App**. Client-ID und Secret in `.env` eintragen.
4. Refresh-Token holen (öffnet den Browser und schreibt den Token in `.env`):
   ```bash
   .venv/bin/python scripts/youtube_auth.py
   ```

**Meta (Facebook-Seite, Reel als Entwurf in der Business Suite)**
1. Auf [developers.facebook.com](https://developers.facebook.com/) eine App vom Typ „Business“ anlegen.
2. Im Graph API Explorer einen **Page Access Token** mit `pages_manage_posts`, `pages_read_engagement`
   und `pages_show_list` erzeugen. Für die Dauer in einen Long-Lived-Token tauschen.
3. `META_PAGE_ID` und `META_PAGE_ACCESS_TOKEN` in `.env` eintragen.

Instagram bietet über die offizielle API **keine Entwürfe**. Für Instagram-Entwürfe den Buffer-Kanal nutzen.

**Buffer (Entwurf in deinem vorhandenen Buffer-Setup)**
1. In Buffer unter Settings → API einen API-Key erzeugen und als `BUFFER_API_KEY` eintragen.
2. Die Channel-IDs deiner Kanäle (Instagram, TikTok, …) kommagetrennt als `BUFFER_CHANNEL_IDS` eintragen.
3. Buffer lädt Videos per URL. Dafür einen kostenlosen Cloudflare-Quick-Tunnel starten (ohne Konto):
   ```bash
   brew install cloudflared
   cloudflared tunnel --url http://localhost:8001
   ```
   Die angezeigte `https://….trycloudflare.com`-Adresse als `PUBLIC_BASE_URL` in `.env` eintragen und
   Clipper neu starten. Port 8001 liefert **nur** Clip-Videos aus, die gerade gepostet werden. Die
   Oberfläche auf Port 8000 bleibt lokal.

Die Buffer-GraphQL-Mutation steht in `clipper/publish/buffer.py` (`MUTATION`). Ändert Buffer das
Schema, musst du nur dort anpassen.

## Bedienung

1. Link(s) einfügen, Modus „Automatisch erkennen“ wählen und auf **Zur Warteschlange** klicken.
2. **Videos/VODs** laufen automatisch durch. **Livestreams** stehen danach auf „bereit“: **● Start**
   startet den Mitschnitt, **■ Stopp** beendet ihn. Das letzte Segment wird noch verarbeitet.
3. Im Tab **Freigabe** erscheinen nur Clips mit Score ≥ 80 %. Dort siehst du Vorschau, Score
   (KI/Signal), die Quelle mit Zeitstempel und einen editierbaren Titel und Beschreibung.
   - **Posten (Entwurf)** lädt den Clip auf die angehakten Plattformen als Entwurf hoch.
   - **Verwerfen** verschiebt den Clip ins Archiv (`data/archive/`). Er lässt sich wiederherstellen.
4. Bei Fehlern zeigt die Warteschlange **Erneut versuchen**. Bereits erledigte Abschnitte werden
   dann nicht neu berechnet.

Clipper beenden mit `Ctrl+C`. Beim nächsten Start laufen unterbrochene Jobs automatisch weiter.

## Konfiguration (`config.toml`)

Die wichtigsten Einstellungen:

```toml
[whisper]  model = "small"; language = ""          # "" = automatisch, "de" erzwingt Deutsch
[chunking] chunk_minutes = 12; overlap_seconds = 60
[download] strategy = "auto"                        # auto | full | sections
[live]     segment_minutes = 10; from_start = false
[llm]      backend = "claude_cli"                   # claude_cli | anthropic_api | ollama
           output_language = ""                     # z. B. "German" für deutsche Titel
[scoring]  ai_weight = 0.5; signal_weight = 0.5; threshold = 80
[render]   framing = "crop"; face_tracking = true; video_codec = "libx264"
```

- **Score:** `(ai_weight × KI + signal_weight × Signal) / (ai_weight + signal_weight)`. Die KI-Note ist
  der Mittelwert aus Hook, Spannung und Verständlichkeit ohne Kontext (je 0–100). Das Signal ist
  Heatmap oder Chat, auf 0–1 normalisiert, und wird je zur Hälfte aus Durchschnitt und Spitze im
  Clip-Zeitraum berechnet. Ohne Signal zählt nur die KI.
- **Schneller rendern auf dem Mac:** `video_codec = "h264_videotoolbox"`.
- **Ganzes Bild statt Ausschnitt:** `framing = "fit"` (mit unscharfem Hintergrund).
- **Altersbeschränkte Videos:** `cookies_from_browser = "safari"` oder `"chrome"`.

## Dateien & Daten

```
clipper/
├── start.sh              Start mit einem Befehl
├── config.toml           Einstellungen (keine Secrets)
├── .env.example          Vorlage für Zugangsdaten → .env (git-ignoriert)
├── clipper/
│   ├── main.py           FastAPI-App + API
│   ├── worker.py         Download- und Verarbeitungs-Worker, Fortsetzen nach Abbruch
│   ├── download.py       yt-dlp: Infos, Heatmap, Chat-Replay, Abschnitts-Download
│   ├── signals.py        Heatmap/Chat → Beliebtheitskurve
│   ├── transcribe.py     faster-whisper
│   ├── analyze.py        Sätze, KI-Prompt, Satzgrenzen-Snapping, Score
│   ├── llm.py            Claude-CLI / Anthropic-API / Ollama
│   ├── render.py         ffmpeg 9:16, Gesichts-Zentrierung, ASS-Untertitel
│   ├── live.py           Live-Segmentierung, Twitch-IRC-Chat
│   ├── publish/          youtube.py · meta.py · buffer.py
│   └── static/           Oberfläche (HTML/JS/CSS)
├── scripts/youtube_auth.py
├── tests/                pytest
└── data/                 (git-ignoriert) Datenbank, Downloads, Clips, Archiv
```

## Tests

```bash
.venv/bin/python -m pytest -q
```

## Hinweise & Grenzen

- **Heatmap** gibt es nur bei YouTube-Videos mit genügend Aufrufen, nicht bei Livestreams.
  **Chat-Replay** gibt es bei YouTube-Stream-Aufzeichnungen. Bei Twitch-VODs hängt es davon ab, was
  yt-dlp gerade unterstützt.
- **Live:** Ohne `from_start` beginnt die Aufnahme ab dem Klick auf Start. Zeitstempel beziehen sich
  dann auf den Aufnahmebeginn.
- Nutze das Tool nur für Inhalte, an denen du die Rechte hast bzw. die du clippen darfst.
- **Fehlersuche:** Die Live-Aufnahme schreibt `data/jobs/<id>/live/record_*.log`, die übrigen Fehler
  erscheinen direkt in der Warteschlange. Auch ein `yt-dlp`-Update hilft oft:
  `.venv/bin/pip install -U "yt-dlp[default]"`.
