"""FastAPI-App: Weboberfläche unter http://localhost:8000 + JSON-API."""
from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import secrets
import shutil
import threading
import time
import urllib.parse
from contextlib import asynccontextmanager
from pathlib import Path

import uvicorn
from fastapi import Body, FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles

from . import db, live, publish, transcribe, worker
from .config import CFG, DATA_DIR, secret
from .download import source_link

STATIC = Path(__file__).parent / "static"
ARCHIVE = DATA_DIR / "archive"
ARCHIVE.mkdir(exist_ok=True)
MEDIA_PORT = int(CFG["server"]["port"]) + 1


# ---------------------------------------------------------------- Nur-Video-Server für Buffer
media_app = FastAPI()


@media_app.get("/media/clip/{clip_id}.mp4")
def public_clip(clip_id: int):
    """Liefert nur Clips aus, die gerade gepostet werden/wurden. Für den Tunnel (Port 8001) gedacht,
    damit die eigentliche Oberfläche nie öffentlich erreichbar ist."""
    c = db.one("SELECT * FROM clips WHERE id=? AND status IN ('posting','posted')", (clip_id,))
    if not c or not c["file"] or not Path(c["file"]).exists():
        raise HTTPException(404)
    return FileResponse(c["file"], media_type="video/mp4")


def _run_media_server() -> None:
    server = uvicorn.Server(uvicorn.Config(media_app, host=CFG["server"]["host"], port=MEDIA_PORT,
                                           log_level="warning"))
    server.run()


@asynccontextmanager
async def lifespan(_: FastAPI):
    worker.start()
    threading.Thread(target=_run_media_server, daemon=True).start()
    yield
    worker.shutdown()


app = FastAPI(title="Clipper", lifespan=lifespan)
app.mount("/static", StaticFiles(directory=STATIC), name="static")


# ---------------------------------------------------------------- Zugriffsschutz
LOCAL_HOSTS = ("localhost", "127.0.0.1", "[::1]", "testserver")
COOKIE = "clipper_session"


def _session_token(password: str) -> str:
    """Stabiles Sitzungs-Token, abgeleitet aus Passwort + lokalem Zufallsschlüssel."""
    keyfile = DATA_DIR / "session.key"
    if not keyfile.exists():
        keyfile.write_text(secrets.token_hex(32))
    key = hashlib.sha256((keyfile.read_text() + password).encode()).digest()
    return hmac.new(key, b"clipper-session", hashlib.sha256).hexdigest()


LOGIN_PAGE = """<!doctype html><html lang="de"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Clipper – Anmelden</title>
<link rel="stylesheet" href="/static/style.css"></head><body><main style="max-width:380px;margin-top:12vh">
<form class="card" method="post" action="/login"><h2>Clipper</h2>
<input type="password" name="password" placeholder="Passwort" autofocus required>
<div class="row"><button class="primary" type="submit">Anmelden</button><span class="err">{err}</span></div>
</form></main></body></html>"""


@app.middleware("http")
async def access_guard(request: Request, call_next):
    """Lokal (localhost) ohne Passwort. Von außen (Tailscale, Tunnel, LAN) nur mit CLIPPER_PASSWORD."""
    raw = request.headers.get("host") or ""
    host = raw.split("]")[0] + "]" if raw.startswith("[") else raw.split(":")[0]
    path = request.url.path
    proxied = any(h in request.headers for h in ("x-forwarded-for", "cf-connecting-ip", "tailscale-user-login"))
    if host not in LOCAL_HOSTS or proxied:  # über Tunnel/Proxy = immer Fernzugriff
        password = secret("CLIPPER_PASSWORD")
        if not password:
            return JSONResponse({"detail": "Fernzugriff ist gesperrt. Setze CLIPPER_PASSWORD in .env."}, status_code=403)
        if path not in ("/login", "/static/style.css") and \
                not hmac.compare_digest(request.cookies.get(COOKIE, ""), _session_token(password)):
            if path.startswith("/api/"):
                return JSONResponse({"detail": "Nicht angemeldet."}, status_code=401)
            return RedirectResponse("/login", status_code=303)
    if request.method not in ("GET", "HEAD") and path != "/login" and request.headers.get("x-clipper") != "1":
        return JSONResponse({"detail": "Fehlender X-Clipper-Header."}, status_code=403)
    return await call_next(request)


@app.get("/login")
def login_page():
    return HTMLResponse(LOGIN_PAGE.format(err=""))


@app.post("/login")
async def login(request: Request):
    password = secret("CLIPPER_PASSWORD")
    given = urllib.parse.parse_qs((await request.body()).decode()).get("password", [""])[0]
    if not password or not hmac.compare_digest(given.encode(), password.encode()):
        await asyncio.sleep(1.5)  # bremst Passwort-Raten
        return HTMLResponse(LOGIN_PAGE.format(err="Falsches Passwort"), status_code=401)
    resp = RedirectResponse("/", status_code=303)
    resp.set_cookie(COOKIE, _session_token(password), max_age=60 * 60 * 24 * 30, httponly=True, samesite="strict",
                    secure=request.headers.get("x-forwarded-proto") == "https" or request.url.scheme == "https")
    return resp


