"""Score importer adapters."""

from app.services.importers.registry import detect_importer

__all__ = ["detect_importer"]
