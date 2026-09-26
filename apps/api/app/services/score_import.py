"""乐谱导入与标准化（方案 5.1）。

MusicXML → ScoreEvent 序列：
- music21 解析，反复记号统一展开（复杂跳转 D.C./D.S. 返回 SCORE_UNSUPPORTED）
- 和弦音共享 onsetBeat，合并为一个 ScoreEvent
- 装饰音（grace note）设为 optional，不参与主评分
- eventId 规则：scoreId:part:measure:onset:index
"""
from __future__ import annotations

import hashlib
import re

import music21
from defusedxml import ElementTree as SafeET

from app import config
from app.i18n import say
from app.schemas.models import (Hairpin, ScoreBundle, ScoreEvent, ScoreMeta,
                                TempoSpan)


class ScoreUnsupportedError(Exception):
    pass


_DYNAMIC_VELOCITY = {
    "pppp": 20, "ppp": 28, "pp": 36, "p": 46,
    "mp": 58, "mf": 72, "f": 86, "ff": 100,
    "fff": 112, "ffff": 120,
}


def _dynamic_target(element) -> int | None:
    """Return an explicit notation dynamic as a MIDI-velocity target."""
    dynamic = element.getContextByClass(music21.dynamics.Dynamic)
    value = str(getattr(dynamic, "value", "") or "").lower()
    return _DYNAMIC_VELOCITY.get(value)


