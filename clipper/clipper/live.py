"""Livestreams segmentweise mitschneiden. Jedes fertige Segment wird sofort zu einem Abschnitt (Chunk),
den der Verarbeitungs-Worker direkt transkribiert, analysiert und schneidet."""
from __future__ import annotations

import json
import os
import re
import signal
import socket
import subprocess
import threading
import time
from pathlib import Path

from . import db
from .config import CFG
from .download import ytdlp_cli

RECORDERS: dict[int, "LiveRecorder"] = {}


def _killpg(p: subprocess.Popen, sig: int) -> None:
    try:
        os.killpg(p.pid, sig)
    except (ProcessLookupError, PermissionError):
        pass


class TwitchChat(threading.Thread):
    """Anonymer, kostenloser Twitch-IRC-Mitschnitt (nur lesen)."""

    def __init__(self, channel: str, out: Path):
        super().__init__(daemon=True)
        self.channel, self.out, self.stop_evt = channel.lower(), out, threading.Event()

    def run(self) -> None:
        try:
            s = socket.create_connection(("irc.chat.twitch.tv", 6667), timeout=10)
            s.settimeout(2)
            for line in ("CAP REQ :twitch.tv/tags", "PASS SCHMOOPIIE", f"NICK justinfan{int(time.time()) % 99999}",
                         f"JOIN #{self.channel}"):
                s.sendall((line + "\r\n").encode())
            buf = ""
            with open(self.out, "a", encoding="utf-8") as f:
                while not self.stop_evt.is_set():
                    try:
                        data = s.recv(65536).decode("utf-8", "ignore")
                    except socket.timeout:
                        continue
                    if not data:
                        break
                    buf += data
                    *lines, buf = buf.split("\r\n")
                    for line in lines:
                        if line.startswith("PING"):
                            s.sendall(b"PONG :tmi.twitch.tv\r\n")
                        elif " PRIVMSG " in line:
                            tags = line.split(" ", 1)[0] if line.startswith("@") else ""
                            text = line.split(" PRIVMSG ", 1)[1].split(" :", 1)[-1]
                            emote = bool(re.search(r"(^|;)emotes=[^;]+", tags))
                            f.write(json.dumps({"epoch": time.time(), "text": text, "emote": emote}) + "\n")
                    f.flush()
            s.close()
        except OSError:
            pass


