from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass

from app.schemas.models import NormalizedScore, ScoreNormalization


class ScoreImportError(ValueError):
    code = "SCORE_UNSUPPORTED"


class ScoreLimitError(ScoreImportError):
    code = "SCORE_LIMIT_EXCEEDED"


@dataclass(frozen=True)
class ImportResult:
    normalized: NormalizedScore
    source_bytes: bytes
    source_suffix: str
    source_media_type: str
    render_bytes: bytes
    timeline_bytes: bytes | None = None


class ScoreImporter(ABC):
    @abstractmethod
    def supports(self, filename: str, content: bytes) -> bool:
        raise NotImplementedError

    @abstractmethod
    def import_bytes(self, filename: str, content: bytes, score_id: str,
                     normalization: ScoreNormalization | None = None) -> ImportResult:
        raise NotImplementedError
