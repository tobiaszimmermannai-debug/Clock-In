"""ffmpeg-Rendering: 9:16-Hochkant (1080x1920), Ausschnitt auf Sprecher, eingebrannte Untertitel."""
from __future__ import annotations

import json
import re
import statistics
import subprocess
from pathlib import Path

import numpy as np

from .config import CFG


def probe(path: str) -> tuple[int, int]:
    r = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
                        "stream=width,height", "-of", "json", path], capture_output=True, text=True)
    st = (json.loads(r.stdout or "{}").get("streams") or [{}])[0]
    if not st.get("width"):
        raise RuntimeError(f"Kein Videostream in {path}")
    return int(st["width"]), int(st["height"])


def input_args(src: dict, ss: float) -> list[str]:
    """src = {"path": datei} oder {"concat": liste.txt, "path": erste_datei}."""
    if src.get("concat"):
        return ["-f", "concat", "-safe", "0", "-ss", f"{ss:.3f}", "-i", src["concat"]]
    return ["-ss", f"{ss:.3f}", "-i", src["path"]]


def face_center_x(src: dict, ss: float, dur: float) -> float:
    """Median der horizontalen Gesichtsposition (0..1) über ~1 Bild/Sekunde. 0.5 = Mitte."""
    try:
        import cv2
        cascade = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_frontalface_default.xml")
    except (ImportError, AttributeError):
        return 0.5  # ohne (passendes) OpenCV einfach mittig
    w = 480
    iw, ih = probe(src["path"])
    h = int(round(ih * w / iw / 2) * 2)
    cmd = ["ffmpeg", "-v", "error", "-nostdin", *input_args(src, ss), "-t", f"{dur:.2f}",
           "-vf", f"fps=1,scale={w}:{h}", "-f", "rawvideo", "-pix_fmt", "gray", "-"]
    raw = subprocess.run(cmd, capture_output=True).stdout
    frames = np.frombuffer(raw, np.uint8)
    n = len(frames) // (w * h)
    if n == 0:
        return 0.5
    xs = []
    for i in range(n):
        img = frames[i * w * h:(i + 1) * w * h].reshape(h, w)
        faces = cascade.detectMultiScale(img, scaleFactor=1.1, minNeighbors=5, minSize=(24, 24))
        if len(faces):
            x, y, fw, fh = max(faces, key=lambda f: f[2] * f[3])
            xs.append((x + fw / 2) / w)
    return statistics.median(xs) if len(xs) >= max(1, n // 5) else 0.5


# ---------------------------------------------------------------- Untertitel (ASS)
def _ts(t: float) -> str:
    t = max(0.0, t)
    return f"{int(t // 3600)}:{int(t % 3600 // 60):02d}:{t % 60:05.2f}"


def _clean(word: str) -> str:
    return re.sub(r"[{}\\]", "", word).upper()


def build_ass(words: list[dict], clip_start: float, clip_end: float) -> str:
    r = CFG["render"]
    W, H = int(r["width"]), int(r["height"])
    margin_v = int(H * (1 - float(r["caption_position"])))
    hl = r["highlight_color"]
    head = f"""[Script Info]
ScriptType: v4.00+
PlayResX: {W}
PlayResY: {H}
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,{r['font']},{int(r['font_size'])},&H00FFFFFF,&H00FFFFFF,&H00000000,&H96000000,-1,0,0,0,100,100,0,0,1,7,3,2,70,70,{margin_v},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""
    ws = [w for w in words if w["e"] > clip_start and w["s"] < clip_end]
    groups, cur = [], []
    n = max(1, int(r["words_per_caption"]))
    for w in ws:
        cur.append(w)
        if len(cur) >= n or re.search(r"[.!?,;:…]$", w["w"]):
            groups.append(cur)
            cur = []
    if cur:
        groups.append(cur)
    lines = []
    for gi, g in enumerate(groups):
        nxt = groups[gi + 1][0]["s"] if gi + 1 < len(groups) else None
        for wi, w in enumerate(g):
            start = w["s"]
            if wi + 1 < len(g):
                end = g[wi + 1]["s"]
            else:
                end = w["e"] + 0.15
                if nxt is not None and nxt - end < 0.6:
                    end = nxt  # Lücken zwischen Gruppen schließen -> kein Flackern
            start, end = max(start, clip_start) - clip_start, min(end, clip_end) - clip_start
            if end <= start:
                continue
            text = " ".join(
                (f"{{\\c{hl}&}}{_clean(x['w'])}{{\\r}}" if j == wi else _clean(x["w"])) for j, x in enumerate(g))
            lines.append(f"Dialogue: 0,{_ts(start)},{_ts(end)},Default,,0,0,0,,{text}")
    return head + "\n".join(lines) + "\n"


# ---------------------------------------------------------------- Rendern
def video_filter(iw: int, ih: int, cx: float, ass_name: str) -> str:
    r = CFG["render"]
    W, H = int(r["width"]), int(r["height"])
    ratio = W / H
    if r["framing"] == "fit":
        return (f"[0:v]split[a][b];[a]scale={W}:{H}:force_original_aspect_ratio=increase,crop={W}:{H},"
                f"boxblur=20:2[bg];[b]scale={W}:{H}:force_original_aspect_ratio=decrease[fg];"
                f"[bg][fg]overlay=(W-w)/2:(H-h)/2,setsar=1,ass={ass_name}[v]")
    if iw / ih > ratio:
        cw, ch = int(ih * ratio) // 2 * 2, ih
        x = int(min(max(cx * iw - cw / 2, 0), iw - cw))
        crop = f"crop={cw}:{ch}:{x}:0"
    else:
        cw, ch = iw, int(iw / ratio) // 2 * 2
        crop = f"crop={cw}:{ch}:0:{(ih - ch) // 2}"
    return f"[0:v]{crop},scale={W}:{H}:flags=lanczos,setsar=1,ass={ass_name}[v]"


_codec: str | None = None


def pick_codec() -> str:
    """'auto': NVIDIA NVENC (RTX) > Apple VideoToolbox > libx264 (CPU). Einmal testen, dann merken."""
    global _codec
    want = CFG["render"]["video_codec"]
    if want != "auto":
        return want
    if _codec is None:
        _codec = "libx264"
        for c in ("h264_nvenc", "h264_videotoolbox"):
            r = subprocess.run(["ffmpeg", "-v", "error", "-nostdin", "-f", "lavfi", "-i",
                                "color=c=black:s=256x256:d=0.2", "-c:v", c, "-f", "null", "-"], capture_output=True)
            if r.returncode == 0:
                _codec = c
                break
        print(f"[render] Video-Encoder: {_codec}", flush=True)
    return _codec


def encoder_args(codec: str) -> list[str]:
    r = CFG["render"]
    if "nvenc" in codec:
        return ["-c:v", codec, "-preset", "p5", "-rc", "vbr", "-cq", str(int(r["crf"]) + 1), "-b:v", "0"]
    if "videotoolbox" in codec:
        return ["-c:v", codec, "-b:v", "8M"]
    return ["-c:v", codec, "-crf", str(r["crf"]), "-preset", r["preset"]]


def render_clip(src: dict, ss: float, dur: float, words: list[dict], clip_start: float, out: Path) -> Path:
    r = CFG["render"]
    out.parent.mkdir(parents=True, exist_ok=True)
    ass = out.with_suffix(".ass")
    ass.write_text(build_ass(words, clip_start, clip_start + dur), encoding="utf-8")
    iw, ih = probe(src["path"])
    cx = 0.5
    if r["framing"] == "crop" and r["face_tracking"] and iw / ih > r["width"] / r["height"]:
        cx = face_center_x(src, ss, dur)
    codec = pick_codec()
    for attempt in ([codec, "libx264"] if codec != "libx264" else ["libx264"]):
        cmd = ["ffmpeg", "-y", "-v", "error", "-nostdin", *input_args(src, ss), "-t", f"{dur:.3f}",
               "-filter_complex", video_filter(iw, ih, cx, ass.name), "-map", "[v]", "-map", "0:a?",
               *encoder_args(attempt), "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "160k", "-ar", "48000",
               "-movflags", "+faststart", out.name]
        p = subprocess.run(cmd, cwd=out.parent, capture_output=True, text=True)
        if p.returncode == 0:
            return out
    raise RuntimeError(f"ffmpeg: {p.stderr.strip()[-500:]}")
