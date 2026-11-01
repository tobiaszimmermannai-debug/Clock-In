"""Alles rund um yt-dlp: Infos, Heatmap, Chat-Replay, Medien-Download, Abschnitts-Download."""
from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Callable

import yt_dlp

from .config import CFG


class Cancelled(Exception):
    pass


def base_opts() -> dict:
    opts = {"quiet": True, "no_warnings": True, "noplaylist": True, "noprogress": True,
            "retries": 10, "fragment_retries": 10, "continuedl": True}
    browser = CFG["download"].get("cookies_from_browser")
    if browser:
        opts["cookiesfrombrowser"] = (browser,)
    return opts


def ytdlp_cli() -> list[str]:
    """yt-dlp als Kommandozeile aus derselben Python-Umgebung (gleiche Version wie das Modul)."""
    cli = [sys.executable, "-m", "yt_dlp", "--no-warnings"]
    browser = CFG["download"].get("cookies_from_browser")
    if browser:
        cli += ["--cookies-from-browser", browser]
    return cli


def fetch_info(url: str, workdir: Path) -> dict:
    with yt_dlp.YoutubeDL(base_opts()) as ydl:
        info = ydl.sanitize_info(ydl.extract_info(url, download=False))
    if info.get("_type") == "playlist":
        raise ValueError("Playlists werden nicht unterstützt – bitte einzelne Video-Links eintragen.")
    (workdir / "info.json").write_text(json.dumps(info))
    if info.get("heatmap"):
        (workdir / "heatmap.json").write_text(json.dumps(info["heatmap"]))
    return info


def is_live(info: dict) -> bool:
    return bool(info.get("is_live")) or info.get("live_status") == "is_live"


def chat_lang(info: dict) -> str | None:
    subs = info.get("subtitles") or {}
    for lang in ("live_chat", "rechat"):
        if lang in subs:
            return lang
    return None


def download_chat_replay(url: str, info: dict, workdir: Path) -> Path | None:
    """Lädt das Chat-Replay (YouTube live_chat / Twitch rechat) ohne Video."""
    lang = chat_lang(info)
    if not lang:
        return None
    opts = base_opts() | {"skip_download": True, "writesubtitles": True, "subtitleslangs": [lang],
                          "outtmpl": str(workdir / "chat.%(ext)s")}
    with yt_dlp.YoutubeDL(opts) as ydl:
        ydl.download([url])
    found = sorted(workdir.glob("chat*.json"))
    return found[0] if found else None


def _progress_hook(cb: Callable[[float, str], None], should_cancel: Callable[[], bool]):
    def hook(d: dict) -> None:
        if should_cancel():
            raise Cancelled()
        if d.get("status") == "downloading":
            total = d.get("total_bytes") or d.get("total_bytes_estimate") or 0
            frac = (d.get("downloaded_bytes", 0) / total) if total else 0.0
            cb(frac, d.get("_speed_str", "").strip())
    return hook


def download_media(url: str, workdir: Path, audio_only: bool,
                   cb: Callable[[float, str], None], should_cancel: Callable[[], bool]) -> Path:
    h = int(CFG["download"]["max_height"])
    name = "audio" if audio_only else "media"
    fmt = "ba/b" if audio_only else f"bv*[height<={h}]+ba/b[height<={h}]/bv*+ba/b"
    opts = base_opts() | {"format": fmt, "outtmpl": str(workdir / f"{name}.%(ext)s"),
                          "progress_hooks": [_progress_hook(cb, should_cancel)]}
    if not audio_only:
        opts["merge_output_format"] = "mp4"
    with yt_dlp.YoutubeDL(opts) as ydl:
        ydl.download([url])
    files = [p for p in workdir.glob(f"{name}.*") if p.suffix not in (".part", ".ytdl", ".json")]
    if not files:
        raise RuntimeError("Download fehlgeschlagen – keine Datei gefunden.")
    return max(files, key=lambda p: p.stat().st_size)


def download_section(url: str, start: float, end: float, out: Path) -> Path:
    """Lädt nur einen Zeitabschnitt des Videos (für lange VODs)."""
    h = int(CFG["download"]["max_height"])
    stem = out.with_suffix("")
    opts = base_opts() | {
        "format": f"bv*[height<={h}]+ba/b[height<={h}]/bv*+ba/b",
        "outtmpl": str(stem) + ".%(ext)s",
        "merge_output_format": "mp4",
        "download_ranges": yt_dlp.utils.download_range_func(None, [(start, end)]),
        "force_keyframes_at_cuts": True,
    }
    with yt_dlp.YoutubeDL(opts) as ydl:
        ydl.download([url])
    files = [p for p in stem.parent.glob(stem.name + ".*") if p.suffix not in (".part", ".ytdl")]
    if not files:
        raise RuntimeError("Abschnitts-Download fehlgeschlagen.")
    return files[0]


def source_link(url: str, info: dict | None, seconds: float) -> str:
    """Link zur Quelle mit Zeitstempel (YouTube ?t=, Twitch ?t=1h2m3s)."""
    s = max(0, int(seconds))
    extractor = (info or {}).get("extractor_key", "").lower()
    page = (info or {}).get("webpage_url") or url
    sep = "&" if "?" in page else "?"
    if "youtube" in extractor:
        return f"{page}{sep}t={s}s"
    if "twitch" in extractor:
        return f"{page}{sep}t={s // 3600}h{s % 3600 // 60}m{s % 60}s"
    return page