def _local_name(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def _written_to_sounding_semitones(xml_bytes: bytes) -> int:
    """Read an explicit MusicXML transpose declaration without guessing."""
    try:
        root = SafeET.fromstring(xml_bytes)
    except Exception:
        return 0
    offsets: set[int] = set()
    for transpose in root.iter():
        if _local_name(transpose.tag) != "transpose":
            continue
        chromatic = 0
        octave_change = 0
        for child in transpose:
            name = _local_name(child.tag)
            try:
                if name == "chromatic":
                    chromatic = int(child.text or "0")
                elif name == "octave-change":
                    octave_change = int(child.text or "0")
            except ValueError:
                return 0
        offsets.add(chromatic + 12 * octave_change)
    # A single global offset is safe for the one-instrument microphone scope.
    # Mixed transpositions are left unchanged rather than guessed.
    return offsets.pop() if len(offsets) == 1 else 0


def _detect_part_name(part: music21.stream.Part, index: int) -> str:
    """根据五线谱行/名称粗分 RH/LH（钢琴惯例：P1=RH，P2=LH）。"""
    name = (part.partName or "").lower()
    if any(k in name for k in ("left", "lh", "bass", "左")):  # i18n: deliberate
        return "LH"
    if any(k in name for k in ("right", "rh", "treble", "右")):  # i18n: deliberate
        return "RH"
    # 钢琴 Grand Staff：第一个 part 右手，第二个左手
    return "RH" if index == 0 else "LH"


def _has_complex_repeats(score: music21.stream.Score) -> bool:
    """MVP 不支持复杂跳转（D.C./D.S./Coda），反复记号可展开。"""
    for el in score.recurse():
        if isinstance(el, music21.repeat.RepeatMark):
            if not isinstance(el, music21.bar.Repeat):
                return True
    return False


def parse_musicxml(xml_bytes: bytes, score_id: str) -> ScoreBundle:
    """解析 MusicXML 为标准化 ScoreBundle。反复记号展开为线性事件流。"""
    try:
        score = music21.converter.parse(xml_bytes, format="musicxml")
    except Exception as e:  # noqa: BLE001
        raise ScoreUnsupportedError(say("import.xmlParseFailed", detail=str(e))) from e

    if _has_complex_repeats(score):
        raise ScoreUnsupportedError(say("import.complexRepeats"))

    # 展开反复记号，得到线性演奏顺序
    try:
        expanded = score.expandRepeats()
    except Exception:  # noqa: BLE001
        expanded = score

    meta = _extract_meta(expanded, xml_bytes, score_id)
    if meta.measureCount > config.MAX_MEASURES:
        raise ScoreUnsupportedError(
            say("import.tooManyBars", count=meta.measureCount, limit=config.MAX_MEASURES))

    events = _extract_events(expanded, score_id)
    meta.tempoPlan = tempo_plan(expanded, meta.tempo)
    meta.hairpins = hairpins(expanded)
    if not events:
        raise ScoreUnsupportedError(say("import.noNotes"))
    note_count = sum(len(event.pitches) for event in events)
    if note_count > config.MAX_SCORE_NOTES:
        raise ScoreUnsupportedError(say("import.tooManyNotesCount", count=note_count, limit=config.MAX_SCORE_NOTES))
    max_beat = max(
        (event.absoluteBeat if event.absoluteBeat is not None else
         (event.measureNo - 1) * meta.beatsPerMeasure + event.onsetBeat)
        + event.durationBeat for event in events
    )
    if max_beat * 60 / max(meta.tempo, 1) > config.MAX_SCORE_DURATION_SECONDS:
        raise ScoreUnsupportedError(say("import.tooLong"))
    # Only a written p/mf/f licenses grading a performance against a dynamic.
    meta.hasNotatedDynamics = any(
        event.dynamicTarget is not None for event in events)
    return ScoreBundle(meta=meta, events=events)


def _score_title(score: music21.stream.Score, score_id: str) -> str:
    """Read the name a musician would call this piece.

    MusicXML carries a title in two places and publishers use either. music21
    maps ``<work-title>`` to ``title`` and ``<movement-title>`` to
    ``movementName``, and a file with only the latter — which is what most
    engraving software exports — used to fall through to the internal score ID,
    so the library showed "twinkle_star" instead of 小星星.
    """
    metadata = score.metadata
    for candidate in (getattr(metadata, "title", None),
                      getattr(metadata, "movementName", None)):
        text = str(candidate or "").strip()
        if text:
            return text
    return score_id


def _extract_meta(score: music21.stream.Score, xml_bytes: bytes, score_id: str) -> ScoreMeta:
    md = score.metadata
    title = _score_title(score, score_id)
    composer = (md.composer if md and md.composer else "") or ""

    tempos = score.recurse().getElementsByClass(music21.tempo.MetronomeMark)
    bpm = float(tempos[0].number) if len(tempos) and tempos[0].number else 96.0

    ts_list = score.recurse().getElementsByClass(music21.meter.TimeSignature)
    ts_str = ts_list[0].ratioString if len(ts_list) else "4/4"
    # ScoreEvent offsets and durations use quarterLength units. Keep the
    # measure span in that same unit for every denominator (2/2 = 4, 3/8 = 1.5).
    beats_per_measure = (
        float(ts_list[0].numerator) * 4.0 / float(ts_list[0].denominator)
        if len(ts_list) else 4.0
    )

    parts = [p.partName or f"P{i+1}" for i, p in enumerate(score.parts)]
    measure_count = 0
    for p in score.parts:
        measure_count = max(measure_count, len(p.getElementsByClass(music21.stream.Measure)))

    score_hash = hashlib.sha256(xml_bytes).hexdigest()[:16]
    tempo_map = []
    for mark in tempos:
        if not mark.number:
            continue
        measure = mark.getContextByClass(music21.stream.Measure)
        tempo_map.append({"measureNo": _linear_measure_number(measure),
                          "onsetBeat": float(mark.offset), "bpm": float(mark.number)})
    meter_map = []
    for signature in ts_list:
        measure = signature.getContextByClass(music21.stream.Measure)
        meter_map.append({"measureNo": _linear_measure_number(measure),
                          "onsetBeat": float(signature.offset),
                          "timeSignature": signature.ratioString})
    return ScoreMeta(
        scoreId=score_id, title=title, composer=composer, tempo=bpm,
        timeSignature=ts_str, beatsPerMeasure=beats_per_measure,
        measureCount=measure_count, parts=parts,
        measureLabels=measure_labels(score),
        tempoMap=tempo_map, meterMap=meter_map, scoreHash=score_hash,
        writtenToSoundingSemitones=_written_to_sounding_semitones(xml_bytes),
    )


def measure_labels(score: music21.stream.Score) -> list[str]:
    """What each bar is called on the page, indexed by its timeline position.

    ``measureNo`` is a position in the performance timeline and always counts
    1, 2, 3…, which is what alignment and event IDs need. It is not always what
    the page prints. A piece that opens with a pickup bar numbers that bar 0, so
    every printed number after it is one lower than its position, and telling a
    student to fix "第 4 小节" sends them to the wrong bar.

    The printed numbers are used whenever they are trustworthy — present, never
    repeated, and never counting backwards. Otherwise the position is used,
    because a page numbered 0, 0, 0… is worse than one numbered 1, 2, 3.
    """
    parts = list(score.parts)
    if not parts:
        return []
    longest = max(parts, key=lambda part: len(
        part.getElementsByClass(music21.stream.Measure)))
    printed: list[str] = []
    numbers: list[int] = []
    for measure in longest.getElementsByClass(music21.stream.Measure):
        number = int(measure.number or 0)
        numbers.append(number)
        printed.append(f"{number}{measure.numberSuffix or ''}")
    positional = [str(index) for index in range(1, len(printed) + 1)]
    if not printed:
        return positional
    # music21 reports an unnumbered bar and a bar genuinely printed "0" the same
    # way, so the sequence has to say which this is. A pickup is a 0 followed by
    # bar 1; a 0 anywhere else, or a lone 0, means the file was never numbered.
    leading_zero_is_a_pickup = (
        numbers[0] != 0 or (len(numbers) > 1 and numbers[1] == 1))
    trustworthy = (
        len(set(printed)) == len(printed)
        and all(later >= earlier for earlier, later in zip(numbers, numbers[1:]))
        and all(number > 0 for number in numbers[1:])
        and leading_zero_is_a_pickup
    )
    return printed if trustworthy else positional


def _linear_measure_number(measure: music21.stream.Measure | None) -> int:
    """Return a sequential timeline position after repeat expansion.

    music21 preserves the printed number on repeated copies and adds suffixes
    such as ``1a``. A normalized performance timeline must instead give every
    pass a unique measure number and stable event ID.
    """
    if measure is None:
        return 1
    part = measure.getContextByClass(music21.stream.Part)
    if part is not None:
        for index, candidate in enumerate(
                part.getElementsByClass(music21.stream.Measure), start=1):
            if candidate is measure:
                return index
    return max(1, int(measure.measureNumber or 1))


_ARTICULATIONS = {
    "Staccato": "staccato", "Staccatissimo": "staccatissimo",
    "Tenuto": "tenuto", "Accent": "accent", "StrongAccent": "marcato",
}


def _articulations(element) -> list[str]:
    """The marks on a note that ask for something beyond pitch and length."""
    found = [_ARTICULATIONS[type(mark).__name__]
             for mark in getattr(element, "articulations", [])
             if type(mark).__name__ in _ARTICULATIONS]
    if any(isinstance(mark, music21.expressions.Fermata)
           for mark in getattr(element, "expressions", [])):
        found.append("fermata")
    return found


def _continues_a_tie(note) -> bool:
    """The second half of a tie: written again, but held rather than struck."""
    tie = getattr(note, "tie", None)
    return tie is not None and tie.type in ("stop", "continue")


def _origin(element):
    """The element as the file wrote it, before repeats were unrolled."""
    seen = 0
    while seen < 16 and element.derivation.origin is not None:
        element = element.derivation.origin
        seen += 1
    return element


def _timeline(part) -> dict[int, list[tuple[float, float]]]:
    """Where every written note of a part lands on the performance timeline.

    Slurs and hairpins still point at the notes as written: unrolling repeats
    copies the notes but not what spans them. Each copy remembers the note it
    came from, so a slur in a repeated bar is found on both passes through it.
    """
    index: dict[int, list[tuple[float, float]]] = {}
    for note in part.recurse().notes:
        try:
            beat = float(note.getOffsetInHierarchy(part))
        except music21.sites.SitesException:
            continue
        place = (beat, float(note.duration.quarterLength))
        index.setdefault(id(note), []).append(place)
        origin = _origin(note)
        if origin is not note:
            index.setdefault(id(origin), []).append(place)
    return index


def _spans(spanner, timeline: dict[int, list[tuple[float, float]]]
           ) -> list[tuple[float, float, float]]:
    """Each stretch of the timeline one spanner covers: (first onset, last
    onset, where the last note stops sounding).

    A spanner in a repeated passage covers it once per pass: every copy of its
    first note is paired with the next copy of its last.
    """
    elements = list(spanner.getSpannedElements())
    if not elements:
        return []
    lasts = sorted(timeline.get(id(elements[-1]), []))
    spans = []
    for first, _ in sorted(timeline.get(id(elements[0]), [])):
        last = next(((beat, length) for beat, length in lasts if beat >= first - 1e-6), None)
        if last is not None:
            spans.append((first, last[0], last[0] + last[1]))
    return spans


def _slurs(part) -> list[tuple[float, float]]:
    """Each slur in this part as the span of beats it joins."""
    timeline = _timeline(part)
    return [(first, last) for slur in part.spannerBundle.getByClass(music21.spanner.Slur)
            for first, last, _ in _spans(slur, timeline) if last > first]


def _extract_events(score: music21.stream.Score, score_id: str) -> list[ScoreEvent]:
    """按声部提取 ScoreEvent；和弦合并；装饰音标记 optional。

    A tied note is one note however many times it is written. The second half
    of a tie is folded into the note it continues, so a player who holds it —
    as the page asks — is not told they missed a note they were never meant to
    strike again.
    """
    events: list[ScoreEvent] = []
    for p_idx, part in enumerate(score.parts):
        part_name = _detect_part_name(part, p_idx)
        part_events: list[ScoreEvent] = []
        # (timeline beat, voice, pitch, length, marks) for each tie continuation
        held: list[tuple[float, int, int, float, list[str]]] = []
        # 展平到 measure 层级，按 (measure, onset) 聚合和弦
        measures = part.getElementsByClass(music21.stream.Measure)
        for m_no, meas in enumerate(measures, start=1):
            # measure 内 offset（quarterLength），转为拍
            groups: dict[tuple[float, int], dict] = {}
            for el in meas.recurse().notesAndRests:
                if el.isRest:
                    continue
                onset_q = float(el.offset)
                voice_context = el.getContextByClass(music21.stream.Voice)
                try:
                    voice = int(voice_context.id) if voice_context is not None else 1
                except (TypeError, ValueError):
                    voice = 1
                key = (onset_q, voice)
                if key not in groups:
                    groups[key] = {"pitches": [], "dur": 0.0,
                                   "optional": False, "voice": voice,
                                   "dynamicTargets": [], "marks": []}
                g = groups[key]
                length = float(el.duration.quarterLength)
                marks = _articulations(el)
                for note in (el.notes if el.isChord else [el]):
                    if _continues_a_tie(note):
                        held.append((float(meas.offset) + onset_q, voice,
                                     note.pitch.midi, length, marks))
                    else:
                        g["pitches"].append(note.pitch.midi)
                        g["dur"] = max(g["dur"], length)
                if el.duration.isGrace:
                    g["optional"] = True
                g["marks"].extend(marks)
                dynamic_target = _dynamic_target(el)
                if dynamic_target is not None:
                    g["dynamicTargets"].append(dynamic_target)
            for idx, (onset_q, voice) in enumerate(sorted(groups)):
                g = groups[(onset_q, voice)]
                if not g["pitches"]:
                    continue
                onset_token = re.sub(r"\.", "_", f"{onset_q:g}")
                part_events.append(ScoreEvent(
                    eventId=f"{score_id}:{part_name}:m{m_no}:b{onset_token}:{idx}",
                    measureNo=m_no,
                    onsetBeat=onset_q,
                    absoluteBeat=float(meas.offset) + onset_q,
                    durationBeat=g["dur"],
                    pitches=sorted(set(g["pitches"])),
                    part=part_name,
                    voice=g["voice"],
                    dynamicTarget=(round(sum(g["dynamicTargets"]) /
                                         len(g["dynamicTargets"]))
                                   if g["dynamicTargets"] else None),
                    optional=g["optional"],
                    articulations=sorted(set(g["marks"])),
                ))
        _fold_ties(part_events, held)
        _mark_legato(part_events, _slurs(part))
        events.extend(part_events)
    # 全局按 (measure, onset, part) 排序
    events.sort(key=lambda e: (e.measureNo, e.onsetBeat, 0 if e.part == "RH" else 1))
    return events


def _fold_ties(events: list[ScoreEvent],
               held: list[tuple[float, int, int, float, list[str]]]) -> None:
    """Lengthen each tied note by the notes that continue it.

    Continuations are applied in timeline order, so a note tied across three
    bars grows one bar at a time. A fermata written on the held half belongs
    to the note that is sounding.
    """
    for beat, voice, pitch, length, marks in sorted(held):
        origin = next((event for event in reversed(events)
                       if pitch in event.pitches and event.voice == voice
                       and abs((event.absoluteBeat or 0) + event.durationBeat - beat) < 1e-6),
                      None)
        if origin is None:
            # A tie with nothing to continue — sloppy export. Keep the note.
            continue
        origin.durationBeat += length
        if "fermata" in marks and "fermata" not in origin.articulations:
            origin.articulations = sorted([*origin.articulations, "fermata"])


def _mark_legato(events: list[ScoreEvent], slurs: list[tuple[float, float]]) -> None:
    """Mark each note a slur joins to the next note of its voice."""
    if not slurs:
        return
    by_voice: dict[int, list[ScoreEvent]] = {}
    for event in events:
        by_voice.setdefault(event.voice, []).append(event)
    for voice_events in by_voice.values():
        voice_events.sort(key=lambda event: event.absoluteBeat or 0)
        for current, following in zip(voice_events, voice_events[1:]):
            start, end = current.absoluteBeat or 0, following.absoluteBeat or 0
            current.legatoToNext = any(
                first - 1e-6 <= start and end <= last + 1e-6 for first, last in slurs)


_SLOWING = re.compile(r"\b(rit|ritard|ritardando|rall|rallentando|allarg|allargando|"
                      r"calando|morendo|smorz|smorzando|slower)\b", re.IGNORECASE)
_SPEEDING = re.compile(r"\b(accel|accelerando|stringendo|string|faster)\b", re.IGNORECASE)
_RESUMING = re.compile(r"\b(a tempo|tempo primo|tempo i|tempo 1)\b", re.IGNORECASE)


def _timeline_beat(element, part) -> float | None:
    """Where a direction (a mark, a word) sits on the performance timeline."""
    try:
        return float(element.getOffsetInHierarchy(part))
    except (music21.sites.SitesException, AttributeError):
        return None


def tempo_plan(score: music21.stream.Score, initial_bpm: float) -> list[TempoSpan]:
    """The written tempo through the piece: metronome marks and tempo words.

    A later metronome mark starts a new steady tempo. *rit.* and *rall.* start
    a slowing stretch and *accel.* a quickening one, each running until the
    next mark or *a tempo*, which returns to the last steady tempo.
    """
    parts = list(score.parts)
    if not parts:
        return [TempoSpan(startBeat=0.0, bpm=initial_bpm)]
    part = parts[0]
    cues: list[tuple[float, int, str, float | None]] = []
    for element in part.recurse().getElementsByClass(
            (music21.tempo.MetronomeMark, music21.expressions.TextExpression)):
        beat = _timeline_beat(element, part)
        if beat is None:
            continue
        if isinstance(element, music21.tempo.MetronomeMark):
            if element.number:
                cues.append((beat, 0, "mark", float(element.number)))
            continue
        words = str(getattr(element, "content", "") or "")
        if _RESUMING.search(words):
            cues.append((beat, 1, "resume", None))
        elif _SLOWING.search(words):
            cues.append((beat, 2, "slowing", None))
        elif _SPEEDING.search(words):
            cues.append((beat, 2, "speeding", None))
    plan = [TempoSpan(startBeat=0.0, bpm=initial_bpm)]
    steady = initial_bpm
    for beat, _order, kind, bpm in sorted(cues):
        if kind == "mark":
            steady = bpm or steady
            span = TempoSpan(startBeat=beat, bpm=steady)
        elif kind == "resume":
            span = TempoSpan(startBeat=beat, bpm=steady)
        else:
            span = TempoSpan(startBeat=beat, bpm=plan[-1].bpm, shape=kind)
        if abs(plan[-1].startBeat - beat) < 1e-6:
            # Two cues on one beat: a mark and its "a tempo" say one thing.
            if kind in ("resume",) and plan[-1].shape == "steady":
                continue
            plan[-1] = span
        else:
            plan.append(span)
    return plan


def hairpins(score: music21.stream.Score) -> list[Hairpin]:
    """Every written crescendo and diminuendo, as the beats it spans."""
    found: list[Hairpin] = []
    for part in score.parts:
        timeline = _timeline(part)
        for wedge in part.spannerBundle.getByClass(music21.dynamics.DynamicWedge):
            kind = ("crescendo" if isinstance(wedge, music21.dynamics.Crescendo)
                    else "diminuendo" if isinstance(wedge, music21.dynamics.Diminuendo)
                    else None)
            if kind is None:
                continue
            found.extend(Hairpin(startBeat=start, endBeat=end, kind=kind)
                         for start, _, end in _spans(wedge, timeline) if end > start)
    return sorted(found, key=lambda hairpin: hairpin.startBeat)


def export_reference_midi(bundle: ScoreBundle, out_path) -> None:
    """从 ScoreEvent 生成参考 MIDI（reference.mid），供播放/伴奏基线。"""
    import mido

    mid = mido.MidiFile(ticks_per_beat=480)
    track = mido.MidiTrack()
    mid.tracks.append(track)
    sec_per_beat = 60.0 / bundle.meta.tempo
    track.append(mido.MetaMessage("set_tempo", tempo=int(sec_per_beat * 1_000_000), time=0))

    # 全局拍点 = measureNo-1 小节偏移 + onsetBeat
    bpm_ = bundle.meta.beatsPerMeasure
    msgs = []
    for e in bundle.events:
        if e.optional:
            continue
        abs_beat = (e.absoluteBeat if e.absoluteBeat is not None else
                    (e.measureNo - 1) * bpm_ + e.onsetBeat)
        for p in e.pitches:
            msgs.append((abs_beat, 1, p, 72))                      # note_on
            msgs.append((abs_beat + e.durationBeat, 0, p, 0))      # note_off
    msgs.sort(key=lambda m: (m[0], m[1]))
    last = 0.0
    for beat, on, pitch, vel in msgs:
        delta = int(round((beat - last) * 480))
        last = beat
        track.append(mido.Message("note_on" if on else "note_off",
                                  note=pitch, velocity=vel, time=max(0, delta)))
    track.append(mido.MetaMessage("end_of_track", time=0))
    mid.save(out_path)
