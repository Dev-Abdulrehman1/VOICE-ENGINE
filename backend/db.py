"""Tiny SQLite history store for generated audio (stdlib only, no ORM)."""

import os
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterator, List, Optional

# DATA_DIR is read from the environment; main.py loads .env before importing this.
# Vercel Functions have a read-only filesystem apart from /tmp, so fall back there.
DEFAULT_DATA_DIR = "/tmp/voice-engine" if os.getenv("VERCEL") else "data"
DATA_DIR = Path(os.getenv("DATA_DIR") or DEFAULT_DATA_DIR)
AUDIO_DIR = DATA_DIR / "audio"
DB_PATH = DATA_DIR / "history.db"

SCHEMA = """
CREATE TABLE IF NOT EXISTS generations (
    id           TEXT PRIMARY KEY,
    text         TEXT NOT NULL,
    model        TEXT NOT NULL,
    voice        TEXT,
    instructions TEXT,
    format       TEXT NOT NULL DEFAULT 'mp3',
    file_name    TEXT,
    byte_size    INTEGER,
    duration_ms  INTEGER,
    provider_id  TEXT,
    status       TEXT NOT NULL,
    error        TEXT,
    created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_generations_created_at
    ON generations (created_at DESC);
"""


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


@contextmanager
def _db() -> Iterator[sqlite3.Connection]:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    AUDIO_DIR.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH, timeout=10)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def init_db() -> None:
    """Create the data directory and tables if they do not exist yet."""
    with _db() as conn:
        conn.executescript(SCHEMA)


def audio_path(file_name: str) -> Path:
    return AUDIO_DIR / file_name


def create_generation(
    gen_id: str,
    text: str,
    model: str,
    voice: Optional[str] = None,
    instructions: Optional[str] = None,
    audio_format: str = "mp3",
) -> Dict[str, Any]:
    with _db() as conn:
        conn.execute(
            """
            INSERT INTO generations
                (id, text, model, voice, instructions, format, status, created_at)
            VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)
            """,
            (gen_id, text, model, voice, instructions, audio_format, _now()),
        )
    record = get_generation(gen_id)
    assert record is not None
    return record


def finish_generation(
    gen_id: str,
    file_name: str,
    byte_size: int,
    duration_ms: int,
    provider_id: Optional[str] = None,
) -> Optional[Dict[str, Any]]:
    with _db() as conn:
        conn.execute(
            """
            UPDATE generations
               SET status = 'ready', file_name = ?, byte_size = ?,
                   duration_ms = ?, provider_id = ?, error = NULL
             WHERE id = ?
            """,
            (file_name, byte_size, duration_ms, provider_id, gen_id),
        )
    return get_generation(gen_id)


def fail_generation(gen_id: str, error: str) -> Optional[Dict[str, Any]]:
    with _db() as conn:
        conn.execute(
            "UPDATE generations SET status = 'failed', error = ? WHERE id = ?",
            (error[:500], gen_id),
        )
    return get_generation(gen_id)


def get_generation(gen_id: str) -> Optional[Dict[str, Any]]:
    with _db() as conn:
        row = conn.execute("SELECT * FROM generations WHERE id = ?", (gen_id,)).fetchone()
        return dict(row) if row else None


def list_generations(limit: int = 50, offset: int = 0) -> List[Dict[str, Any]]:
    with _db() as conn:
        rows = conn.execute(
            """
            SELECT * FROM generations
             ORDER BY created_at DESC, rowid DESC
             LIMIT ? OFFSET ?
            """,
            (limit, offset),
        ).fetchall()
        return [dict(row) for row in rows]


def count_generations() -> int:
    with _db() as conn:
        row = conn.execute("SELECT COUNT(*) AS n FROM generations").fetchone()
        return int(row["n"])


def delete_generation(gen_id: str) -> bool:
    with _db() as conn:
        cursor = conn.execute("DELETE FROM generations WHERE id = ?", (gen_id,))
        deleted = cursor.rowcount > 0
    return bool(deleted)
