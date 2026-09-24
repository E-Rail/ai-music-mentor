"""What the page asks beyond pitch and rhythm, and how a take is held to it.

Each case plays one small score twice: once as a musician reading it would,
which must produce no finding, and once the way a student slips, which must
produce exactly the finding a teacher would name — once, at the right bar.
"""
from __future__ import annotations

import sys
from pathlib import Path

import mido

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "apps" / "api"))

from app.schemas.models import ErrorType, InputSource, PerformanceEvent  # noqa: E402
from app.services.diagnosis.pipeline import run_analysis                # noqa: E402
from app.services.midi_io import load_midi_events                       # noqa: E402
from app.services.score_import import parse_musicxml                    # noqa: E402

STEPS = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}


def _note(pitch: str, beats: float, *, notations: str = "", tie: str = "",
          chord: bool = False) -> str:
    step, octave = pitch[0], int(pitch[-1])
    kind = {4: "whole", 2: "half", 1: "quarter", 0.5: "eighth"}[beats]
    return (f'<note>{"<chord/>" if chord else ""}<pitch><step>{step}</step>'
            f"<octave>{octave}</octave></pitch><duration>{int(beats * 2)}</duration>"
            f'{f"<tie type={chr(34)}{tie}{chr(34)}/>" if tie else ""}<type>{kind}</type>'
            f'{f"<notations>{notations}</notations>" if notations else ""}</note>')


def _direction(content: str) -> str:
    return f'<direction placement="above"><direction-type>{content}</direction-type></direction>'


def _metronome(bpm: int) -> str:
    return (_direction(f"<metronome><beat-unit>quarter</beat-unit><per-minute>{bpm}"
                       f"</per-minute></metronome>").replace("</direction>", "")
            + f'<sound tempo="{bpm}"/></direction>')


def _score(*parts: list[str], bpm: int = 100) -> bytes:
    """MusicXML from bars of note markup, one list per staff (RH first)."""
    names = ["Right Hand", "Left Hand"]
    part_list = "".join(f'<score-part id="P{i + 1}"><part-name>{names[i]}</part-name></score-part>'
                        for i in range(len(parts)))
    body = ""
    for index, bars in enumerate(parts):
        measures = ""
        for number, bar in enumerate(bars, start=1):
            head = ('<attributes><divisions>2</divisions><time><beats>4</beats>'
                    '<beat-type>4</beat-type></time></attributes>' + _metronome(bpm)
                    if number == 1 else "")
            measures += f'<measure number="{number}">{head}{bar}</measure>'
        body += f'<part id="P{index + 1}">{measures}</part>'
    return (f'<?xml version="1.0" encoding="UTF-8"?><score-partwise version="3.1">'
            f"<part-list>{part_list}</part-list>{body}</score-partwise>").encode()


def _bundle(xml: bytes, score_id: str = "shape"):
    return parse_musicxml(xml, score_id)


def _perform(bundle, *, ms_at=None, velocity=72, hold=0.9, source="web-midi",
             edit=None) -> list[PerformanceEvent]:
    """Play every written note: on time, held for `hold` of its value.

    ``ms_at(beat)`` is where the player puts a beat (default: the marked
    tempo). ``edit(event, note)`` may return changes to one played note, or
    None to leave it out.
    """
    ms_per_beat = 60_000 / bundle.meta.tempo
    ms_at = ms_at or (lambda beat: beat * ms_per_beat)
    notes = []
    for event in bundle.events:
        beat = event.absoluteBeat
        for pitch in event.pitches:
            start = ms_at(beat)
            end = start + hold * (ms_at(beat + event.durationBeat) - start)
            note = dict(id=f"n{len(notes)}", tOnMs=start, tOffMs=end, pitch=pitch,
                        velocity=velocity, source=source)
            if edit:
                change = edit(event, note)
                if change is None:
                    continue
                note.update(change)
            notes.append(PerformanceEvent(**note))
    return notes


def _analyse(bundle, notes, source=InputSource.web_midi):
    return run_analysis(bundle, notes, "report", "session", input_source=source,
                        created_at="2026-09-24T00:00:00Z")


def _types(report) -> list[str]:
    return [error.type.value for error in report.errors]


# ------------------------------------------------------------------- ties

