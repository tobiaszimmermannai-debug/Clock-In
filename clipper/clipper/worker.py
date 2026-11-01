"""Hintergrund-Worker: Download-Worker (Netz) und Verarbeitungs-Worker (CPU) laufen parallel.

Fortsetzen nach Abbruch: Jeder Abschnitt speichert seinen Fortschritt (pending → transcribed →
analyzed → done) und seine Zwischenergebnisse als Datei. Nach einem Neustart geht es genau dort weiter.
"""
from __future__ import annotations

import json
import math
import subprocess
import threading
import time
import traceback
from pathlib import Path

from . import db, live
from .analyze import find_candidates, overlaps
from .config import CFG
from .download import (Cancelled, download_chat_replay, download_media, download_section, fetch_info,
                       is_live)
from .render import render_clip
from .signals import chat_curve, heatmap_curve, load_chat_file, resolve_times
from .transcribe import transcribe_range

STOP = threading.Event()
STAGE_WEIGHT = {"pending": 0.0, "transcribed": 0.7, "analyzed": 0.85, "done": 1.0, "error": 1.0}


def cancelled(job_id: int) -> bool:
    j = db.job(job_id)
    return j is None or j["status"] == "cancelled"


def media_duration(path: str) -> float:
    r = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "json", path],
                       capture_output=True, text=True)
    try:
        return float(json.loads(r.stdout)["format"]["duration"])
    except (KeyError, ValueError, json.JSONDecodeError):
        return 0.0


# ====================================================================== Download / Vorbereitung
def prepare(j: dict) -> None:
    jid = j["id"]
    wd = db.job_dir(jid)
    db.update("jobs", jid, status="downloading", progress=0, message="Infos werden geladen …")
    info_path = wd / "info.json"
    info = json.loads(info_path.read_text()) if info_path.exists() else fetch_info(j["url"], wd)
    title = info.get("title") or j["url"]
    db.set_meta(jid, page=info.get("webpage_url") or j["url"], extractor=info.get("extractor_key", ""))
    if info.get("live_status") == "is_upcoming":
        raise RuntimeError("Der Stream hat noch nicht begonnen – später erneut versuchen.")
    if is_live(info) or j["mode"] == "live":
        db.update("jobs", jid, kind="live", status="ready", title=title, progress=0,
                  message="Bereit – „Start“ drücken, um den Livestream mitzuschneiden.")
        return

    db.update("jobs", jid, kind="video", title=title, duration=float(info.get("duration") or 0))
    # Beliebtheitssignal: Heatmap, sonst Chat-Replay, sonst nichts
    signal_type = ""
    curve = heatmap_curve(info.get("heatmap"))
    if curve:
        signal_type = "heatmap"
    elif CFG["download"]["fetch_chat"]:
        db.update("jobs", jid, message="Keine Heatmap – lade Chat-Replay …")
        try:
            chat = download_chat_replay(j["url"], info, wd)
            if chat:
                events = resolve_times(load_chat_file(chat))
                curve = chat_curve(events, info.get("duration"))
                signal_type = "chat" if curve else ""
        except Exception as e:  # noqa: BLE001 – Chat ist optional
            db.update("jobs", jid, message=f"Chat-Replay nicht verfügbar ({str(e)[:80]})")
    if curve:
        (wd / "signal.json").write_text(json.dumps({"type": signal_type, "curve": curve}))
    db.update("jobs", jid, signal_type=signal_type)

    duration = float(info.get("duration") or 0)
    strategy = CFG["download"]["strategy"]
    if strategy == "auto":
        strategy = "sections" if duration > float(CFG["download"]["full_max_minutes"]) * 60 else "full"
    audio_only = strategy == "sections"
    db.update("jobs", jid, message="Audio wird geladen …" if audio_only else "Video wird geladen …")

    def cb(frac: float, speed: str) -> None:
        db.update("jobs", jid, progress=round(frac, 4), message=f"Download {frac * 100:.0f} % {speed}")

    media = download_media(j["url"], wd, audio_only, cb, lambda: cancelled(jid))
    duration = media_duration(str(media)) or duration
    L = float(CFG["chunking"]["chunk_minutes"]) * 60
    for i in range(max(1, math.ceil(duration / L))):
        db.ex("INSERT OR IGNORE INTO chunks(job_id, idx, start, end, media, media_offset) VALUES(?,?,?,?,?,0)",
              (jid, i, i * L, min(duration, (i + 1) * L), str(media)))
    db.set_meta(jid, strategy=strategy, media=str(media))
    db.update("jobs", jid, status="processing", stage="transcribing", progress=0, duration=duration, message="")


