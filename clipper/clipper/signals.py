"""Beliebtheitssignale: YouTube-Heatmap ("Am häufigsten wiedergegeben") und Chat-Aktivität.

Eine "Kurve" ist eine Liste von [start, end, value] mit value in 0..1.
"""
from __future__ import annotations

import json
import re
from pathlib import Path

LAUGH = re.compile(r"\b(lo+l|lmao+|rofl|kekw|lul|omegalul|pog(gers|champ)?|ha(ha)+|xd+|wtf|omg|w+)\b"
                   r"|😂|🤣|💀|😭|🔥", re.IGNORECASE)
HYPE = re.compile(r"[!?]{3,}")
CAPS = re.compile(r"\b[A-ZÄÖÜ]{4,}\b")


# ---------------------------------------------------------------- Heatmap
def heatmap_curve(heatmap: list[dict] | None) -> list[list[float]]:
    """yt-dlp liefert [{start_time, end_time, value}], value bereits ~0..1. Wir normalisieren min-max."""
    if not heatmap:
        return []
    vals = [float(h.get("value") or 0) for h in heatmap]
    lo, hi = min(vals), max(vals)
    span = (hi - lo) or 1.0
    return [[float(h["start_time"]), float(h["end_time"]), (v - lo) / span] for h, v in zip(heatmap, vals)]


# ---------------------------------------------------------------- Chat
def message_weight(text: str, has_emote: bool = False) -> float:
    w = 1.0
    if has_emote:
        w += 1.0
    if LAUGH.search(text or ""):
        w += 1.0
    if HYPE.search(text or "") or CAPS.search(text or ""):
        w += 0.5
    return w


def _runs_text(runs: list[dict]) -> tuple[str, bool]:
    parts, emote = [], False
    for r in runs or []:
        if "text" in r:
            parts.append(r["text"])
        elif "emoji" in r:
            emote = True
            sc = (r["emoji"].get("shortcuts") or [""])[0]
            parts.append(sc)
    return "".join(parts), emote


def parse_youtube_chat_line(obj: dict) -> list[tuple[float | None, float | None, str, bool]]:
    """Gibt (offset_sec, epoch_sec, text, emote) für jede Textnachricht einer JSON-Zeile zurück."""
    out = []
    replay = obj.get("replayChatItemAction")
    offset = None
    actions = []
    if replay:
        actions = replay.get("actions", [])
        if replay.get("videoOffsetTimeMsec") is not None:
            offset = int(replay["videoOffsetTimeMsec"]) / 1000
    if obj.get("videoOffsetTimeMsec") is not None:
        offset = int(obj["videoOffsetTimeMsec"]) / 1000
    if "addChatItemAction" in obj:
        actions.append(obj)
    actions += obj.get("actions", []) if not replay else []
    for act in actions:
        item = (act.get("addChatItemAction") or {}).get("item") or {}
        for key in ("liveChatTextMessageRenderer", "liveChatPaidMessageRenderer"):
            r = item.get(key)
            if not r:
                continue
            text, emote = _runs_text((r.get("message") or {}).get("runs", []))
            epoch = int(r["timestampUsec"]) / 1e6 if r.get("timestampUsec") else None
            out.append((offset, epoch, text, emote))
    return out