TIED = _score([
    _note("C4", 1) + _note("D4", 1) + _note("E4", 2, tie="start", notations='<tied type="start"/>'),
    _note("E4", 2, tie="stop", notations='<tied type="stop"/>') + _note("F4", 1) + _note("G4", 1),
    _note("A4", 1) + _note("G4", 1) + _note("F4", 1) + _note("E4", 1),
])


def test_a_tied_note_is_one_note_held_across_the_bar():
    bundle = _bundle(TIED)
    tied = [event for event in bundle.events if event.pitches == [64] and event.measureNo == 1]
    assert len(tied) == 1 and tied[0].durationBeat == 4
    assert not [event for event in bundle.events
                if event.measureNo == 2 and event.onsetBeat == 0]


def test_holding_a_tie_is_not_a_missed_note():
    report = _analyse(_bundle(TIED), _perform(_bundle(TIED)))
    assert ErrorType.missed_note.value not in _types(report)
    assert report.metrics.pitchScore == 100


# --------------------------------------------------------------- fermata

FERMATA = _score([
    _note("C4", 1) + _note("D4", 1) + _note("E4", 1) + _note("F4", 1),
    _note("G4", 1) + _note("A4", 1) + _note("G4", 2, notations="<fermata/>"),
    _note("F4", 1) + _note("E4", 1) + _note("D4", 1) + _note("C4", 1),
    _note("D4", 1) + _note("E4", 1) + _note("D4", 1) + _note("C4", 1),
])


def test_a_fermata_may_be_held_as_long_as_the_player_likes():
    bundle = _bundle(FERMATA)
    beat = 600.0
    # The fermata in bar 2 is held for four beats instead of two.
    report = _analyse(bundle, _perform(bundle, ms_at=lambda b: b * beat + (1_200 if b >= 8 else 0)))
    assert ErrorType.hesitation.value not in _types(report)
    assert ErrorType.early_late.value not in _types(report)


# ------------------------------------------------------------ written tempo

PLAIN = _score([
    _note("C4", 1) + _note("D4", 1) + _note("E4", 1) + _note("F4", 1),
    _note("G4", 1) + _note("A4", 1) + _note("G4", 1) + _note("E4", 1),
    _note("F4", 1) + _note("D4", 1) + _note("E4", 1) + _note("C4", 1),
    _note("D4", 1) + _note("E4", 1) + _note("F4", 1) + _note("G4", 1),
    _note("A4", 1) + _note("G4", 1) + _note("F4", 1) + _note("E4", 1),
    _note("D4", 1) + _note("C4", 1) + _note("D4", 1) + _note("C4", 1),
])


def _with_words_at_bar(xml: bytes, bar: int, words: str) -> bytes:
    marker = f'<measure number="{bar}">'.encode()
    return xml.replace(marker, marker + _direction(f"<words>{words}</words>").encode(), 1)


def _with_metronome_at_bar(xml: bytes, bar: int, bpm: int) -> bytes:
    marker = f'<measure number="{bar}">'.encode()
    return xml.replace(marker, marker + _metronome(bpm).encode(), 1)


def _slowing_from(beat0: float, per_beat: float, base: float = 600.0):
    """Beat → ms for a player who slows by `per_beat` ms per beat after beat0."""
    def ms_at(beat: float) -> float:
        if beat <= beat0:
            return beat * base
        extra = beat - beat0
        return beat0 * base + extra * base + per_beat * extra * extra / 2
    return ms_at


def test_slowing_under_a_written_rit_is_reading_the_page():
    xml = _with_words_at_bar(PLAIN, 5, "rit.")
    bundle = _bundle(xml)
    assert [span.shape for span in bundle.meta.tempoPlan] == ["steady", "slowing"]
    report = _analyse(bundle, _perform(bundle, ms_at=_slowing_from(16, 40)))
    assert ErrorType.tempo_instability.value not in _types(report)


def test_the_same_slowing_without_a_rit_is_named():
    bundle = _bundle(PLAIN)
    report = _analyse(bundle, _perform(bundle, ms_at=_slowing_from(16, 40)))
    assert ErrorType.tempo_instability.value in _types(report)


def test_a_new_metronome_mark_is_not_unsteadiness():
    bundle = _bundle(_with_metronome_at_bar(PLAIN, 4, 75))
    assert [span.bpm for span in bundle.meta.tempoPlan] == [100, 75]

    def ms_at(beat: float) -> float:
        return beat * 600 if beat <= 12 else 12 * 600 + (beat - 12) * 800

    report = _analyse(bundle, _perform(bundle, ms_at=ms_at))
    assert ErrorType.tempo_instability.value not in _types(report)
    # …and the curve's target steps down with the page.
    assert {point.targetBpm for point in report.tempoCurve} == {100, 75}


