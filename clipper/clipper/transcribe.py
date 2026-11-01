"""Lokale Transkription mit faster-whisper (Wort-Zeitstempel)."""
from __future__ import annotations

import subprocess
import threading
from typing import Callable

import numpy as np

from .config import CFG

_model = None
_device = ""          # tatsächlich genutztes Gerät: "cuda" oder "cpu"
_lock = threading.RLock()
SR = 16000


def _resolve(force_cpu: bool) -> tuple[str, str]:
    w = CFG["whisper"]
    device = "cpu" if force_cpu else w["device"]
    if device == "auto":
        try:
            import ctranslate2
            device = "cuda" if ctranslate2.get_cuda_device_count() > 0 else "cpu"
        except Exception:  # noqa: BLE001
            device = "cpu"
    compute = w["compute_type"]
    if compute == "auto" or (device == "cpu" and "float16" in compute):
        # RTX 50 (Blackwell): int8_float16 -> CUBLAS_STATUS_NOT_SUPPORTED, float16 läuft stabil
        compute = "float16" if device == "cuda" else "int8"
    return device, compute


def get_model(force_cpu: bool = False):
    global _model, _device
    with _lock:
        if _model is None or (force_cpu and _device != "cpu"):
            from faster_whisper import WhisperModel
            device, compute = _resolve(force_cpu)
            try:
                _model = WhisperModel(CFG["whisper"]["model"], device=device, compute_type=compute)
            except Exception as e:  # noqa: BLE001
                if device == "cpu":
                    raise
                print(f"[whisper] GPU nicht nutzbar ({e}) – weiter auf CPU", flush=True)
                return get_model(force_cpu=True)
            _device = device
            print(f"[whisper] Modell {CFG['whisper']['model']} auf {device} ({compute})", flush=True)
        return _model


def device_label() -> str:
    return _device or CFG["whisper"]["device"]


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
    try:
        return _run(get_model(), audio, shift, start, end, progress, should_cancel)
    except RuntimeError as e:
        if _device == "cpu" or "abgebrochen" in str(e):
            raise
        print(f"[whisper] GPU-Fehler ({e}) – wechsle auf CPU", flush=True)
        return _run(get_model(force_cpu=True), audio, shift, start, end, progress, should_cancel)


def _run(model, audio, shift, start, end, progress, should_cancel) -> dict:
    w = CFG["whisper"]
    segments, info = model.transcribe(
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