def load_chat_file(path: Path) -> list[dict]:
    """Liest YouTube-live_chat.json (JSON-Lines) oder Twitch-rechat/IRC-Mitschnitt.

    Rückgabe: [{"t": offset|None, "epoch": epoch|None, "text": str, "emote": bool}]
    """
    msgs: list[dict] = []
    if not path.exists():
        return msgs
    raw = path.read_text(encoding="utf-8", errors="ignore")
    stripped = raw.lstrip()
    if stripped.startswith("{") and '"comments"' in raw[:2000]:
        try:  # Twitch rechat (ganzes JSON-Dokument)
            data = json.loads(raw)
            for c in data.get("comments", []):
                msg = c.get("message") or {}
                body = msg.get("body") or "".join(f.get("text", "") for f in msg.get("fragments", []))
                emote = bool(msg.get("emoticons")) or any(f.get("emoticon") for f in msg.get("fragments", []))
                msgs.append({"t": float(c.get("content_offset_seconds", 0)), "epoch": None,
                             "text": body, "emote": emote})
            return msgs
        except json.JSONDecodeError:
            pass
    for line in raw.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
        except json.JSONDecodeError:
            continue  # letzte Zeile kann bei laufender Aufnahme unvollständig sein
        if "text" in obj and ("t" in obj or "epoch" in obj):  # eigenes Format (Twitch-IRC)
            msgs.append({"t": obj.get("t"), "epoch": obj.get("epoch"), "text": obj["text"],
                         "emote": bool(obj.get("emote"))})
            continue
        for off, epoch, text, emote in parse_youtube_chat_line(obj):
            msgs.append({"t": off, "epoch": epoch, "text": text, "emote": emote})
    return msgs


def resolve_times(msgs: list[dict], sessions: list[dict] | None = None) -> list[tuple[float, float]]:
    """Ordnet jeder Nachricht eine Zeit auf der Job-Zeitachse zu und liefert (zeit, gewicht)."""
    out = []
    sessions = sorted(sessions or [], key=lambda s: s["epoch"])
    for m in msgs:
        t = None if sessions else m.get("t")  # Live-Aufnahme: Echtzeit (epoch) ist verlässlicher
        if sessions and m.get("epoch") is None:
            t = m.get("t")
        if t is None and m.get("epoch") is not None and sessions:
            ses = None
            for s in sessions:
                if s["epoch"] <= m["epoch"]:
                    ses = s
            if ses is None:
                continue
            t = ses["base"] + (m["epoch"] - ses["epoch"])
        if t is None or t < 0:
            continue
        out.append((float(t), message_weight(m.get("text", ""), m.get("emote", False))))
    return out


def chat_curve(events: list[tuple[float, float]], duration: float | None = None,
               step: float = 10.0, window: float = 60.0) -> list[list[float]]:
    """Gewichtete Nachrichten pro Minute (gleitendes 60-s-Fenster in 10-s-Schritten), normalisiert."""
    if not events:
        return []
    end = max(duration or 0, max(t for t, _ in events)) + step
    n = int(end // step) + 1
    bins = [0.0] * n
    for t, w in events:
        bins[min(int(t // step), n - 1)] += w
    k = max(1, int(round(window / step)))
    rate = []
    for i in range(n):
        lo, hi = max(0, i - k // 2), min(n, i - k // 2 + k)
        rate.append(sum(bins[lo:hi]) * (60.0 / (step * (hi - lo))))
    srt = sorted(rate)
    base = srt[int(0.2 * (len(srt) - 1))]           # Grundrauschen
    peak = srt[int(0.98 * (len(srt) - 1))] or max(rate)
    span = (peak - base) or 1.0
    return [[i * step, (i + 1) * step, max(0.0, min(1.0, (r - base) / span))] for i, r in enumerate(rate)]


# ---------------------------------------------------------------- Bewertung
def curve_score(curve: list[list[float]], start: float, end: float) -> float | None:
    """0..1 für das Intervall: halb Durchschnitt, halb Spitzenwert (überlappungsgewichtet)."""
    if not curve or end <= start:
        return None
    total, acc, peak = 0.0, 0.0, 0.0
    for s, e, v in curve:
        ov = min(e, end) - max(s, start)
        if ov > 0:
            total += ov
            acc += v * ov
            peak = max(peak, v)
    if total <= 0:
        return None
    return 0.5 * (acc / total) + 0.5 * peak


def combine(ai_score: float, signal: float | None, ai_weight: float, signal_weight: float) -> float:
    """Gesamtscore 0..100. Ohne Signal zählt nur die KI-Bewertung."""
    if signal is None or (ai_weight + signal_weight) <= 0:
        return round(ai_score, 1)
    return round((ai_weight * ai_score + signal_weight * signal * 100) / (ai_weight + signal_weight), 1)
