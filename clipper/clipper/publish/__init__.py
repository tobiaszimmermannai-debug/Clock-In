"""Freigegebene Clips als ENTWURF hochladen. Es wird nie automatisch veröffentlicht."""
from __future__ import annotations

from . import buffer, meta, youtube

PLATFORMS = {
    "youtube": ("YouTube (privat)", youtube),
    "facebook": ("Facebook-Reel (Entwurf)", meta),
    "buffer": ("Buffer (Entwurf)", buffer),
}


def available() -> dict:
    return {k: {"label": label, "configured": mod.configured()} for k, (label, mod) in PLATFORMS.items()}


def post(platform: str, video: str, title: str, description: str, video_url: str = "") -> dict:
    _, mod = PLATFORMS[platform]
    if not mod.configured():
        raise RuntimeError(f"{platform}: Zugangsdaten fehlen in .env")
    return mod.upload_draft(video, title, description, video_url=video_url)
