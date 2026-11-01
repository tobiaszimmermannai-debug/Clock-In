import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

from clipper import analyze, llm, render, signals
from clipper.config import CFG


# ------------------------------------------------------------------ Signale
def test_heatmap_normalized_and_scored():
    hm = [{"start_time": i * 10, "end_time": (i + 1) * 10, "value": v} for i, v in enumerate([0.2, 0.2, 1.0, 0.6])]
    curve = signals.heatmap_curve(hm)
    assert curve[0][2] == 0 and curve[2][2] == 1
    assert signals.curve_score(curve, 20, 30) == 1.0
    assert signals.curve_score(curve, 0, 20) == 0.0
    assert signals.curve_score([], 0, 10) is None


def test_combine_weights_and_no_signal():
    assert signals.combine(80, None, 0.5, 0.5) == 80
    assert signals.combine(80, 1.0, 0.5, 0.5) == 90
    assert signals.combine(60, 1.0, 0.25, 0.75) == 90


def test_youtube_chat_replay_and_spike(tmp_path):
    lines = []
    for t in range(0, 600, 20):  # ruhiger Chat
        lines.append({"replayChatItemAction": {"actions": [{"addChatItemAction": {"item": {
            "liveChatTextMessageRenderer": {"message": {"runs": [{"text": "hi"}]}}}}}],
            "videoOffsetTimeMsec": str(t * 1000)}})
    for k in range(40):  # Ausschlag bei 300 s mit LOL und Emotes
        lines.append({"replayChatItemAction": {"actions": [{"addChatItemAction": {"item": {
            "liveChatTextMessageRenderer": {"message": {"runs": [{"text": "LOL!!!"}, {"emoji": {"shortcuts": [":joy:"]}}]}}}}}],
            "videoOffsetTimeMsec": str(300000 + k * 500)}})
    f = tmp_path / "chat.live_chat.json"
    f.write_text("\n".join(json.dumps(x) for x in lines) + "\n{kaputt")
    msgs = signals.load_chat_file(f)
    assert len(msgs) == 70 and msgs[-1]["emote"]
    curve = signals.chat_curve(signals.resolve_times(msgs), 600)
    assert signals.curve_score(curve, 290, 330) > 0.8 > signals.curve_score(curve, 60, 100)


def test_twitch_rechat_and_irc_formats(tmp_path):
    f = tmp_path / "chat.rechat.json"
    f.write_text(json.dumps({"comments": [{"content_offset_seconds": 12.5, "message": {"body": "KEKW", "emoticons": [1]}}]}))
    assert signals.load_chat_file(f)[0]["t"] == 12.5
    g = tmp_path / "chat_irc.jsonl"
    g.write_text(json.dumps({"epoch": 1000.0, "text": "hi", "emote": False}) + "\n")
    ev = signals.resolve_times(signals.load_chat_file(g), [{"epoch": 990.0, "base": 600.0}])
    assert ev == [(610.0, 1.0)]


# ------------------------------------------------------------------ Analyse
def words_from(text_by_sentence, sec_per_word=0.4):
    words, t = [], 0.0
    for sent in text_by_sentence:
        for w in sent.split():
            words.append({"w": w, "s": round(t, 2), "e": round(t + sec_per_word - 0.05, 2)})
            t += sec_per_word
        t += 0.3
    return words


SENTS = [f"This is sentence number {i} with a few extra words." for i in range(40)]


def test_sentences_split_on_punctuation():
    s = analyze.sentences(words_from(SENTS))
    assert len(s) == 40 and s[0]["text"].endswith("words.")


def test_snap_respects_duration_and_boundaries():
    s = analyze.sentences(words_from(SENTS))  # ~4.3 s pro Satz
    a, b = analyze.snap(s, 3, 3, 20, 60)  # zu kurz -> wird verlängert
    assert 20 <= b - a <= 61
    a, b = analyze.snap(s, 0, 39, 20, 60)  # zu lang -> wird gekürzt
    assert b - a <= 61
    assert any(abs(x["s"] - 0.1 - a) < 0.2 or x["s"] == 0 for x in s)


def test_find_candidates_scoring(monkeypatch):
    monkeypatch.setattr(llm, "complete", lambda p: '```json\n{"clips":[{"start_id":2,"end_id":8,"hook":90,'
                                                   '"tension":80,"clarity":100,"title":"T","description":"D","reason":"R"}]}\n```')
    words = words_from(SENTS)
    c = analyze.find_candidates(words, "Titel", None, min_start=0)[0]
    assert c["ai_score"] == 90 and c["score"] == 90 and c["signal_score"] is None
    curve = [[0, 1000, 0.5]]
    c = analyze.find_candidates(words, "Titel", curve, min_start=0)[0]
    assert c["signal_score"] == 50 and c["score"] == 70
    assert analyze.find_candidates(words, "Titel", None, min_start=10_000) == []


def test_overlaps():
    assert analyze.overlaps((0, 30), (10, 40))
    assert not analyze.overlaps((0, 30), (25, 60))


# ------------------------------------------------------------------ LLM
def test_ollama_backend_with_fake_server(monkeypatch):
    class H(BaseHTTPRequestHandler):
        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            assert body["format"] == "json" and body["model"] == "testmodel"
            out = json.dumps({"message": {"content": '{"clips": []}'}}).encode()
            self.send_response(200); self.send_header("Content-Length", str(len(out))); self.end_headers()
            self.wfile.write(out)

        def log_message(self, *a):
            pass
    srv = HTTPServer(("127.0.0.1", 0), H)
    threading.Thread(target=srv.handle_request, daemon=True).start()
    monkeypatch.setitem(CFG["llm"], "backend", "ollama")
    monkeypatch.setitem(CFG["llm"], "ollama_model", "testmodel")
    monkeypatch.setitem(CFG["llm"], "ollama_url", f"http://127.0.0.1:{srv.server_port}")
    assert llm.extract_json(llm.complete("x")) == {"clips": []}


def test_extract_json_ignores_trailing_text():
    assert llm.extract_json('Hier: {"clips": [{"a": 1}]}\n\n{"noch": "was"} Ende }') == {"clips": [{"a": 1}]}


def test_api_backend_requires_env_key(monkeypatch):
    monkeypatch.setitem(CFG["llm"], "backend", "anthropic_api")
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    try:
        llm.complete("x")
    except llm.LLMError as e:
        assert "ANTHROPIC_API_KEY" in str(e)
    else:
        raise AssertionError


# ------------------------------------------------------------------ Rendern
def test_ass_highlights_words_relative_to_clip():
    words = [{"w": "Hallo", "s": 10.0, "e": 10.4}, {"w": "Welt!", "s": 10.5, "e": 11.0}, {"w": "Weiter", "s": 11.2, "e": 11.6}]
    ass = render.build_ass(words, 10.0, 12.0)
    assert "PlayResX: 1080" in ass and "PlayResY: 1920" in ass
    assert "Dialogue: 0,0:00:00.00,0:00:00.50,Default,,0,0,0,,{\\c&H0000E5FF&}HALLO{\\r} WELT!" in ass
    assert ass.count("Dialogue:") == 3


def test_crop_filter_centers_on_face():
    f = render.video_filter(1920, 1080, 0.8, "x.ass")
    assert "crop=606:1080:1233:0" in f and "scale=1080:1920" in f
    f = render.video_filter(1920, 1080, 0.99, "x.ass")
    assert "crop=606:1080:1314:0" in f  # am Rand begrenzt