# ---------------------------------------------------------- stops and repeats

def test_an_unwritten_stop_is_named_once_where_it_happened():
    bundle = _bundle(PLAIN)
    report = _analyse(bundle, _perform(
        bundle, ms_at=lambda beat: beat * 600 + (2_000 if beat >= 16 else 0)))
    stops = [error for error in report.errors if error.type == ErrorType.hesitation]
    assert len(stops) == 1
    assert stops[0].location["measure"] == 5 and stops[0].location["beat"] == 0
    assert ErrorType.early_late.value not in _types(report)
    assert report.performance.hesitations == 1


def test_a_steady_take_has_no_stops():
    bundle = _bundle(PLAIN)
    report = _analyse(bundle, _perform(bundle))
    assert report.errors == []
    assert report.performance.hesitations == 0 and report.performance.restarts == 0


def test_going_back_to_replay_a_bar_is_one_restart_not_extra_notes():
    bundle = _bundle(PLAIN)
    beat = 600.0
    notes = _perform(bundle, ms_at=lambda b: b * beat if b < 12 else b * beat + 4 * beat + 400)
    # Bar 3 played, then played again before going on.
    replay = [PerformanceEvent(id=f"again{index}", tOnMs=12 * beat + index * beat + 200,
                               tOffMs=12 * beat + index * beat + 700, pitch=pitch, velocity=72)
              for index, pitch in enumerate([65, 62, 64, 60])]
    report = _analyse(bundle, sorted(notes + replay, key=lambda note: note.tOnMs))
    assert ErrorType.extra_note.value not in _types(report)
    restarts = [error for error in report.errors if error.type == ErrorType.hesitation]
    assert len(restarts) == 1
    assert report.performance.restarts == 1


# -------------------------------------------------------------- articulation

STACCATO = _score([
    "".join(_note(p, 1, notations="<articulations><staccato/></articulations>")
            for p in ("C4", "D4", "E4", "F4")),
    _note("G4", 1) + _note("A4", 1) + _note("G4", 1) + _note("E4", 1),
])


def test_staccato_played_short_is_met_and_held_is_named():
    bundle = _bundle(STACCATO)
    short = _analyse(bundle, _perform(bundle, edit=lambda event, note: (
        {"tOffMs": note["tOnMs"] + 200} if "staccato" in event.articulations else {})))
    assert short.errors == []
    assert short.performance.staccatoChecked == 4 and short.performance.staccatoMet == 4

    held = _analyse(bundle, _perform(bundle))
    findings = [error for error in held.errors if error.type == ErrorType.duration_anomaly]
    assert len(findings) == 1 and findings[0].location["measure"] == 1


def test_a_short_staccato_is_not_also_a_duration_mistake():
    bundle = _bundle(STACCATO)
    report = _analyse(bundle, _perform(bundle, edit=lambda event, note: (
        {"tOffMs": note["tOnMs"] + 120} if "staccato" in event.articulations else {})))
    assert ErrorType.duration_anomaly.value not in _types(report)


def test_a_key_let_go_under_the_pedal_is_not_judged_for_length():
    bundle = _bundle(PLAIN)
    report = _analyse(bundle, _perform(bundle, hold=0.3, edit=lambda event, note: {
        "pedalAtRelease": True}))
    assert ErrorType.duration_anomaly.value not in _types(report)


SLURRED = _score([
    _note("C4", 1, notations='<slur type="start"/>') + _note("D4", 1) + _note("E4", 1)
    + _note("F4", 1, notations='<slur type="stop"/>'),
    _note("G4", 1) + _note("A4", 1) + _note("G4", 1) + _note("E4", 1),
])


def test_slurred_notes_must_be_joined():
    bundle = _bundle(SLURRED)
    assert [event.legatoToNext for event in bundle.events[:4]] == [True, True, True, False]
    joined = _analyse(bundle, _perform(bundle, hold=1.0))
    assert joined.performance.legatoChecked == 3 and joined.performance.legatoMet == 3
    assert ErrorType.duration_anomaly.value not in _types(joined)

    detached = _analyse(bundle, _perform(bundle, hold=0.55))
    gaps = [error for error in detached.errors
            if error.type == ErrorType.duration_anomaly and error.location["measure"] == 1]
    assert gaps and detached.performance.legatoMet == 0


