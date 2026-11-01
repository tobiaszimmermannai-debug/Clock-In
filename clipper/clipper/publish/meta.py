"""Meta Graph API – Facebook-Seiten-Reel mit video_state=DRAFT (erscheint als Entwurf in der Business Suite).

Instagram bietet über die API keine Entwürfe; für Instagram-Entwürfe nutze Buffer.
"""
from __future__ import annotations

import os

import httpx

from ..config import secret


def configured() -> bool:
    return bool(secret("META_PAGE_ID") and secret("META_PAGE_ACCESS_TOKEN"))


def upload_draft(video: str, title: str, description: str, video_url: str = "") -> dict:
    ver = secret("META_GRAPH_VERSION") or "v21.0"
    page, token = secret("META_PAGE_ID"), secret("META_PAGE_ACCESS_TOKEN")
    base = f"https://graph.facebook.com/{ver}/{page}/video_reels"
    r = httpx.post(base, data={"upload_phase": "start", "access_token": token}, timeout=60)
    r.raise_for_status()
    start = r.json()
    vid, upload_url = start["video_id"], start.get("upload_url") or f"https://rupload.facebook.com/video-upload/{ver}/{start['video_id']}"
    with open(video, "rb") as f:
        r = httpx.post(upload_url, content=f.read(), timeout=600,
                       headers={"Authorization": f"OAuth {token}", "offset": "0",
                                "file_size": str(os.path.getsize(video))})
    r.raise_for_status()
    text = f"{title}\n\n{description}".strip()
    # Fest verdrahtet: nur Entwurf, nie veröffentlichen.
    r = httpx.post(base, data={"upload_phase": "finish", "video_id": vid, "video_state": "DRAFT",
                               "description": text, "access_token": token}, timeout=120)
    r.raise_for_status()
    return {"id": vid, "url": "https://business.facebook.com/latest/content_calendar", "state": "draft"}
