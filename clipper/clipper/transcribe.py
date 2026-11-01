"""Lokale Transkription mit faster-whisper (Wort-Zeitstempel)."""
from __future__ import annotations

import subprocess
import threading
from typing import Callable

import numpy as np

from .config import CFG

_model = None
_lock = threading.Lock()
SR = 16000


def get_model():
    global _model
    with _lock:
        if _model is None:
            from faster_whisper import WhisperModel
            w = CFG["whisper"]
            _model = WhisperModel(w["model"], device=w["device"], compute_type=w["compute_type"])
        return _model


def load_audio(path: str, start: float = 0.0, duration: float | None = None) -> np.ndarray:
    """Dekodiert einen Ausschnitt per ffmpeg zu 16-kHz-Mono-float32."""
    cmd = ["ffmpeg", "-v", "error", "-nostdin", "-ss", f"{max(0.0, start):.3f}", "-i", path]
    if duration:
        cmd += ["-t", f"{duration:.3f}"]
    cmd += ["-vn", "-ac", "1", "-ar", str(SR), "-f", "s16le", "-"]
    raw = subprocess.run(cmd, capture_output=True, check=True).stdout
    return np.frombuffer(raw, np.int16).astype(np.float32) / 32768.0


def transcribe_range(media: str, media_offset: float, start: float, end: float,
                     progress: Callable[[float], None] | None = None,
                     should_cancel: Callable[[], bool] | None = None) -> dict:
    """Transkribiert [start, end) (absolute Zeiten) aus `media`.

    Etwas Rand links/rechts verhindert abgeschnittene Wörter; zurück kommen nur Wörter,
    deren Mitte im Abschnitt liegt. Zeiten im Ergebnis sind absolut.
    """
    pad = 1.5
    local_start = max(0.0, start - media_offset - pad)
    local_end = end - media_offset + pad
    audio = load_audio(media, local_start, local_end - local_start)
    shift = media_offset + local_start
    w = CFG["whisper"]
    segments, info = get_model().transcribe(
        audio, language=w["language"] or None, beam_size=int(w["beam_size"]),
        word_timestamps=True, vad_filter=True, condition_on_previous_text=False)
    words = []
    total = max(1e-6, len(audio) / SR)
    for seg in segments:
        if should_cancel and should_cancel():
            raise InterruptedError("abgebrochen")
        for wd in seg.words or []:
            s, e = wd.start + shift, wd.end + shift
            if start <= (s + e) / 2 < end and wd.word.strip():
                words.append({"w": wd.word.strip(), "s": round(s, 3), "e": round(e, 3)})
        if progress:
            progress(min(1.0, seg.end / total))
    return {"language": info.language, "words": words}
