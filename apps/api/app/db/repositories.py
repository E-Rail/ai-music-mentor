"""Small repository layer used by services and the legacy storage facade."""
from __future__ import annotations

import hashlib
import json
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Iterable

from sqlalchemy import delete, func, select
from sqlalchemy.exc import IntegrityError

from app import config
from app.db.models import (AnalysisJobRecord, ArtifactRecord, ComparisonRecord,
                           DiagnosisReportRecord, EventBatchRecord,
                           ExerciseRecord, GeneratedItemRecord,
                           LocalProfileRecord, MentorInteractionRecord,
                           MentorMemoryRecord,
                           PracticeSessionRecord, ScoreRecord)
from app.db.session import session_scope


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _iso(value: datetime | None) -> str | None:
    return value.isoformat() if value else None


def ensure_local_profile() -> None:
    with session_scope() as db:
        if not db.get(LocalProfileRecord, config.LOCAL_PROFILE_ID):
            db.add(LocalProfileRecord(id=config.LOCAL_PROFILE_ID))


def save_artifact(data: dict[str, Any]) -> None:
    with session_scope() as db:
        record = db.get(ArtifactRecord, data["id"])
        if record is None:
            record = ArtifactRecord(id=data["id"], profile_id=data.get("profileId", config.LOCAL_PROFILE_ID),
                                    kind=data["kind"], storage_key=data["storageKey"],
                                    original_name=data.get("originalName", ""),
                                    media_type=data.get("mediaType", "application/octet-stream"),
                                    sha256=data["sha256"], size_bytes=data["sizeBytes"],
                                    generated=data.get("generated", False),
                                    expires_at=data.get("expiresAt"))
            db.add(record)


def get_artifact(artifact_id: str) -> dict[str, Any] | None:
    with session_scope() as db:
        row = db.get(ArtifactRecord, artifact_id)
        if not row:
            return None
        return {
            "id": row.id, "profileId": row.profile_id, "kind": row.kind,
            "storageKey": row.storage_key, "originalName": row.original_name,
            "mediaType": row.media_type, "sha256": row.sha256,
            "sizeBytes": row.size_bytes, "generated": row.generated,
            "expiresAt": _iso(row.expires_at), "createdAt": _iso(row.created_at),
        }


def save_score(score_id: str, data: dict[str, Any]) -> None:
    bundle = data["bundle"]
    meta = bundle["meta"]
    with session_scope() as db:
        row = db.get(ScoreRecord, score_id)
        if row is None:
            row = ScoreRecord(
                id=score_id, profile_id=data.get("profileId", config.LOCAL_PROFILE_ID),
                source_type=data.get("sourceType", "musicxml"),
                source_name=data.get("sourceName", ""),
                display_mode=data.get("displayMode", "exact_notation"),
                title=meta.get("title", score_id), composer=meta.get("composer", ""),
                score_hash=meta.get("scoreHash", ""), confidence=data.get("confidence", 1.0),
                builtin=data.get("builtin", False),
                source_artifact_id=data.get("sourceArtifactId"),
                render_artifact_id=data.get("renderArtifactId"),
                payload=data, warnings=data.get("warnings", []),
                normalization=data.get("normalization", {}),
            )
            db.add(row)
        else:
            row.source_type = data.get("sourceType", row.source_type)
            row.source_name = data.get("sourceName", row.source_name)
            row.display_mode = data.get("displayMode", row.display_mode)
            row.title = meta.get("title", row.title)
            row.composer = meta.get("composer", row.composer)
            row.score_hash = meta.get("scoreHash", row.score_hash)
            row.confidence = data.get("confidence", row.confidence)
            row.builtin = data.get("builtin", row.builtin)
            row.source_artifact_id = data.get("sourceArtifactId", row.source_artifact_id)
            row.render_artifact_id = data.get("renderArtifactId", row.render_artifact_id)
            row.payload = data
            row.warnings = data.get("warnings", [])
            row.normalization = data.get("normalization", {})


def get_score(score_id: str) -> dict[str, Any] | None:
    with session_scope() as db:
        row = db.get(ScoreRecord, score_id)
        return dict(row.payload) if row else None


def list_scores() -> list[dict[str, Any]]:
    with session_scope() as db:
        rows = db.scalars(select(ScoreRecord).order_by(ScoreRecord.created_at)).all()
        return [dict(row.payload) for row in rows]


