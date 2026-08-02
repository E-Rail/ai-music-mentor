from __future__ import annotations

from pathlib import Path

from app.schemas.models import ScoreNormalization
from app.services.importers.base import ImportResult, ScoreImporter, ScoreImportError


class PdfOmrImporter(ScoreImporter):
    """Reserved adapter boundary for the next milestone; no pretend OMR in v2."""

    def supports(self, filename: str, content: bytes) -> bool:
        return Path(filename).suffix.lower() == ".pdf" or content.startswith(b"%PDF-")

    def import_bytes(self, filename: str, content: bytes, score_id: str,
                     normalization: ScoreNormalization | None = None) -> ImportResult:
        raise ScoreImportError("PDF 识谱将在下一里程碑提供；本版请上传 MusicXML/MXL 或 MIDI")
