"""YouTube Data API v3 – Upload IMMER mit privacyStatus=private (Entwurf in YouTube Studio)."""
from __future__ import annotations

import json
import os

import httpx

from ..config import CFG, secret

TOKEN_URL = "https://oauth2.googleapis.com/token"
UPLOAD_URL = "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status"


def configured() -> bool:
    return all(secret(k) for k in ("YOUTUBE_CLIENT_ID", "YOUTUBE_CLIENT_SECRET", "YOUTUBE_REFRESH_TOKEN"))


def access_token() -> str:
    r = httpx.post(TOKEN_URL, data={"client_id": secret("YOUTUBE_CLIENT_ID"),
                                    "client_secret": secret("YOUTUBE_CLIENT_SECRET"),
                                    "refresh_token": secret("YOUTUBE_REFRESH_TOKEN"),
                                    "grant_type": "refresh_token"}, timeout=30)
    r.raise_for_status()
    return r.json()["access_token"]


def upload_draft(video: str, title: str, description: str, video_url: str = "") -> dict:
    body = {
        "snippet": {"title": (title or "Clip")[:100], "description": description[:4900],
                    "tags": CFG["publish"]["default_tags"], "categoryId": str(CFG["publish"]["youtube_category_id"])},
        # Fest verdrahtet: niemals öffentlich hochladen.
        "status": {"privacyStatus": "private", "selfDeclaredMadeForKids": False},
    }
    size = os.path.getsize(video)
    headers = {"Authorization": f"Bearer {access_token()}", "Content-Type": "application/json; charset=UTF-8",
               "X-Upload-Content-Type": "video/mp4", "X-Upload-Content-Length": str(size)}
    r = httpx.post(UPLOAD_URL, headers=headers, content=json.dumps(body), timeout=60)
    r.raise_for_status()
    session = r.headers["Location"]
    with open(video, "rb") as f:
        r = httpx.put(session, content=f.read(), headers={"Content-Type": "video/mp4"}, timeout=600)
    r.raise_for_status()
    vid = r.json()["id"]
    return {"id": vid, "url": f"https://studio.youtube.com/video/{vid}/edit", "state": "private"}
