from __future__ import annotations

from app.i18n import say
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
    raise ScoreImportError(say("import.unsupportedFile"))