def download_loop() -> None:
    while not STOP.is_set():
        j = db.one("SELECT * FROM jobs WHERE status='queued' ORDER BY id LIMIT 1")
        if not j:
            time.sleep(1)
            continue
        try:
            prepare(j)
        except Cancelled:
            pass
        except Exception as e:  # noqa: BLE001
            traceback.print_exc()
            if not cancelled(j["id"]):
                db.update("jobs", j["id"], status="error", message=str(e)[:500])


# ====================================================================== Verarbeitung
def chunk_words_path(job_id: int, idx: int) -> Path:
    d = db.job_dir(job_id) / "chunks"
    d.mkdir(exist_ok=True)
    return d / f"{idx:05d}.words.json"


def load_words(job_id: int, start: float, end: float) -> list[dict]:
    words = []
    for c in db.q("SELECT idx FROM chunks WHERE job_id=? AND end>? AND start<? ORDER BY idx", (job_id, start, end)):
        p = chunk_words_path(job_id, c["idx"])
        if p.exists():
            words += [w for w in json.loads(p.read_text())["words"] if w["e"] > start and w["s"] < end]
    return words


def load_curve(j: dict) -> list | None:
    if j["kind"] == "live":
        msgs = []
        for f in live.live_chat_files(j["id"]):
            msgs += load_chat_file(f)
        events = resolve_times(msgs, db.job_meta(j).get("sessions"))
        return chat_curve(events, j["duration"]) or None
    p = db.job_dir(j["id"]) / "signal.json"
    return json.loads(p.read_text())["curve"] if p.exists() else None


def update_progress(job_id: int, extra: float = 0.0) -> None:
    j = db.job(job_id)
    if not j or j["kind"] == "live":
        return
    cs = db.q("SELECT status FROM chunks WHERE job_id=?", (job_id,))
    if cs:
        db.update("jobs", job_id, progress=round((sum(STAGE_WEIGHT.get(c["status"], 0) for c in cs) + extra) / len(cs), 4))


def set_stage(j: dict, c: dict, stage: str) -> None:
    labels = {"transcribing": "transkribiert", "analyzing": "analysiert", "rendering": "geschnitten"}
    total = db.one("SELECT COUNT(*) n FROM chunks WHERE job_id=?", (j["id"],))["n"]
    what = "Segment" if j["kind"] == "live" else "Abschnitt"
    msg = f"{what} {c['idx'] + 1}{'' if j['kind'] == 'live' else f'/{total}'} wird {labels[stage]} …"
    fields = {"stage": stage}
    if j["kind"] == "live" and j["status"] in ("recording", "stopping"):
        fields["message"] = f"Aufnahme läuft · {msg}"
    else:
        fields.update(status="processing", message=msg)
    db.update("jobs", j["id"], **fields)


def resolve_source(j: dict, clip: dict) -> tuple[dict, float]:
    meta = db.job_meta(j)
    start, end = clip["start"], clip["end"]
    if meta.get("strategy") == "full":
        return {"path": meta["media"]}, start
    if meta.get("strategy") == "sections":
        out = db.job_dir(j["id"]) / "sections" / f"clip_{clip['id']}.mp4"
        out.parent.mkdir(exist_ok=True)
        if not out.exists():
            out = download_section(j["url"], start, end, out)
        return {"path": str(out)}, 0.0
    segs = db.q("SELECT * FROM chunks WHERE job_id=? AND end>? AND start<? ORDER BY idx", (j["id"], start, end))
    if not segs:
        raise RuntimeError("Kein Segment für diesen Zeitraum gefunden.")
    if len(segs) == 1:
        return {"path": segs[0]["media"]}, start - segs[0]["media_offset"]
    lst = db.job_dir(j["id"]) / "live" / f"concat_{clip['id']}.txt"
    lst.write_text("".join(f"file '{s['media']}'\n" for s in segs))
    return {"path": segs[0]["media"], "concat": str(lst)}, start - segs[0]["media_offset"]


def render_one(j: dict, clip: dict) -> None:
    out = db.job_dir(j["id"]) / "clips" / f"clip_{clip['id']}.mp4"
    try:
        src, ss = resolve_source(j, clip)
        words = load_words(j["id"], clip["start"], clip["end"])
        render_clip(src, ss, clip["end"] - clip["start"], words, clip["start"], out)
        db.update("clips", clip["id"], status="review", file=str(out), error="")
    except Exception as e:  # noqa: BLE001
        traceback.print_exc()
        db.update("clips", clip["id"], status="error", error=str(e)[:500])


