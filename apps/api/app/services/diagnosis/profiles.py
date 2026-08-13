"""Versioned thresholds for MIDI and local microphone transcription."""
from __future__ import annotations

from dataclasses import dataclass

from app.schemas.models import InputSource, InstrumentProfile, PerformanceEvent


@dataclass(frozen=True)
class DetectionProfile:
    profile_id: str
    input_source: InputSource
    instrument: InstrumentProfile
    min_confidence: float
    min_pitch: int
    max_pitch: int
    chord_window_ms: float
    include_duration_errors: bool
    duration_tolerance: float


def resolve_profile(input_source: InputSource | str,
                    instrument: InstrumentProfile | str) -> DetectionProfile:
    source = InputSource(input_source)
    selected = InstrumentProfile(instrument)
    if source != InputSource.microphone:
        return DetectionProfile(
            "midi-detection-v4-velocity", source, selected, 0.0, 0, 127, 70.0, True, .35)
    return {
        InstrumentProfile.piano: DetectionProfile(
            "audio-piano-v2", source, selected, 0.35, 21, 108, 90.0, True, .50),
        InstrumentProfile.guitar: DetectionProfile(
            "audio-guitar-v2", source, selected, 0.38, 40, 88, 75.0, True, .60),
        InstrumentProfile.violin: DetectionProfile(
            "audio-violin-v2", source, selected, 0.40, 55, 103, 35.0, True, .80),
    }[selected]


def accepted_events(events: list[PerformanceEvent],
                    profile: DetectionProfile) -> tuple[list[PerformanceEvent], int]:
    if profile.input_source != InputSource.microphone:
        return events, 0
    accepted: list[PerformanceEvent] = []
    for event in events:
        confidence = event.transcriptionConfidence
        if (confidence is None or confidence < profile.min_confidence or
                event.pitch < profile.min_pitch or event.pitch > profile.max_pitch):
            continue
        accepted.append(event)
    return accepted, len(events) - len(accepted)
