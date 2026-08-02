"""Compatibility facade over typed SQLAlchemy repositories.

The deterministic services and a few legacy routes still use ``put/get``. Keeping
that tiny surface lets the v2 migration remain incremental without falling back to
a generic entities table.
"""
from __future__ import annotations

from typing import Any

from app.db import repositories
from app.db.session import initialize_database

_initialized = False


def _ready() -> None:
    global _initialized
    if not _initialized:
        initialize_database()
        _initialized = True


def put(kind: str, entity_id: str, data: dict[str, Any]) -> None:
    _ready()
    if kind == "score":
        repositories.save_score(entity_id, data)
    elif kind == "session":
        repositories.save_session(entity_id, data)
    elif kind == "job":
        payload = {**data, "sessionId": data.get("sessionId", "")}
        if not payload["sessionId"]:
            # Compatibility for old completed-job writes; infer from report when possible.
            report = repositories.get_report(data.get("reportId", ""))
            payload["sessionId"] = report.get("sessionId", "") if report else ""
        if not payload["sessionId"]:
            raise ValueError("analysis job requires sessionId")
        repositories.save_job(entity_id, payload)
    elif kind == "report":
        repositories.save_report(entity_id, data)
    elif kind == "exercise":
        repositories.save_exercise(entity_id, data)
    else:
        repositories.save_generated(kind, entity_id, data)


def get(kind: str, entity_id: str) -> dict[str, Any] | None:
    _ready()
    if kind == "score":
        return repositories.get_score(entity_id)
    if kind == "session":
        return repositories.get_session(entity_id)
    if kind == "job":
        return repositories.get_job(entity_id)
    if kind == "report":
        return repositories.get_report(entity_id)
    if kind == "exercise":
        return repositories.get_exercise(entity_id)
    return repositories.get_generated(kind, entity_id)


def list_kind(kind: str) -> list[dict[str, Any]]:
    _ready()
    if kind == "score":
        return repositories.list_scores()
    return repositories.list_generated(kind)