class LiveRecorder(threading.Thread):
    def __init__(self, job_id: int):
        super().__init__(daemon=True)
        self.job_id = job_id
        self.stop_evt = threading.Event()

    def stop(self) -> None:
        self.stop_evt.set()

    # ------------------------------------------------------------------
    def run(self) -> None:
        jid = self.job_id
        try:
            self._record()
        except Exception as e:  # noqa: BLE001
            db.update("jobs", jid, status="processing", message=f"Aufnahme beendet mit Fehler: {e}")
        finally:
            RECORDERS.pop(jid, None)
            j = db.job(jid)
            if j and j["status"] in ("recording", "stopping"):
                db.update("jobs", jid, status="processing", message="Aufnahme beendet – restliche Segmente werden verarbeitet.")

    def _record(self) -> None:
        jid = self.job_id
        j = db.job(jid)
        meta = db.job_meta(j)
        wd = db.job_dir(jid) / "live"
        wd.mkdir(exist_ok=True)
        chunks = db.q("SELECT * FROM chunks WHERE job_id=? ORDER BY idx", (jid,))
        base = chunks[-1]["end"] if chunks else 0.0
        next_idx = (chunks[-1]["idx"] + 1) if chunks else 0
        info = json.loads((db.job_dir(jid) / "info.json").read_text()) if (db.job_dir(jid) / "info.json").exists() else {}
        from_start = bool(CFG["live"]["from_start"]) and not chunks
        epoch = time.time()
        if from_start and info.get("release_timestamp"):
            epoch = float(info["release_timestamp"])
        sessions = meta.get("sessions", []) + [{"epoch": epoch, "base": base}]
        n = len(sessions)
        db.set_meta(jid, sessions=sessions, strategy="live")
        seg_list = wd / f"segments_{n}.csv"
        seg_len = max(10, int(float(CFG["live"]["segment_minutes"]) * 60))

        h = int(CFG["download"]["max_height"])
        cmd1 = ytdlp_cli() + ["-q", "--no-part", "--hls-use-mpegts", "-f", f"b[height<={h}]/b", "-o", "-", j["url"]]
        if from_start:
            cmd1.insert(-1, "--live-from-start")
        cmd2 = ["ffmpeg", "-v", "error", "-nostdin", "-i", "pipe:0", "-map", "0:v?", "-map", "0:a?", "-c", "copy",
                "-f", "segment", "-segment_time", str(seg_len), "-reset_timestamps", "1",
                "-segment_list", str(seg_list), "-segment_list_type", "csv",
                "-segment_start_number", str(next_idx), str(wd / "seg_%05d.ts")]
        log = open(wd / f"record_{n}.log", "ab")
        p1 = subprocess.Popen(cmd1, stdout=subprocess.PIPE, stderr=log, start_new_session=True)
        p2 = subprocess.Popen(cmd2, stdin=p1.stdout, stderr=log, start_new_session=True)
        p1.stdout.close()
        chat = self._start_chat(j, info, wd, n)
        db.update("jobs", jid, status="recording", stage="", message="Aufnahme läuft …")

        cursor = {"seen": 0, "t": base}
        while True:
            self._poll(seg_list, cursor, next_idx, wd)
            if self.stop_evt.is_set():
                db.update("jobs", jid, status="stopping", message="Aufnahme wird beendet …")
                _killpg(p1, signal.SIGINT)
                try:
                    p1.wait(15)
                except subprocess.TimeoutExpired:
                    _killpg(p1, signal.SIGKILL)
                try:
                    p2.wait(30)
                except subprocess.TimeoutExpired:
                    _killpg(p2, signal.SIGINT)
                    p2.wait(10)
                break
            if p2.poll() is not None:
                p1.poll() is None and _killpg(p1, signal.SIGTERM)
                break
            time.sleep(2)
        self._poll(seg_list, cursor, next_idx, wd)
        if chat:
            chat()
        log.close()
        if cursor["seen"] == 0 and not self.stop_evt.is_set():
            tail = (wd / f"record_{n}.log").read_text(errors="ignore")[-400:]
            raise RuntimeError(f"Keine Segmente aufgenommen. {tail}")

    def _poll(self, seg_list: Path, cursor: dict, first_idx: int, wd: Path) -> None:
        if not seg_list.exists():
            return
        rows = [r.split(",") for r in seg_list.read_text().splitlines() if r.strip()]
        for i in range(cursor["seen"], len(rows)):
            name, s, e = rows[i][0], float(rows[i][1]), float(rows[i][2])
            dur = max(0.0, e - s)
            start = cursor["t"]
            db.ex("INSERT OR IGNORE INTO chunks(job_id, idx, start, end, media, media_offset) VALUES(?,?,?,?,?,?)",
                  (self.job_id, first_idx + i, start, start + dur, str(wd / name), start))
            cursor["t"] = start + dur
            cursor["seen"] = i + 1
        if rows:
            done = cursor["t"]
            db.update("jobs", self.job_id, duration=done,
                      message=f"Aufnahme läuft – {len(rows)} Segment(e) fertig ({int(done // 60)} min)")

    def _start_chat(self, j: dict, info: dict, wd: Path, n: int):
        if not CFG["live"]["chat"]:
            return None
        extractor = (info.get("extractor_key") or "").lower()
        if "twitch" in extractor:
            channel = info.get("uploader_id") or j["url"].rstrip("/").split("/")[-1]
            t = TwitchChat(channel, wd / "chat_irc.jsonl")
            t.start()
            db.update("jobs", self.job_id, signal_type="chat")
            return t.stop_evt.set
        if "youtube" in extractor:
            p = subprocess.Popen(ytdlp_cli() + ["-q", "--skip-download", "--write-subs", "--sub-langs", "live_chat",
                                                "--no-part", "-o", str(wd / f"chat{n}"), j["url"]],
                                 stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
            db.update("jobs", self.job_id, signal_type="chat")
            return lambda: _killpg(p, signal.SIGINT)
        return None


def live_chat_files(job_id: int) -> list[Path]:
    wd = db.job_dir(job_id) / "live"
    return sorted(wd.glob("chat*.live_chat.json")) + sorted(wd.glob("chat_irc.jsonl"))


def start(job_id: int) -> None:
    if job_id in RECORDERS:
        return
    rec = LiveRecorder(job_id)
    RECORDERS[job_id] = rec
    rec.start()


def stop(job_id: int) -> None:
    rec = RECORDERS.get(job_id)
    if rec:
        rec.stop()


def stop_all() -> None:
    for rec in list(RECORDERS.values()):
        rec.stop()
    for rec in list(RECORDERS.values()):
        rec.join(60)