@app.get("/")
def index():
    return FileResponse(STATIC / "index.html")


# ---------------------------------------------------------------- Status
def _clip_view(c: dict, jobs: dict) -> dict:
    j = jobs.get(c["job_id"]) or {}
    meta = json.loads(j.get("meta") or "{}")
    info = {"webpage_url": meta.get("page") or j.get("url"), "extractor_key": meta.get("extractor", "")}
    c = dict(c)
    c["publish"] = json.loads(c.get("publish") or "{}")
    c["job_title"] = j.get("title") or j.get("url")
    c["job_kind"] = j.get("kind")
    c["source_url"] = source_link(j.get("url", ""), info, c["start"]) if j.get("kind") != "live" or \
        meta.get("extractor", "").lower().startswith("youtube") else (meta.get("page") or j.get("url"))
    c["video"] = f"/api/clips/{c['id']}/video?v={int(c.get('created_at') or 0)}" if c.get("file") else ""
    return c


@app.get("/api/state")
def state():
    all_jobs = db.q("SELECT * FROM jobs ORDER BY id DESC")
    by_id = {j["id"]: j for j in all_jobs}
    jobs = [j for j in all_jobs if j["status"] != "cancelled"]
    counts = {r["job_id"]: r for r in db.q("""SELECT job_id, COUNT(*) total,
        SUM(status IN ('review','posting','posted')) good, SUM(status='below') below
        FROM clips GROUP BY job_id""")}
    chunks = {r["job_id"]: r for r in db.q("""SELECT job_id, COUNT(*) total, SUM(status='done') done
        FROM chunks GROUP BY job_id""")}
    out_jobs = []
    for j in jobs:
        j = dict(j)
        j.pop("meta", None)
        j["clips"] = counts.get(j["id"], {"total": 0, "good": 0, "below": 0})
        j["chunks"] = chunks.get(j["id"], {"total": 0, "done": 0})
        j["recording"] = j["id"] in live.RECORDERS
        out_jobs.append(j)
    clips = db.q("SELECT * FROM clips WHERE status IN ('review','posting','posted','discarded','error') "
                 "ORDER BY score DESC, id DESC")
    view = [_clip_view(c, by_id) for c in clips if c["job_id"] in by_id]
    return {
        "jobs": out_jobs,
        "review": [c for c in view if c["status"] in ("review", "posting", "error")],
        "posted": [c for c in view if c["status"] == "posted"],
        "archive": [c for c in view if c["status"] == "discarded"],
        "platforms": publish.available(),
        "settings": {"threshold": CFG["scoring"]["threshold"], "llm": CFG["llm"]["backend"],
                     "whisper": f'{CFG["whisper"]["model"]} · {transcribe.device_label()}', "ai_weight": CFG["scoring"]["ai_weight"],
                     "signal_weight": CFG["scoring"]["signal_weight"]},
    }


# ---------------------------------------------------------------- Jobs
@app.post("/api/jobs")
def add_jobs(payload: dict = Body(...)):
    mode = payload.get("mode", "auto")
    if mode not in ("auto", "video", "live"):
        raise HTTPException(400, "Ungültiger Modus")
    urls = [u.strip() for u in str(payload.get("urls", "")).replace(",", "\n").splitlines() if u.strip()]
    ids = []
    for u in urls:
        if not u.startswith(("http://", "https://")):
            raise HTTPException(400, f"Kein gültiger Link: {u}")
        now = time.time()
        ids.append(db.ex("INSERT INTO jobs(url, mode, created_at, updated_at) VALUES(?,?,?,?)", (u, mode, now, now)))
    return {"ids": ids}


def _job_or_404(job_id: int) -> dict:
    j = db.job(job_id)
    if not j or j["status"] == "cancelled":
        raise HTTPException(404, "Job nicht gefunden")
    return j


@app.post("/api/jobs/{job_id}/retry")
def retry(job_id: int):
    j = _job_or_404(job_id)
    meta = db.job_meta(j)
    if j["kind"] != "live" and not meta.get("media"):
        db.update("jobs", job_id, status="queued", message="", progress=0)
        return {"ok": True}
    db.ex("UPDATE chunks SET status='pending', error='' WHERE job_id=? AND status='error'", (job_id,))
    for c in db.q("SELECT * FROM clips WHERE job_id=? AND status='error'", (job_id,)):
        db.update("clips", c["id"], status="render", error="")
        db.ex("UPDATE chunks SET status='analyzed' WHERE job_id=? AND idx=? AND status='done'", (job_id, c["chunk_idx"]))
    if j["status"] in ("error", "done"):
        db.update("jobs", job_id, status="processing" if j["kind"] != "live" or j["duration"] else "ready", message="")
    return {"ok": True}