def save_session(session_id: str, data: dict[str, Any]) -> None:
    with session_scope() as db:
        row = db.get(PracticeSessionRecord, session_id)
        if row is None:
            row = PracticeSessionRecord(
                id=session_id, profile_id=data.get("profileId", config.LOCAL_PROFILE_ID),
                score_id=data["scoreId"], range_start=data["rangeStart"],
                range_end=data["rangeEnd"], device=data.get("device", "web-midi"),
                status=data.get("status", "recording"), payload=data,
                job_id=data.get("jobId"), report_id=data.get("reportId"),
            )
            db.add(row)
        else:
            row.status = data.get("status", row.status)
            row.device = data.get("device", row.device)
            row.payload = data
            row.job_id = data.get("jobId", row.job_id)
            row.report_id = data.get("reportId", row.report_id)
            if row.status in {"completed", "analyzed", "failed", "discarded"}:
                row.finished_at = row.finished_at or _utcnow()


def get_session(session_id: str) -> dict[str, Any] | None:
    with session_scope() as db:
        row = db.get(PracticeSessionRecord, session_id)
        return dict(row.payload) if row else None


def append_event_batch(session_id: str, batch_id: str, sequence_no: int,
                       events: list[dict[str, Any]]) -> dict[str, Any]:
    canonical = json.dumps(events, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    checksum = hashlib.sha256(canonical.encode()).hexdigest()
    with session_scope() as db:
        existing = db.scalar(select(EventBatchRecord).where(
            EventBatchRecord.session_id == session_id,
            EventBatchRecord.batch_id == batch_id,
        ))
        if existing:
            if existing.checksum != checksum:
                raise ValueError("BATCH_ID_CONFLICT")
            created = False
        else:
            db.add(EventBatchRecord(
                session_id=session_id, batch_id=batch_id, sequence_no=sequence_no,
                checksum=checksum, event_count=len(events), payload=events,
            ))
            created = True
            try:
                db.flush()
            except IntegrityError:
                db.rollback()
                existing = db.scalar(select(EventBatchRecord).where(
                    EventBatchRecord.session_id == session_id,
                    EventBatchRecord.batch_id == batch_id,
                ))
                if not existing or existing.checksum != checksum:
                    raise ValueError("BATCH_ID_CONFLICT")
                created = False
        total = db.scalar(select(func.sum(EventBatchRecord.event_count)).where(
            EventBatchRecord.session_id == session_id)) or 0
        return {"batchId": batch_id, "accepted": created, "storedEventCount": int(total)}


def get_session_events(session_id: str) -> list[dict[str, Any]]:
    with session_scope() as db:
        batches = db.scalars(select(EventBatchRecord).where(
            EventBatchRecord.session_id == session_id,
        ).order_by(EventBatchRecord.sequence_no, EventBatchRecord.id)).all()
    # Final submissions may overlap mirrored batches. Event ids are stable idempotency keys.
    by_id: dict[str, dict[str, Any]] = {}
    for batch in batches:
        for event in batch.payload:
            by_id.setdefault(str(event["id"]), event)
    return sorted(by_id.values(), key=lambda e: (e.get("tOnMs", 0), e.get("pitch", 0), e["id"]))


def save_job(job_id: str, data: dict[str, Any]) -> None:
    with session_scope() as db:
        row = db.get(AnalysisJobRecord, job_id)
        if row is None:
            row = AnalysisJobRecord(id=job_id, session_id=data["sessionId"])
            db.add(row)
        row.status = data.get("status", row.status)
        row.progress = data.get("progress", row.progress)
        row.report_id = data.get("reportId", row.report_id)
        row.error_code = data.get("errorCode", row.error_code)
        row.error_message = data.get("errorMessage", row.error_message)
        row.attempts = data.get("attempts", row.attempts)
        if row.status == "queued":
            row.started_at = None
            row.completed_at = None
        if row.status == "running" and row.started_at is None:
            row.started_at = _utcnow()
        if row.status in {"completed", "failed"}:
            row.completed_at = _utcnow()


def get_job(job_id: str) -> dict[str, Any] | None:
    with session_scope() as db:
        row = db.get(AnalysisJobRecord, job_id)
        if not row:
            return None
        return {
            "id": row.id, "analysisJobId": row.id, "sessionId": row.session_id,
            "status": row.status, "progress": row.progress, "reportId": row.report_id,
            "errorCode": row.error_code if row.status == "failed" else None,
            "errorMessage": row.error_message if row.status == "failed" else None,
            "attempts": row.attempts, "createdAt": _iso(row.created_at),
            "startedAt": _iso(row.started_at), "completedAt": _iso(row.completed_at),
        }


def get_job_for_session(session_id: str) -> dict[str, Any] | None:
    with session_scope() as db:
        row = db.scalar(select(AnalysisJobRecord).where(AnalysisJobRecord.session_id == session_id))
        return get_job(row.id) if row else None


def list_jobs_by_status(statuses: Iterable[str]) -> list[dict[str, Any]]:
    wanted = list(statuses)
    if not wanted:
        return []
    with session_scope() as db:
        rows = db.scalars(select(AnalysisJobRecord).where(
            AnalysisJobRecord.status.in_(wanted)).order_by(AnalysisJobRecord.created_at)).all()
        return [{
            "id": row.id, "analysisJobId": row.id, "sessionId": row.session_id,
            "status": row.status, "progress": row.progress, "reportId": row.report_id,
            "attempts": row.attempts,
        } for row in rows]


def save_report(report_id: str, data: dict[str, Any]) -> None:
    with session_scope() as db:
        row = db.get(DiagnosisReportRecord, report_id)
        if row is None:
            row = DiagnosisReportRecord(
                id=report_id, session_id=data["sessionId"], score_id=data["scoreId"],
                algorithm_version=data["algorithmVersion"],
                threshold_profile=data["thresholdProfile"], score_hash=data["scoreHash"],
                source_references=data.get("sourceReferences", []), payload=data,
            )
            db.add(row)


def get_report(report_id: str) -> dict[str, Any] | None:
    with session_scope() as db:
        row = db.get(DiagnosisReportRecord, report_id)
        return dict(row.payload) if row else None


def save_exercise(exercise_id: str, data: dict[str, Any]) -> None:
    with session_scope() as db:
        row = db.get(ExerciseRecord, exercise_id)
        if row is None:
            row = ExerciseRecord(
                id=exercise_id, profile_id=config.LOCAL_PROFILE_ID,
                report_id=data.get("reportId"), score_id=data["sourceScoreId"], payload=data,
            )
            db.add(row)
        else:
            row.payload = data


def get_exercise(exercise_id: str) -> dict[str, Any] | None:
    with session_scope() as db:
        row = db.get(ExerciseRecord, exercise_id)
        return dict(row.payload) if row else None


def save_generated(kind: str, external_id: str, data: dict[str, Any]) -> None:
    with session_scope() as db:
        row = db.scalar(select(GeneratedItemRecord).where(
            GeneratedItemRecord.kind == kind, GeneratedItemRecord.external_id == external_id))
        if row is None:
            db.add(GeneratedItemRecord(kind=kind, external_id=external_id, payload=data))
        else:
            row.payload = data


def get_generated(kind: str, external_id: str) -> dict[str, Any] | None:
    with session_scope() as db:
        row = db.scalar(select(GeneratedItemRecord).where(
            GeneratedItemRecord.kind == kind, GeneratedItemRecord.external_id == external_id))
        return dict(row.payload) if row else None


def list_generated(kind: str) -> list[dict[str, Any]]:
    with session_scope() as db:
        rows = db.scalars(select(GeneratedItemRecord).where(
            GeneratedItemRecord.kind == kind).order_by(GeneratedItemRecord.created_at)).all()
        return [dict(row.payload) for row in rows]


def save_comparison(data: dict[str, Any]) -> None:
    baseline = data["baselineId"]
    retry = data["retryId"]
    with session_scope() as db:
        row = db.scalar(select(ComparisonRecord).where(
            ComparisonRecord.baseline_report_id == baseline,
            ComparisonRecord.retry_report_id == retry))
        if row is None:
            db.add(ComparisonRecord(id=f"cmp_{uuid.uuid4().hex[:12]}",
                                    baseline_report_id=baseline,
                                    retry_report_id=retry, payload=data))


def latest_comparison_for_report(report_id: str) -> dict[str, Any] | None:
    """Return the bounded comparison whose retry side is the current report."""
    with session_scope() as db:
        row = db.scalar(
            select(ComparisonRecord)
            .where(ComparisonRecord.retry_report_id == report_id)
            .order_by(ComparisonRecord.created_at.desc())
            .limit(1)
        )
        return dict(row.payload) if row else None


def save_mentor_interaction(data: dict[str, Any]) -> None:
    with session_scope() as db:
        db.add(MentorInteractionRecord(
            id=data.get("id", f"mentor_{uuid.uuid4().hex[:12]}"), report_id=data["reportId"],
            provider=data["provider"], model=data.get("model", ""),
            prompt_version=data["promptVersion"], response_mode=data["responseMode"],
            latency_ms=data["latencyMs"], fallback_reason=data.get("fallbackReason"),
            payload=data.get("payload", {}),
        ))


_MENTOR_MEMORY_MAX_TURNS = 20
_MENTOR_MEMORY_MAX_CHARACTERS = 12_000


def _public_mentor_memory(row: MentorMemoryRecord | None,
                          scope_id: str) -> dict[str, Any]:
    turns = list(row.turns or []) if row else []
    return {
        "enabled": True,
        "scopeId": scope_id,
        "rememberedTurnCount": len(turns),
        "turns": turns,
        "updatedAt": _iso(row.updated_at) if row else None,
    }


def get_mentor_memory(scope_id: str) -> dict[str, Any]:
    """Load local-only, score-lineage memory for the single v1 profile."""
    with session_scope() as db:
        row = db.scalar(select(MentorMemoryRecord).where(
            MentorMemoryRecord.profile_id == config.LOCAL_PROFILE_ID,
            MentorMemoryRecord.scope_id == scope_id,
        ))
        return _public_mentor_memory(row, scope_id)


def append_mentor_memory(scope_id: str, report_id: str,
                         user_message: str, assistant_message: str,
                         intent: str) -> dict[str, Any]:
    """Append one exchange and trim old text before it can grow unbounded."""
    additions = [
        {"role": "user", "content": user_message.strip()[:2_000],
         "reportId": report_id},
        {"role": "assistant", "content": assistant_message.strip()[:4_000],
         "reportId": report_id, "intent": intent},
    ]
    with session_scope() as db:
        row = db.scalar(select(MentorMemoryRecord).where(
            MentorMemoryRecord.profile_id == config.LOCAL_PROFILE_ID,
            MentorMemoryRecord.scope_id == scope_id,
        ))
        if row is None:
            row = MentorMemoryRecord(
                id=f"memory_{uuid.uuid4().hex[:12]}",
                profile_id=config.LOCAL_PROFILE_ID,
                scope_id=scope_id,
                turns=[],
            )
            db.add(row)
        turns = [turn for turn in list(row.turns or [])
                 if turn.get("role") in {"user", "assistant"}
                 and isinstance(turn.get("content"), str)]
        turns.extend(turn for turn in additions if turn["content"])
        turns = turns[-_MENTOR_MEMORY_MAX_TURNS:]
        while (len(turns) > 2 and
               sum(len(str(turn.get("content", ""))) for turn in turns)
               > _MENTOR_MEMORY_MAX_CHARACTERS):
            turns.pop(0)
        row.turns = turns
        row.updated_at = _utcnow()
        db.flush()
        return _public_mentor_memory(row, scope_id)


def clear_mentor_memory(scope_id: str) -> None:
    with session_scope() as db:
        db.execute(delete(MentorMemoryRecord).where(
            MentorMemoryRecord.profile_id == config.LOCAL_PROFILE_ID,
            MentorMemoryRecord.scope_id == scope_id,
        ))


def cleanup_expired() -> list[str]:
    """Mark abandoned captures and remove metadata for expired generated artifacts.

    Returns storage keys for FileStore to delete. Source/upload artifacts never expire.
    """
    now = _utcnow()
    abandoned_before = now - timedelta(hours=config.ABANDONED_SESSION_HOURS)
    keys: list[str] = []
    with session_scope() as db:
        sessions = db.scalars(select(PracticeSessionRecord).where(
            PracticeSessionRecord.status.in_(["created", "recording", "device_lost"]),
            PracticeSessionRecord.updated_at < abandoned_before,
        )).all()
        for row in sessions:
            row.status = "abandoned"
            data = dict(row.payload)
            data["status"] = "abandoned"
            row.payload = data
        artifacts = db.scalars(select(ArtifactRecord).where(
            ArtifactRecord.generated.is_(True), ArtifactRecord.expires_at.is_not(None),
            ArtifactRecord.expires_at < now,
        )).all()
        keys = [row.storage_key for row in artifacts]
        if artifacts:
            db.execute(delete(ArtifactRecord).where(ArtifactRecord.id.in_([row.id for row in artifacts])))
    return keys


def ping() -> bool:
    with session_scope() as db:
        return db.scalar(select(func.count(LocalProfileRecord.id))) is not None
