"""Persistent analysis-job service backed by an in-process worker.

The database is the source of truth. The executor is deliberately replaceable by a
queue worker later without changing API contracts.
"""
from __future__ import annotations

import json
import hashlib
import logging
import threading
import uuid
from concurrent.futures import Future, ThreadPoolExecutor
from datetime import datetime, timezone

from sqlalchemy.exc import IntegrityError

from app import storage
from app.db import repositories
from app.schemas.models import DiagnosisReport, PerformanceEvent, ScoreBundle
from app.services.diagnosis.pipeline import (LowConfidenceAlignmentError,
                                             run_analysis)

logger = logging.getLogger(__name__)
_executor: ThreadPoolExecutor | None = None
_futures: dict[str, Future[None]] = {}
_lock = threading.Lock()


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def create_or_get_job(session_id: str) -> dict:
    existing = repositories.get_job_for_session(session_id)
    if existing:
        return existing
    job_id = f"job_{uuid.uuid4().hex[:12]}"
    try:
        repositories.save_job(job_id, {
            "sessionId": session_id, "status": "queued", "progress": 0, "attempts": 0,
        })
    except IntegrityError:
        raced = repositories.get_job_for_session(session_id)
        if raced:
            return raced
        raise
    session = storage.get("session", session_id)
    if session:
        session["jobId"] = job_id
        session["status"] = "queued"
        storage.put("session", session_id, session)
    return repositories.get_job(job_id) or {"analysisJobId": job_id, "status": "queued"}


def enqueue(job_id: str) -> None:
    global _executor
    with _lock:
        existing = _futures.get(job_id)
        if existing and not existing.done():
            return
        if _executor is None:
            _executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="analysis-worker")
        _futures[job_id] = _executor.submit(_run_job, job_id)


def _run_job(job_id: str) -> None:
    job = repositories.get_job(job_id)
    if not job or job["status"] == "completed":
        return
    session_id = job["sessionId"]
    repositories.save_job(job_id, {
        **job, "sessionId": session_id, "status": "running", "progress": 10,
        "attempts": int(job.get("attempts") or 0) + 1,
    })
    logger.info(json.dumps({"event": "analysis_job_started", "jobId": job_id,
                            "sessionId": session_id}, ensure_ascii=False))
    try:
        session = storage.get("session", session_id)
        if not session:
            raise RuntimeError("SESSION_NOT_FOUND")
        score = storage.get("score", session["scoreId"])
        if not score:
            raise RuntimeError("SCORE_NOT_FOUND")
        raw_events = repositories.get_session_events(session_id)
        events = [PerformanceEvent.model_validate(event) for event in raw_events]
        if not events:
            raise RuntimeError("NO_PERFORMANCE_EVENTS")
        report_id = f"rep_{uuid.uuid4().hex[:12]}"
        report = run_analysis(
            ScoreBundle.model_validate(score["bundle"]), events, report_id, session_id,
            range_start=session["rangeStart"], range_end=session["rangeEnd"],
            created_at=_now(),
        )
        event_digest = hashlib.sha256(json.dumps(
            raw_events, sort_keys=True, separators=(",", ":"), ensure_ascii=False,
        ).encode()).hexdigest()
        report = DiagnosisReport.model_validate({
            **report.model_dump(),
            "sourceReferences": [*score.get("sourceReferences", []), {
                "artifactId": f"events:{session_id}", "kind": "performance-event-batches",
                "sha256": event_digest, "originalName": "",
            }],
        })
        repositories.save_report(report_id, report.model_dump())
        repositories.save_job(job_id, {
            "sessionId": session_id, "status": "completed", "progress": 100,
            "reportId": report_id, "attempts": int(job.get("attempts") or 0) + 1,
        })
        session["status"] = "completed"
        session["reportId"] = report_id
        session["jobId"] = job_id
        storage.put("session", session_id, session)
        logger.info(json.dumps({"event": "analysis_job_completed", "jobId": job_id,
                                "sessionId": session_id, "reportId": report_id},
                               ensure_ascii=False))
    except Exception as exc:  # Persist failures; never strand the UI in "running".
        if isinstance(exc, LowConfidenceAlignmentError):
            code = "ALIGNMENT_LOW_CONFIDENCE"
            message = str(exc)
        else:
            code = str(exc) if str(exc) in {
                "SESSION_NOT_FOUND", "SCORE_NOT_FOUND", "NO_PERFORMANCE_EVENTS",
            } else "ANALYSIS_FAILED"
            message = ("没有演奏事件，请重录" if code == "NO_PERFORMANCE_EVENTS" else
                       "分析失败，录音已保留，可重新提交")
        repositories.save_job(job_id, {
            "sessionId": session_id, "status": "failed", "progress": 100,
            "errorCode": code, "errorMessage": message,
            "attempts": int(job.get("attempts") or 0) + 1,
        })
        session = storage.get("session", session_id)
        if session:
            session["status"] = "failed"
            storage.put("session", session_id, session)
        logger.exception(json.dumps({"event": "analysis_job_failed", "jobId": job_id,
                                     "sessionId": session_id, "errorCode": code},
                                    ensure_ascii=False))


def resume_pending_jobs() -> None:
    """Resume queued work and retry jobs interrupted by a process restart."""
    for job in repositories.list_jobs_by_status(["queued", "running"]):
        if job["status"] == "running":
            repositories.save_job(job["analysisJobId"], {
                **job, "status": "queued", "progress": 0,
            })
        enqueue(job["analysisJobId"])


def shutdown() -> None:
    global _executor
    with _lock:
        if _executor is not None:
            _executor.shutdown(wait=False, cancel_futures=False)
            _executor = None
