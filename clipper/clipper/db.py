"""SQLite-Speicher für Jobs, Abschnitte (Chunks) und Clips."""
from __future__ import annotations

import json
import sqlite3
import threading
import time
from pathlib import Path

from .config import DATA_DIR

_lock = threading.RLock()
_conn = sqlite3.connect(DATA_DIR / "clipper.db", check_same_thread=False, isolation_level=None)
_conn.row_factory = sqlite3.Row
_conn.execute("PRAGMA journal_mode=WAL")

SCHEMA = """
CREATE TABLE IF NOT EXISTS jobs(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  url TEXT NOT NULL,
  mode TEXT DEFAULT 'auto',          -- vom Nutzer gewählt: auto | video | live
  kind TEXT DEFAULT '',              -- erkannt: video | live
  status TEXT DEFAULT 'queued',      -- queued downloading processing ready recording stopping done error
  stage TEXT DEFAULT '',             -- transcribing analyzing rendering (während processing/recording)
  progress REAL DEFAULT 0,
  message TEXT DEFAULT '',
  title TEXT DEFAULT '',
  duration REAL DEFAULT 0,
  signal_type TEXT DEFAULT '',       -- heatmap | chat | ''
  meta TEXT DEFAULT '{}',
  created_at REAL, updated_at REAL
);
CREATE TABLE IF NOT EXISTS chunks(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL,
  idx INTEGER NOT NULL,
  start REAL NOT NULL, end REAL NOT NULL,
  media TEXT DEFAULT '',             -- Datei, aus der transkribiert wird
  media_offset REAL DEFAULT 0,       -- absolute Zeit, die Sekunde 0 der Datei entspricht
  status TEXT DEFAULT 'pending',     -- pending transcribed analyzed done error
  error TEXT DEFAULT '',
  UNIQUE(job_id, idx)
);
CREATE TABLE IF NOT EXISTS clips(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL,
  chunk_idx INTEGER,
  start REAL, end REAL,
  title TEXT, description TEXT, hook TEXT, reason TEXT,
  ai_score REAL, signal_score REAL, score REAL,
  status TEXT,                       -- below render review posting posted discarded error
  file TEXT DEFAULT '',
  error TEXT DEFAULT '',
  publish TEXT DEFAULT '{}',
  created_at REAL
);
"""
_conn.executescript(SCHEMA)


def q(sql: str, args: tuple = ()) -> list[dict]:
    with _lock:
        return [dict(r) for r in _conn.execute(sql, args).fetchall()]


def one(sql: str, args: tuple = ()) -> dict | None:
    rows = q(sql, args)
    return rows[0] if rows else None


def ex(sql: str, args: tuple = ()) -> int:
    with _lock:
        return _conn.execute(sql, args).lastrowid


def update(table: str, row_id: int, **fields) -> None:
    if table == "jobs":
        fields["updated_at"] = time.time()
    for k, v in list(fields.items()):
        if isinstance(v, (dict, list)):
            fields[k] = json.dumps(v)
    cols = ", ".join(f"{k}=?" for k in fields)
    ex(f"UPDATE {table} SET {cols} WHERE id=?", (*fields.values(), row_id))


def job(job_id: int) -> dict | None:
    return one("SELECT * FROM jobs WHERE id=?", (job_id,))


def job_meta(j: dict) -> dict:
    return json.loads(j.get("meta") or "{}")


def set_meta(job_id: int, **kv) -> dict:
    with _lock:
        j = job(job_id)
        meta = job_meta(j)
        meta.update(kv)
        update("jobs", job_id, meta=meta)
        return meta


def job_dir(job_id: int) -> Path:
    d = DATA_DIR / "jobs" / str(job_id)
    d.mkdir(parents=True, exist_ok=True)
    return d
