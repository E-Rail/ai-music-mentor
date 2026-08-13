"""Migration-ready persistence model.

Musical payloads remain immutable JSON contracts, but each lifecycle entity has its
own relational table, foreign keys, indexes, and idempotency constraints.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from sqlalchemy import (JSON, Boolean, DateTime, Float, ForeignKey, Index,
                        Integer, String, Text, UniqueConstraint)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class Base(DeclarativeBase):
    pass


class LocalProfileRecord(Base):
    __tablename__ = "local_profiles"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    display_name: Mapped[str] = mapped_column(String(160), default="本机练习者")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class ArtifactRecord(Base):
    __tablename__ = "artifacts"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    profile_id: Mapped[str] = mapped_column(ForeignKey("local_profiles.id"), index=True)
    kind: Mapped[str] = mapped_column(String(40), index=True)
    storage_key: Mapped[str] = mapped_column(String(512), unique=True)
    original_name: Mapped[str] = mapped_column(String(512), default="")
    media_type: Mapped[str] = mapped_column(String(160), default="application/octet-stream")
    sha256: Mapped[str] = mapped_column(String(64), index=True)
    size_bytes: Mapped[int] = mapped_column(Integer)
    generated: Mapped[bool] = mapped_column(Boolean, default=False)
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class ScoreRecord(Base):
    __tablename__ = "scores"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    profile_id: Mapped[str] = mapped_column(ForeignKey("local_profiles.id"), index=True)
    source_type: Mapped[str] = mapped_column(String(24), index=True)
    source_name: Mapped[str] = mapped_column(String(512), default="")
    display_mode: Mapped[str] = mapped_column(String(40), default="exact_notation")
    title: Mapped[str] = mapped_column(String(512))
    composer: Mapped[str] = mapped_column(String(512), default="")
    score_hash: Mapped[str] = mapped_column(String(64), index=True)
    confidence: Mapped[float] = mapped_column(Float, default=1.0)
    builtin: Mapped[bool] = mapped_column(Boolean, default=False)
    source_artifact_id: Mapped[str | None] = mapped_column(ForeignKey("artifacts.id"), nullable=True)
    render_artifact_id: Mapped[str | None] = mapped_column(ForeignKey("artifacts.id"), nullable=True)
    payload: Mapped[dict[str, Any]] = mapped_column(JSON)
    warnings: Mapped[list[Any]] = mapped_column(JSON, default=list)
    normalization: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow,
                                                  onupdate=utcnow)


class PracticeSessionRecord(Base):
    __tablename__ = "practice_sessions"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    profile_id: Mapped[str] = mapped_column(ForeignKey("local_profiles.id"), index=True)
    score_id: Mapped[str] = mapped_column(ForeignKey("scores.id"), index=True)
    range_start: Mapped[int] = mapped_column(Integer)
    range_end: Mapped[int] = mapped_column(Integer)
    device: Mapped[str] = mapped_column(String(256), default="web-midi")
    status: Mapped[str] = mapped_column(String(32), index=True, default="recording")
    payload: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    job_id: Mapped[str | None] = mapped_column(String(64), nullable=True, unique=True)
    report_id: Mapped[str | None] = mapped_column(String(64), nullable=True, unique=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow,
                                                  onupdate=utcnow)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class EventBatchRecord(Base):
    __tablename__ = "performance_event_batches"
    __table_args__ = (
        UniqueConstraint("session_id", "batch_id", name="uq_event_batch_session_batch"),
        Index("ix_event_batches_session_sequence", "session_id", "sequence_no"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    session_id: Mapped[str] = mapped_column(ForeignKey("practice_sessions.id"), index=True)
    batch_id: Mapped[str] = mapped_column(String(128))
    sequence_no: Mapped[int] = mapped_column(Integer)
    checksum: Mapped[str] = mapped_column(String(64))
    event_count: Mapped[int] = mapped_column(Integer)
    payload: Mapped[list[Any]] = mapped_column(JSON)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class AnalysisJobRecord(Base):
    __tablename__ = "analysis_jobs"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    session_id: Mapped[str] = mapped_column(ForeignKey("practice_sessions.id"), unique=True)
    status: Mapped[str] = mapped_column(String(24), index=True, default="queued")
    progress: Mapped[int] = mapped_column(Integer, default=0)
    report_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    error_code: Mapped[str | None] = mapped_column(String(80), nullable=True)
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class DiagnosisReportRecord(Base):
    __tablename__ = "diagnosis_reports"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    session_id: Mapped[str] = mapped_column(ForeignKey("practice_sessions.id"), unique=True)
    score_id: Mapped[str] = mapped_column(ForeignKey("scores.id"), index=True)
    algorithm_version: Mapped[str] = mapped_column(String(40))
    threshold_profile: Mapped[str] = mapped_column(String(80))
    score_hash: Mapped[str] = mapped_column(String(64), index=True)
    source_references: Mapped[list[Any]] = mapped_column(JSON, default=list)
    payload: Mapped[dict[str, Any]] = mapped_column(JSON)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class ExerciseRecord(Base):
    __tablename__ = "exercises"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    profile_id: Mapped[str] = mapped_column(ForeignKey("local_profiles.id"), index=True)
    report_id: Mapped[str | None] = mapped_column(ForeignKey("diagnosis_reports.id"),
                                                  index=True, nullable=True)
    score_id: Mapped[str] = mapped_column(ForeignKey("scores.id"), index=True)
    payload: Mapped[dict[str, Any]] = mapped_column(JSON)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class ComparisonRecord(Base):
    __tablename__ = "session_comparisons"
    __table_args__ = (UniqueConstraint("baseline_report_id", "retry_report_id",
                                       name="uq_comparison_reports"),)

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    baseline_report_id: Mapped[str] = mapped_column(ForeignKey("diagnosis_reports.id"), index=True)
    retry_report_id: Mapped[str] = mapped_column(ForeignKey("diagnosis_reports.id"), index=True)
    payload: Mapped[dict[str, Any]] = mapped_column(JSON)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class MentorInteractionRecord(Base):
    __tablename__ = "mentor_interactions"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    report_id: Mapped[str] = mapped_column(ForeignKey("diagnosis_reports.id"), index=True)
    provider: Mapped[str] = mapped_column(String(256))
    model: Mapped[str] = mapped_column(String(256), default="")
    prompt_version: Mapped[str] = mapped_column(String(64))
    response_mode: Mapped[str] = mapped_column(String(32))
    latency_ms: Mapped[int] = mapped_column(Integer)
    fallback_reason: Mapped[str | None] = mapped_column(String(256), nullable=True)
    payload: Mapped[dict[str, Any]] = mapped_column(JSON)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class MentorMemoryRecord(Base):
    """Bounded local tutor memory shared by every round of one score lineage."""
    __tablename__ = "mentor_memories"
    __table_args__ = (
        UniqueConstraint("profile_id", "scope_id", name="uq_mentor_memory_profile_scope"),
    )

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    profile_id: Mapped[str] = mapped_column(ForeignKey("local_profiles.id"), index=True)
    scope_id: Mapped[str] = mapped_column(String(160), index=True)
    turns: Mapped[list[Any]] = mapped_column(JSON, default=list)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow,
                                                  onupdate=utcnow)


class GeneratedItemRecord(Base):
    """Generated accompaniment metadata and compatibility-only payloads."""
    __tablename__ = "generated_items"
    __table_args__ = (UniqueConstraint("kind", "external_id", name="uq_generated_kind_id"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    kind: Mapped[str] = mapped_column(String(40), index=True)
    external_id: Mapped[str] = mapped_column(String(64), index=True)
    payload: Mapped[dict[str, Any]] = mapped_column(JSON)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
