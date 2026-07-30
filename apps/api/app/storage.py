"""数据层（方案 3 数据层）：SQLite + 文件目录，零运维。

实体以 JSON 行存储：kind + id + json + created_at。
正式版可迁移 PostgreSQL + 对象存储。
"""
from __future__ import annotations

import json
import sqlite3
import threading
from datetime import datetime, timezone
from pathlib import Path

from app import config

_LOCK = threading.Lock()
_DB_PATH = Path(str(config.DATABASE_URL).replace("sqlite:///", ""))
_DB_PATH.parent.mkdir(parents=True, exist_ok=True)


def _conn() -> sqlite3.Connection:
    conn = sqlite3.connect(_DB_PATH, check_same_thread=False)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS entities (
            kind TEXT NOT NULL,
            id TEXT NOT NULL,
            json TEXT NOT NULL,
            created_at TEXT NOT NULL,
            PRIMARY KEY (kind, id)
        )""")
    return conn


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def put(kind: str, entity_id: str, data: dict) -> None:
    with _LOCK, _conn() as conn:
        conn.execute(
            "INSERT OR REPLACE INTO entities (kind, id, json, created_at)"
            " VALUES (?, ?, ?, ?)",
            (kind, entity_id, json.dumps(data, ensure_ascii=False), _now()))


def get(kind: str, entity_id: str) -> dict | None:
    with _LOCK, _conn() as conn:
        row = conn.execute(
            "SELECT json FROM entities WHERE kind=? AND id=?",
            (kind, entity_id)).fetchone()
    return json.loads(row[0]) if row else None


def list_kind(kind: str) -> list[dict]:
    with _LOCK, _conn() as conn:
        rows = conn.execute(
            "SELECT json FROM entities WHERE kind=? ORDER BY created_at",
            (kind,)).fetchall()
    return [json.loads(r[0]) for r in rows]
