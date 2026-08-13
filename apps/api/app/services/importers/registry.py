from __future__ import annotations

from app.services.importers.base import ScoreImporter, ScoreImportError
from app.services.importers.midi import MidiScoreImporter
from app.services.importers.musicxml import MusicXmlImporter
from app.services.importers.vision import VisionScoreImporter

_IMPORTERS: tuple[ScoreImporter, ...] = (
    MusicXmlImporter(), MidiScoreImporter(), VisionScoreImporter(),
)


def detect_importer(filename: str, content: bytes) -> ScoreImporter:
    for importer in _IMPORTERS:
        if importer.supports(filename, content):
            return importer
    raise ScoreImportError("仅支持 MusicXML/XML/MXL、MIDI，或乐谱照片 / PDF")
