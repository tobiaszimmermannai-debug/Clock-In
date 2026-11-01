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
    assert c.get("/api/state", headers={"Host": "evil.example"}).status_code == 403