def process_chunk(c: dict) -> None:
    jid = c["job_id"]
    j = db.job(jid)
    if c["status"] == "pending":
        set_stage(j, c, "transcribing")
        wp = chunk_words_path(jid, c["idx"])
        if not wp.exists():
            done_before = sum(STAGE_WEIGHT.get(x["status"], 0)
                              for x in db.q("SELECT status FROM chunks WHERE job_id=?", (jid,)))
            res = transcribe_range(c["media"], c["media_offset"], c["start"], c["end"],
                                   progress=lambda f: (j["kind"] != "live") and db.update(
                                       "jobs", jid, progress=round((done_before + 0.7 * f) / max(1, db.one(
                                           "SELECT COUNT(*) n FROM chunks WHERE job_id=?", (jid,))["n"]), 4)),
                                   should_cancel=lambda: cancelled(jid))
            res["start"], res["end"] = c["start"], c["end"]
            wp.write_text(json.dumps(res))
        db.update("chunks", c["id"], status="transcribed")
        c["status"] = "transcribed"
        update_progress(jid)

    if c["status"] == "transcribed":
        j = db.job(jid)
        set_stage(j, c, "analyzing")
        overlap = float(CFG["chunking"]["overlap_seconds"])
        words = load_words(jid, c["start"] - overlap, c["end"])
        cands = find_candidates(words, j["title"], load_curve(j), min_start=c["start"])
        existing = [(x["start"], x["end"]) for x in db.q("SELECT start, end FROM clips WHERE job_id=?", (jid,))]
        thr = float(CFG["scoring"]["threshold"])
        for cand in sorted(cands, key=lambda x: -x["score"]):
            span = (cand["start"], cand["end"])
            if any(overlaps(span, e) for e in existing):
                continue
            existing.append(span)
            db.ex("""INSERT INTO clips(job_id, chunk_idx, start, end, title, description, hook, reason,
                     ai_score, signal_score, score, status, created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                  (jid, c["idx"], cand["start"], cand["end"], cand["title"], cand["description"], cand["hook"],
                   cand["reason"], cand["ai_score"], cand["signal_score"], cand["score"],
                   "render" if cand["score"] >= thr else "below", time.time()))
        db.update("chunks", c["id"], status="analyzed")
        c["status"] = "analyzed"
        update_progress(jid)

    if c["status"] == "analyzed":
        j = db.job(jid)
        todo = db.q("SELECT * FROM clips WHERE job_id=? AND chunk_idx=? AND status='render'", (jid, c["idx"]))
        if todo:
            set_stage(j, c, "rendering")
        for clip in todo:
            if cancelled(jid):
                return
            render_one(j, clip)
        db.update("chunks", c["id"], status="done")
        update_progress(jid)


def finalize_jobs() -> None:
    for j in db.q("SELECT * FROM jobs WHERE status='processing'"):
        open_ = db.one("SELECT COUNT(*) n FROM chunks WHERE job_id=? AND status IN ('pending','transcribed','analyzed')",
                       (j["id"],))["n"]
        if open_:
            continue
        errs = db.q("SELECT idx, error FROM chunks WHERE job_id=? AND status='error'", (j["id"],))
        errs += db.q("SELECT id, 'Clip ' || id || ': ' || error AS error FROM clips WHERE job_id=? AND status='error'",
                     (j["id"],))
        n_review = db.one("SELECT COUNT(*) n FROM clips WHERE job_id=? AND status IN ('review','posting','posted')",
                          (j["id"],))["n"]
        n_all = db.one("SELECT COUNT(*) n FROM clips WHERE job_id=?", (j["id"],))["n"]
        if errs:
            db.update("jobs", j["id"], status="error", stage="",
                      message=f"{len(errs)} Fehler: {errs[0]['error'][:200]}")
        else:
            db.update("jobs", j["id"], status="done", stage="", progress=1.0,
                      message=f"{n_all} Kandidaten, {n_review} ≥ {CFG['scoring']['threshold']} % in der Freigabe")


def process_loop() -> None:
    while not STOP.is_set():
        c = db.one("""SELECT c.* FROM chunks c JOIN jobs j ON j.id=c.job_id
                      WHERE c.status IN ('pending','transcribed','analyzed')
                        AND j.status NOT IN ('queued','downloading','cancelled')
                      ORDER BY (j.kind='live') DESC, j.id, c.idx LIMIT 1""")
        if not c:
            finalize_jobs()
            time.sleep(1)
            continue
        try:
            process_chunk(c)
        except Exception as e:  # noqa: BLE001
            traceback.print_exc()
            if not cancelled(c["job_id"]):
                db.update("chunks", c["id"], status="error", error=str(e)[:500])
                update_progress(c["job_id"])


# ====================================================================== Start / Wiederaufnahme
def recover() -> None:
    db.ex("UPDATE jobs SET status='queued', progress=0 WHERE status='downloading'")
    db.ex("UPDATE jobs SET status='processing' WHERE status IN ('recording','stopping')")
    db.ex("UPDATE clips SET status='review' WHERE status='posting'")


def start() -> None:
    recover()
    for target in (download_loop, process_loop):
        threading.Thread(target=target, daemon=True, name=target.__name__).start()


def shutdown() -> None:
    STOP.set()
    live.stop_all()
