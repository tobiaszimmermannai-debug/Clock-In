"""Einmalig ausführen, um den YouTube-Refresh-Token zu erzeugen und in .env zu speichern.

Voraussetzung: YOUTUBE_CLIENT_ID und YOUTUBE_CLIENT_SECRET (OAuth-Client vom Typ "Desktop-App")
stehen in .env. Aufruf:  .venv/bin/python scripts/youtube_auth.py
"""
from __future__ import annotations

import secrets
import sys
import urllib.parse
import webbrowser
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

import httpx
from dotenv import dotenv_values

ROOT = Path(__file__).resolve().parent.parent
ENV = ROOT / ".env"
PORT = 8085
REDIRECT = f"http://127.0.0.1:{PORT}"
SCOPE = "https://www.googleapis.com/auth/youtube.upload"


def main() -> None:
    env = dotenv_values(ENV)
    cid, csec = env.get("YOUTUBE_CLIENT_ID"), env.get("YOUTUBE_CLIENT_SECRET")
    if not cid or not csec:
        sys.exit("Bitte zuerst YOUTUBE_CLIENT_ID und YOUTUBE_CLIENT_SECRET in .env eintragen.")
    state = secrets.token_urlsafe(16)
    url = "https://accounts.google.com/o/oauth2/v2/auth?" + urllib.parse.urlencode({
        "client_id": cid, "redirect_uri": REDIRECT, "response_type": "code", "scope": SCOPE,
        "access_type": "offline", "prompt": "consent", "state": state})
    result: dict = {}

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            ok = q.get("state", [""])[0] == state and "code" in q
            if ok:
                result["code"] = q["code"][0]
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.end_headers()
            self.wfile.write("Fertig – du kannst dieses Fenster schließen.".encode() if ok else b"Fehler.")

        def log_message(self, *a):
            pass

    print("Browser öffnet sich – mit dem YouTube-Konto anmelden und zustimmen …")
    print(url)
    webbrowser.open(url)
    HTTPServer(("127.0.0.1", PORT), Handler).handle_request()
    if "code" not in result:
        sys.exit("Kein Autorisierungscode erhalten.")
    r = httpx.post("https://oauth2.googleapis.com/token", data={
        "code": result["code"], "client_id": cid, "client_secret": csec,
        "redirect_uri": REDIRECT, "grant_type": "authorization_code"}, timeout=30)
    r.raise_for_status()
    token = r.json().get("refresh_token")
    if not token:
        sys.exit("Kein Refresh-Token erhalten (Zugriff unter myaccount.google.com/permissions entfernen und erneut versuchen).")
    lines = ENV.read_text().splitlines()
    lines = [ln for ln in lines if not ln.startswith("YOUTUBE_REFRESH_TOKEN=")] + [f"YOUTUBE_REFRESH_TOKEN={token}"]
    ENV.write_text("\n".join(lines) + "\n")
    print("✓ Refresh-Token in .env gespeichert.")


if __name__ == "__main__":
    main()