ACCENTED = _score([
    _note("C4", 1) + _note("D4", 1) + _note("E4", 1, notations="<articulations><accent/></articulations>")
    + _note("F4", 1),
    _note("G4", 1) + _note("A4", 1) + _note("G4", 1) + _note("E4", 1),
])


def test_an_accent_must_stand_out_from_its_neighbours():
    bundle = _bundle(ACCENTED)
    leaned = _analyse(bundle, _perform(bundle, edit=lambda event, note: (
        {"velocity": 100} if "accent" in event.articulations else {})))
    assert leaned.performance.accentsChecked == 1 and leaned.performance.accentsMet == 1
    assert ErrorType.dynamics_anomaly.value not in _types(leaned)

    flat = _analyse(bundle, _perform(bundle))
    assert [error.type for error in flat.errors] == [ErrorType.dynamics_anomaly]


def _with_wedge(xml: bytes, bar: int, kind: str) -> bytes:
    start = f'<measure number="{bar}">'.encode()
    xml = xml.replace(start, start + _direction(f'<wedge type="{kind}"/>').encode(), 1)
    end = f'</measure><measure number="{bar + 1}">'.encode()
    return xml.replace(end, _direction('<wedge type="stop"/>').encode() + end, 1)


def test_a_written_crescendo_has_to_grow():
    bundle = _bundle(_with_wedge(PLAIN, 2, "crescendo"))
    assert [hairpin.kind for hairpin in bundle.meta.hairpins] == ["crescendo"]
    grown = _analyse(bundle, _perform(bundle, edit=lambda event, note: {
        "velocity": 60 + int(max(0, event.absoluteBeat - 4) * 8) if 4 <= event.absoluteBeat < 8 else 60}))
    assert grown.performance.hairpinsChecked == 1 and grown.performance.hairpinsMet == 1

    flat = _analyse(bundle, _perform(bundle))
    assert flat.performance.hairpinsMet == 0
    assert ErrorType.dynamics_anomaly.value in _types(flat)


def test_a_microphone_is_never_held_to_releases_or_velocities():
    bundle = _bundle(STACCATO)
    report = _analyse(bundle, _perform(bundle, source="microphone", edit=lambda event, note: {
        "transcriptionConfidence": 0.95}), source=InputSource.microphone)
    assert report.performance.staccatoChecked == 0
    assert report.performance.velocityRange is None


# ------------------------------------------------------------------- hands

TWO_HANDS = _score(
    [_note("E4", 1) + _note("D4", 1) + _note("C4", 1) + _note("D4", 1)] * 4,
    [_note("C3", 2) + _note("G3", 2)] * 4,
)


def test_each_hand_is_measured_on_its_own():
    bundle = _bundle(TWO_HANDS)
    left = {pitch for event in bundle.events if event.part == "LH" for pitch in event.pitches}
    report = _analyse(bundle, _perform(bundle, edit=lambda event, note: (
        {"tOnMs": note["tOnMs"] + 60, "velocity": 50} if note["pitch"] in left
        else {"velocity": 80})))
    performance = report.performance
    assert [hand.hand for hand in performance.hands] == ["RH", "LH"]
    assert performance.handLagMs is not None and 45 <= performance.handLagMs <= 75
    assert performance.handBalance == 30
    assert performance.velocityRange is not None


# --------------------------------------------------------------- MIDI files

def test_an_uploaded_midi_file_keeps_the_pedal(tmp_path):
    midi = mido.MidiFile(ticks_per_beat=480)
    track = mido.MidiTrack()
    midi.tracks.append(track)
    track.append(mido.Message("note_on", note=60, velocity=70, time=0))
    track.append(mido.Message("control_change", control=64, value=127, time=200))
    track.append(mido.Message("note_off", note=60, velocity=0, time=200))
    track.append(mido.Message("control_change", control=64, value=0, time=200))
    track.append(mido.Message("note_on", note=62, velocity=70, time=0))
    track.append(mido.Message("note_off", note=62, velocity=0, time=400))
    path = tmp_path / "pedal.mid"
    midi.save(path)
    first, second = load_midi_events(str(path))
    assert first.pedalAtRelease is True and first.pedalDown is False
    assert second.pedalAtRelease is False
