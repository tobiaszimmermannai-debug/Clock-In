"""Clip-Kandidaten finden: Sätze bilden, KI fragen, auf Satzgrenzen einrasten, Score berechnen."""
from __future__ import annotations

import re

from . import llm
from .config import CFG
from .signals import combine, curve_score

END_PUNCT = re.compile(r"[.!?…。！？]['\")\]]*$")


def sentences(words: list[dict], max_gap: float = 1.2, max_len: float = 30.0) -> list[dict]:
    out, cur = [], []
    for i, w in enumerate(words):
        if cur and (w["s"] - cur[-1]["e"] > max_gap or w["e"] - cur[0]["s"] > max_len):
            out.append(cur)
            cur = []
        cur.append(w)
        if END_PUNCT.search(w["w"]):
            out.append(cur)
            cur = []
    if cur:
        out.append(cur)
    return [{"s": c[0]["s"], "e": c[-1]["e"], "text": " ".join(x["w"] for x in c), "words": c} for c in out]


def fmt_time(sec: float) -> str:
    sec = int(sec)
    return f"{sec // 3600}:{sec % 3600 // 60:02d}:{sec % 60:02d}"


def build_prompt(sents: list[dict], title: str, n: int, mn: int, mx: int, lang: str = "") -> str:
    lines = "\n".join(f"S{i} [{s['s']:.1f}-{s['e']:.1f}] {s['text']}" for i, s in enumerate(sents))
    return f"""You are an expert short-form video editor (YouTube Shorts, TikTok, Reels).
Below is a transcript excerpt from the video/stream "{title}", split into numbered sentences
with timestamps in seconds. Find up to {n} self-contained moments that work as vertical short clips
of {mn}-{mx} seconds.

Rules:
- A clip starts at the beginning of a sentence and ends at the end of a sentence.
  Give the sentence ids: start_id (first sentence) and end_id (last sentence).
- Duration (end of end_id minus start of start_id) must be between {mn} and {mx} seconds.
- It must be understandable without the rest of the video and have a clear payoff.
- Prefer strong hooks in the first 3 seconds, emotion, surprise, humour, conflict, useful insights.
- No overlapping clips. Return fewer clips (or an empty list) if nothing is good.

Score each clip from 0 to 100:
- hook: does the first sentence grab attention immediately?
- tension: suspense, emotion or payoff that keeps people watching
- clarity: understandable without any context
Be strict: 80+ only for genuinely strong moments.

Write "title" (max 70 characters, catchy but honest) and "description" (1-2 sentences plus 3 hashtags)
in {lang or "the language of the transcript"}. "reason": one short sentence why this works.

Answer with JSON only, no other text:
{{"clips":[{{"start_id":0,"end_id":5,"hook":0,"tension":0,"clarity":0,"title":"","description":"","reason":""}}]}}

Transcript:
{lines}
"""


def snap(sents: list[dict], a: int, b: int, mn: float, mx: float) -> tuple[float, float] | None:
    n = len(sents)
    a, b = max(0, min(a, n - 1)), max(0, min(b, n - 1))
    if b < a:
        a, b = b, a
    dur = lambda: sents[b]["e"] - sents[a]["s"]  # noqa: E731
    while dur() < mn and b + 1 < n and sents[b + 1]["e"] - sents[a]["s"] <= mx:
        b += 1
    while dur() < mn and a > 0 and sents[b]["e"] - sents[a - 1]["s"] <= mx:
        a -= 1
    while dur() > mx and b > a:
        b -= 1
    start, end = sents[a]["s"], sents[b]["e"]
    if end - start > mx:  # einzelner überlanger "Satz": am letzten Wort vor dem Limit schneiden
        ends = [w["e"] for w in sents[b]["words"] if w["e"] - start <= mx]
        end = ends[-1] if ends else start + mx
    if end - start < mn - 3:
        return None
    return round(max(0.0, start - 0.1), 2), round(end + 0.3, 2)


def find_candidates(words: list[dict], title: str, curve: list | None, min_start: float) -> list[dict]:
    """Analysiert ein Transkript-Fenster. Kandidaten, die vor `min_start` enden, werden verworfen
    (sie lagen komplett in der Überlappung und wurden schon im vorigen Abschnitt bewertet)."""
    sc, lc = CFG["scoring"], CFG["llm"]
    mn, mx = int(sc["min_clip_seconds"]), int(sc["max_clip_seconds"])
    sents = sentences(words)
    if len(sents) < 2 or sents[-1]["e"] - sents[0]["s"] < mn - 3:
        return []
    raw = llm.complete(build_prompt(sents, title, int(lc["max_candidates_per_chunk"]), mn, mx,
                                    lc.get("output_language", "")))
    data = llm.extract_json(raw)
    out = []
    for c in data.get("clips", []) if isinstance(data, dict) else []:
        try:
            span = snap(sents, int(c["start_id"]), int(c["end_id"]), mn, mx)
        except (KeyError, ValueError, TypeError):
            continue
        if not span or span[1] <= min_start:
            continue
        sub = [float(c.get(k, 0) or 0) for k in ("hook", "tension", "clarity")]
        ai = max(0.0, min(100.0, sum(sub) / 3))
        sig = curve_score(curve, *span) if curve else None
        out.append({"start": span[0], "end": span[1], "title": str(c.get("title", ""))[:100],
                    "description": str(c.get("description", "")), "reason": str(c.get("reason", "")),
                    "hook": next((x["text"] for x in sents if x["s"] >= span[0]), ""), "ai_score": round(ai, 1),
                    "signal_score": None if sig is None else round(sig * 100, 1),
                    "score": combine(ai, sig, float(sc["ai_weight"]), float(sc["signal_weight"]))})
    return out


def overlaps(a: tuple[float, float], b: tuple[float, float], ratio: float = 0.5) -> bool:
    inter = min(a[1], b[1]) - max(a[0], b[0])
    return inter > 0 and inter / max(1e-6, min(a[1] - a[0], b[1] - b[0])) > ratio
