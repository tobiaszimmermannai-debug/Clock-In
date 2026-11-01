"""Lädt config.toml (Einstellungen) und .env (Zugangsdaten)."""
from __future__ import annotations

import copy
import os
import tomllib
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env")

DEFAULTS: dict = {
    "server": {"host": "127.0.0.1", "port": 8000},
    "paths": {"data_dir": "data"},
    "whisper": {"model": "small", "device": "auto", "compute_type": "auto", "language": "", "beam_size": 5},
    "chunking": {"chunk_minutes": 12, "overlap_seconds": 60},
    "download": {"strategy": "auto", "full_max_minutes": 45, "max_height": 1080,
                 "cookies_from_browser": "", "fetch_chat": True},
    "live": {"segment_minutes": 10, "from_start": False, "chat": True},
    "llm": {"backend": "claude_cli", "claude_cli_model": "sonnet", "anthropic_model": "claude-sonnet-5-5",
            "ollama_model": "qwen2.5:7b", "ollama_url": "http://127.0.0.1:11434", "ollama_num_ctx": 8192,
            "max_candidates_per_chunk": 5, "timeout_seconds": 600, "output_language": ""},
    "scoring": {"ai_weight": 0.5, "signal_weight": 0.5, "threshold": 80,
                "min_clip_seconds": 20, "max_clip_seconds": 60},
    "render": {"width": 1080, "height": 1920, "framing": "crop", "face_tracking": True,
               "video_codec": "auto", "crf": 20, "preset": "veryfast", "font": "Arial Black",
               "font_size": 86, "words_per_caption": 3, "highlight_color": "&H0000E5FF",
               "caption_position": 0.68},
    "publish": {"youtube_category_id": "22", "default_tags": ["shorts"]},
}

# Umgebungsvariablen, die einzelne Einstellungen überschreiben (praktisch für Tests)
ENV_OVERRIDES = {
    "CLIPPER_DATA_DIR": ("paths", "data_dir"),
    "CLIPPER_PORT": ("server", "port"),
    "CLIPPER_WHISPER_MODEL": ("whisper", "model"),
    "CLIPPER_LLM_BACKEND": ("llm", "backend"),
    "CLIPPER_SEGMENT_MINUTES": ("live", "segment_minutes"),
    "CLIPPER_CHUNK_MINUTES": ("chunking", "chunk_minutes"),
    "CLIPPER_HOST": ("server", "host"),
    "CLIPPER_WHISPER_DEVICE": ("whisper", "device"),
    "CLIPPER_WHISPER_COMPUTE": ("whisper", "compute_type"),
    "CLIPPER_OLLAMA_URL": ("llm", "ollama_url"),
    "CLIPPER_OLLAMA_MODEL": ("llm", "ollama_model"),
    "CLIPPER_VIDEO_CODEC": ("render", "video_codec"),
    "CLIPPER_FONT": ("render", "font"),
}


def _merge(base: dict, extra: dict) -> dict:
    out = copy.deepcopy(base)
    for k, v in extra.items():
        out[k] = _merge(out[k], v) if isinstance(v, dict) and isinstance(out.get(k), dict) else v
    return out


def load_config() -> dict:
    path = Path(os.environ.get("CLIPPER_CONFIG", ROOT / "config.toml"))
    cfg = DEFAULTS
    if path.exists():
        with open(path, "rb") as f:
            cfg = _merge(DEFAULTS, tomllib.load(f))
    cfg = copy.deepcopy(cfg)
    for env, (sec, key) in ENV_OVERRIDES.items():
        if os.environ.get(env):
            val = os.environ[env]
            default = DEFAULTS[sec][key]
            cfg[sec][key] = type(default)(float(val)) if isinstance(default, (int, float)) else val
    data = Path(cfg["paths"]["data_dir"])
    cfg["paths"]["data_dir"] = str(data if data.is_absolute() else ROOT / data)
    return cfg


CFG = load_config()
DATA_DIR = Path(CFG["paths"]["data_dir"])
DATA_DIR.mkdir(parents=True, exist_ok=True)


def secret(name: str) -> str:
    """Zugangsdaten ausschließlich aus der Umgebung / .env lesen."""
    return os.environ.get(name, "").strip()
