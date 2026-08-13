"""Orchestrates import adapters, artifact storage, and normalized score records."""
from __future__ import annotations

import uuid
from pathlib import Path
from typing import Literal

from app import config, storage
from app.db import repositories
from app.schemas.models import NormalizedScore, ScoreNormalization, SourceReference
from app.services.file_store import artifact_path, local_file_store
from app.services.importers import detect_importer
from app.services.importers.base import ScoreImportError, ScoreLimitError
from app.services.importers.midi import MidiScoreImporter
from app.services.importers.vision import VisionScoreImporter


def _new_score_id() -> str:
    return f"score_{uuid.uuid4().hex[:12]}"


LibraryCategory = Literal["demo", "uploaded", "generated", "internal"]


def _size_limit(filename: str, content: bytes) -> int:
    """How large this kind of upload may be.

    A phone photograph of a page is routinely several times the size of any
    notation file, so it gets its own ceiling. Checking here rather than inside
    the importer means an oversized file is refused before it is parsed.
    """
    if VisionScoreImporter().supports(filename, content):
        return max(config.MAX_SCORE_IMAGE_BYTES, config.MAX_SCORE_BYTES)
    return config.MAX_SCORE_BYTES


def ingest_score(filename: str, content: bytes, *, score_id: str | None = None,
                 normalization: ScoreNormalization | None = None,
                 builtin: bool = False,
                 library_category: LibraryCategory = "internal") -> NormalizedScore:
    if not content:
        raise ScoreImportError("文件为空")
    limit = _size_limit(filename, content)
    if len(content) > limit:
        raise ScoreLimitError(f"文件超过 {limit // (1024 * 1024)} MB 上限")
    resolved_id = score_id or _new_score_id()
    importer = detect_importer(filename, content)
    result = importer.import_bytes(filename, content, resolved_id, normalization)
    source = local_file_store.put(
        kind="score-source", content=result.source_bytes, original_name=filename,
        suffix=result.source_suffix, media_type=result.source_media_type,
    )
    render = local_file_store.put(
        kind="score-render", content=result.render_bytes,
        original_name=f"{resolved_id}.musicxml", suffix=".musicxml",
        media_type="application/vnd.recordare.musicxml",
    )
    references = [SourceReference(
        artifactId=source.artifact_id, kind="score-source", sha256=source.sha256,
        originalName=source.original_name,
    ), SourceReference(
        artifactId=render.artifact_id, kind="score-render", sha256=render.sha256,
        originalName=render.original_name,
    )]
    normalized = result.normalized.model_copy(update={"sourceReferences": references})
    data = {
        "bundle": normalized.bundle.model_dump(), "builtin": builtin,
        "libraryCategory": "demo" if builtin else library_category,
        "profileId": config.LOCAL_PROFILE_ID,
        "importerVersion": config.SCORE_IMPORTER_VERSION,
        "sourceType": normalized.sourceType.value,
        "sourceName": Path(filename).name,
        "displayMode": normalized.displayMode.value,
        "warnings": normalized.warnings,
        "confidence": normalized.confidence,
        "normalization": normalized.normalization.model_dump(),
        "sourceReferences": [reference.model_dump() for reference in references],
        "sourceArtifactId": source.artifact_id,
        "renderArtifactId": render.artifact_id,
        # Compatibility for deterministic generation and old routes.
        "xmlPath": str(local_file_store.resolve(render.storage_key)),
    }
    storage.put("score", resolved_id, data)
    return normalized


def renormalize_midi(score_id: str, normalization: ScoreNormalization) -> NormalizedScore:
    existing = storage.get("score", score_id)
    if not existing:
        raise ScoreImportError("曲目不存在")
    if existing.get("sourceType") != "midi":
        raise ScoreImportError("MusicXML 保留原始记谱，不需要 MIDI 量化复核")
    source_path = artifact_path(existing["sourceArtifactId"])
    if not source_path:
        raise ScoreImportError("原始 MIDI 文件缺失")
    content = source_path.read_bytes()
    importer = MidiScoreImporter()
    result = importer.import_bytes(existing.get("sourceName", "score.mid"), content,
                                   score_id, normalization)
    render = local_file_store.put(
        kind="score-render", content=result.render_bytes,
        original_name=f"{score_id}.musicxml", suffix=".musicxml",
        media_type="application/vnd.recordare.musicxml",
    )
    source_meta = repositories.get_artifact(existing["sourceArtifactId"])
    references = [SourceReference(
        artifactId=existing["sourceArtifactId"], kind="score-source",
        sha256=source_meta["sha256"] if source_meta else result.normalized.bundle.meta.scoreHash,
        originalName=existing.get("sourceName", ""),
    ), SourceReference(
        artifactId=render.artifact_id, kind="score-render", sha256=render.sha256,
        originalName=render.original_name,
    )]
    normalized = result.normalized.model_copy(update={"sourceReferences": references})
    data = {
        **existing,
        "bundle": normalized.bundle.model_dump(),
        "warnings": normalized.warnings,
        "confidence": normalized.confidence,
        "normalization": normalized.normalization.model_dump(),
        "sourceReferences": [reference.model_dump() for reference in references],
        "renderArtifactId": render.artifact_id,
        "xmlPath": str(local_file_store.resolve(render.storage_key)),
    }
    storage.put("score", score_id, data)
    return normalized
