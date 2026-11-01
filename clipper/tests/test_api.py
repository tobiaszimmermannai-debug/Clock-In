from fastapi.testclient import TestClient

from clipper import main


def test_api_flow_without_workers():
    c = TestClient(main.app)  # ohne Kontextmanager -> Worker starten nicht
    assert c.get("/").status_code == 200
    assert c.post("/api/jobs", json={"urls": "https://example.com/v"}).status_code == 403  # Header fehlt
    h = {"X-Clipper": "1"}
    r = c.post("/api/jobs", json={"urls": "https://example.com/a\nhttps://example.com/b", "mode": "auto"}, headers=h)
    assert len(r.json()["ids"]) == 2
    assert c.post("/api/jobs", json={"urls": "kein-link"}, headers=h).status_code == 400
    st = c.get("/api/state").json()
    assert [j["status"] for j in st["jobs"]] == ["queued", "queued"]
    assert set(st["platforms"]) == {"youtube", "facebook", "buffer"}
    assert c.get("/api/state", headers={"Host": "evil.example"}).status_code in (401, 403)


def test_remote_access_requires_password(monkeypatch):
    c = TestClient(main.app)
    remote = {"Host": "gaming-pc.tailnet.ts.net"}
    monkeypatch.delenv("CLIPPER_PASSWORD", raising=False)
    assert c.get("/api/state", headers=remote).status_code == 403
    monkeypatch.setenv("CLIPPER_PASSWORD", "geheim123")
    assert c.get("/api/state", headers=remote).status_code == 401
    r = c.get("/", headers=remote, follow_redirects=False)
    assert r.status_code == 303 and r.headers["location"] == "/login"
    assert c.post("/login", data={"password": "falsch"}, headers=remote).status_code == 401
    r = c.post("/login", data={"password": "geheim123"}, headers=remote, follow_redirects=False)
    assert r.status_code == 303 and "clipper_session" in r.cookies
    c.cookies.set("clipper_session", r.cookies["clipper_session"])
    assert c.get("/api/state", headers=remote).status_code == 200
    assert c.get("/api/state").status_code == 200  # lokal weiterhin ohne Passwort
    c.cookies.clear()
    # Proxy/Tunnel, der den Host auf localhost umschreibt, zählt trotzdem als Fernzugriff
    assert c.get("/api/state", headers={"X-Forwarded-For": "100.64.0.7"}).status_code == 401


def test_codec_and_compute_selection(monkeypatch):
    from clipper import render, transcribe
    from clipper.config import CFG
    assert render.pick_codec() in ("h264_nvenc", "h264_videotoolbox", "libx264")
    assert "-cq" in render.encoder_args("h264_nvenc") and "-crf" in render.encoder_args("libx264")
    monkeypatch.setitem(CFG["whisper"], "device", "cuda")
    monkeypatch.setitem(CFG["whisper"], "compute_type", "auto")
    assert transcribe._resolve(False) == ("cuda", "float16")  # RTX 50: kein int8_float16
    assert transcribe._resolve(True) == ("cpu", "int8")