@app.post("/api/jobs/{job_id}/live/start")
def live_start(job_id: int):
    j = _job_or_404(job_id)
    if j["kind"] != "live":
        raise HTTPException(400, "Kein Livestream")
    if j["status"] in ("recording", "stopping"):
        return {"ok": True}
    live.start(job_id)
    db.update("jobs", job_id, status="recording", message="Aufnahme startet …")
    return {"ok": True}


@app.post("/api/jobs/{job_id}/live/stop")
def live_stop(job_id: int):
    _job_or_404(job_id)
    live.stop(job_id)
    return {"ok": True}


@app.delete("/api/jobs/{job_id}")
def delete_job(job_id: int):
    _job_or_404(job_id)
    db.update("jobs", job_id, status="cancelled")
    live.stop(job_id)

    def cleanup() -> None:
        rec = live.RECORDERS.get(job_id)
        if rec:
            rec.join(60)
        time.sleep(2)
        db.ex("DELETE FROM chunks WHERE job_id=?", (job_id,))
        db.ex("DELETE FROM clips WHERE job_id=? AND status NOT IN ('posted','discarded')", (job_id,))
        shutil.rmtree(DATA_DIR / "jobs" / str(job_id), ignore_errors=True)
    threading.Thread(target=cleanup, daemon=True).start()
    return {"ok": True}


# ---------------------------------------------------------------- Clips
def _clip_or_404(clip_id: int) -> dict:
    c = db.one("SELECT * FROM clips WHERE id=?", (clip_id,))
    if not c:
        raise HTTPException(404, "Clip nicht gefunden")
    return c


@app.get("/api/clips/{clip_id}/video")
def clip_video(clip_id: int):
    c = _clip_or_404(clip_id)
    if not c["file"] or not Path(c["file"]).exists():
        raise HTTPException(404)
    return FileResponse(c["file"], media_type="video/mp4")


@app.patch("/api/clips/{clip_id}")
def edit_clip(clip_id: int, payload: dict = Body(...)):
    _clip_or_404(clip_id)
    fields = {k: str(v) for k, v in payload.items() if k in ("title", "description")}
    if fields:
        db.update("clips", clip_id, **fields)
    return {"ok": True}


@app.post("/api/clips/{clip_id}/discard")
def discard(clip_id: int):
    c = _clip_or_404(clip_id)
    f = Path(c["file"]) if c["file"] else None
    if f and f.exists() and f.parent != ARCHIVE:
        target = ARCHIVE / f"job{c['job_id']}_{f.name}"
        shutil.move(str(f), target)
        f.with_suffix(".ass").exists() and f.with_suffix(".ass").unlink()
        db.update("clips", clip_id, file=str(target))
    db.update("clips", clip_id, status="discarded")
    return {"ok": True}


@app.post("/api/clips/{clip_id}/restore")
def restore(clip_id: int):
    c = _clip_or_404(clip_id)
    f = Path(c["file"]) if c["file"] else None
    if f and f.exists() and f.parent == ARCHIVE:
        target = db.job_dir(c["job_id"]) / "clips" / f.name.split("_", 1)[1]
        target.parent.mkdir(exist_ok=True)
        shutil.move(str(f), target)
        db.update("clips", clip_id, file=str(target))
    db.update("clips", clip_id, status="review")
    return {"ok": True}


@app.post("/api/clips/{clip_id}/post")
def post_clip(clip_id: int, payload: dict = Body(...)):
    c = _clip_or_404(clip_id)
    if c["status"] not in ("review", "posted"):
        raise HTTPException(400, "Clip ist nicht in der Freigabe")
    platforms = [p for p in payload.get("platforms", []) if p in publish.PLATFORMS]
    if not platforms:
        raise HTTPException(400, "Keine Plattform gewählt")
    title = str(payload.get("title", c["title"]))
    desc = str(payload.get("description", c["description"]))
    db.update("clips", clip_id, status="posting", title=title, description=desc)

    def run() -> None:
        results = json.loads(c.get("publish") or "{}")
        base = secret("PUBLIC_BASE_URL").rstrip("/")
        url = f"{base}/media/clip/{clip_id}.mp4" if base else ""
        for p in platforms:
            try:
                results[p] = {"ok": True, **publish.post(p, c["file"], title, desc, video_url=url)}
            except Exception as e:  # noqa: BLE001
                results[p] = {"ok": False, "error": str(e)[:300]}
        ok = any(r.get("ok") for r in results.values())
        db.update("clips", clip_id, status="posted" if ok else "review", publish=results)
    threading.Thread(target=run, daemon=True).start()
    return {"ok": True}
