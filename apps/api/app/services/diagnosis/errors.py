"""错误检测（方案 5.6）：从对齐路径生成 Evidence 与 ErrorEvent。

对齐在 onset 层（多声部音高并集）完成，分类阶段分配到声部事件：
- 声部事件音高全部缺失 → 漏音（missed_note）
- 声部事件音高部分错误/缺失 → 错音（wrong_pitch）
- onset 期望音全弹出但有额外音 → 多音（extra_note）
- 演奏组无法对应任何 onset（Insert）→ 多音
- |onset residual| > max(80ms, 0.12 beat) → 提前/延后（early_late）
- |duration ratio − 1| > 0.35 → 时值异常（duration_anomaly）
- 4 拍滑窗 BPM CV>8% / 连续减速>12% / 整体偏离标称>10% → 速度不稳
  （相对每处的书面速度；rit./accel. 段落不计）
- 乐谱没写的停顿、回头重弹 → 犹豫（hesitation，见 fluency.py）
- 断奏、连线、重音、渐强渐弱记号 → 见 expression.py

特殊处理：和弦不同步（某音延迟超过 70ms 窗口形成独立演奏组）=
Substitute(缺音) + Insert(延迟音) → 合并为 early_late（低严重度），
避免误报多音/错音。
"""
from __future__ import annotations

import statistics
from dataclasses import dataclass

from app.schemas.models import (AlignmentPair, AlignOp, ErrorEvent, ErrorType,
                                Evidence, PerformanceGroup, Severity, TempoPoint)
from app.services.alignment.onset import ScoreOnset, score_onset_beat
from app.services.alignment.tempo import TempoMap, local_bpm_series
from app.i18n import Msg, msg
from app.services.diagnosis.confidence import confidence
from app.services.diagnosis.expression import Shaping, judge_shaping
from app.services.diagnosis.fluency import find_pauses, report_restarts
from app.services.diagnosis.ledger import Ledger, pitch_name, pitch_set_str  # noqa: F401
from app.services.diagnosis.take import SHORT_MARKS, Take


@dataclass
class Findings:
    errors: list[ErrorEvent]
    evidences: list[Evidence]
    shaping: Shaping
    #: Onsets that came straight after an unwritten stop, and how long it ran (ms).
    after_pause: dict[str, float]
    replays: int
    #: Onsets a restart went back to, and how long the abandoned attempt took (ms).
    went_back_to: dict[str, float]
    #: When each written note actually arrived: onset → pitch → (group, ms).
    #: A chord played apart lands in several groups, and a note the chord
    #: window swept into the next group still belongs here; this is the one
    #: record of where every written note went.
    arrivals: dict[str, dict[int, tuple[str, float]]]

    @property
    def stops(self) -> dict[str, float]:
        """Every gap the music stopped for, by the onset after it."""
        return {**self.went_back_to, **self.after_pause}


_SEVERITY_ORDER = {Severity.high: 0, Severity.medium: 1, Severity.low: 2}


def classify_errors(take: Take,
                    include_duration_errors: bool = True,
                    duration_tolerance: float = .35,
                    include_dynamics_errors: bool = True,
                    has_notated_dynamics: bool = False,
                    ) -> Findings:
    pairs = take.pairs
    onset_index = take.onsets
    group_index = take.groups
    tempo_map = take.tempo_map
    beats_per_measure = take.beats_per_measure
    bpm = take.bpm
    group_pitch_onsets = take.pitch_onsets
    ctx = Ledger(take.measure_labels)
    beat_ms = 60000.0 / bpm
    timing_threshold = max(80.0, 0.12 * beat_ms)

    # A stop and a passage begun again are each one event. Name them first:
    # the note after a stop is not also "late".
    went_back_to = report_restarts(ctx, take, take.restarts)
    after_pause = find_pauses(ctx, take, explained=went_back_to)

    # 局部趋势修正残差：残差减去 ±2 拍邻域中位数。
    # 持续性的局部变速（拖拍段）被邻域吸收 → 不报单音提前/延后；
    # 孤立抢拍/拖拍相对邻域突出 → 正常报出。
    adjusted = _adjusted_residuals(pairs, onset_index, beats_per_measure)

    inserts = [p for p in pairs if p.operation == AlignOp.insert]
    absorbed_inserts: set[str] = set()
    matched_onsets: list[tuple[ScoreOnset, PerformanceGroup, AlignmentPair]] = []

    def onset_beat_abs(o: ScoreOnset) -> float:
        return score_onset_beat(o, beats_per_measure)

    # ---- 组分裂重分配 ----
    # 演奏组被 70ms 和弦窗口合并时，可能同时覆盖两个相邻 onset
    # （如某音延后 200ms 与下一音合并）。若 substitute 的多余音恰好能
    # 解释邻近的 Delete onset，则把这些音重分配给该 onset：
    # Delete → Match（按实际 onset 计时），原 onset 不再报多音。
    delete_pairs = {p.scoreEventId: p for p in pairs
                    if p.operation == AlignOp.delete and p.scoreEventId in onset_index}
    reassigned: dict[str, tuple[str, float]] = {}   # onsetId → (groupId, residMs)
    arrivals: dict[str, dict[int, tuple[str, float]]] = {}
    consumed_extra: dict[str, set[int]] = {}        # groupId → 被重分配的音高
    for p in pairs:
        if p.operation != AlignOp.substitute:
            continue
        o = onset_index.get(p.scoreEventId or "")
        g = group_index.get(p.performanceId or "")
        if not o or not g:
            continue
        extra_here = sorted(set(g.pitches) - set(o.pitches))
        if not extra_here:
            continue
        o_beat = onset_beat_abs(o)
        for d_pid in list(delete_pairs):
            d_o = onset_index[d_pid]
            d_beat = onset_beat_abs(d_o)
            if not (0 < o_beat - d_beat <= 1.5):
                continue
            if not set(d_o.pitches) <= set(extra_here):
                continue
            gpo = (group_pitch_onsets or {}).get(g.id, {})
            act = min((gpo.get(pt, g.tOnMs) for pt in d_o.pitches),
                      default=g.tOnMs)
            resid = act - tempo_map.expected_ms(d_beat)
            if abs(resid) > 1.2 * beat_ms:
                continue
            reassigned[d_o.onsetId] = (g.id, resid)
            arrivals[d_o.onsetId] = {pitch: (g.id, gpo.get(pitch, g.tOnMs))
                                     for pitch in d_o.pitches}
            consumed_extra.setdefault(g.id, set()).update(d_o.pitches)
            del delete_pairs[d_pid]
            break

    for p in pairs:
        if p.operation == AlignOp.insert:
            continue
        o = onset_index.get(p.scoreEventId or "")
        g = group_index.get(p.performanceId or "")
        if not o:
            continue

        # ---------- Delete：整 onset 未演奏 ----------
        if p.operation == AlignOp.delete:
            if o.onsetId in reassigned:
                # 被合并组重分配认领：音弹了但时间偏移
                _, resid = reassigned[o.onsetId]
                if abs(resid) > timing_threshold:
                    _report_timing(ctx, o, resid)
                continue
            for m in o.members:
                if m.optional:
                    continue
                ev_id = _missed_evidence(ctx, o, m)
                ctx.add_error(ErrorType.missed_note, o.measureNo, o.onsetBeat,
                              [m.eventId], Severity.high, [ev_id])
            continue

        if not g:
            continue
        matched_onsets.append((o, g, p))
        arrivals[o.onsetId] = {pitch: (g.id, group_pitch_onsets[g.id].get(pitch, g.tOnMs))
                               for pitch in o.pitches if pitch in g.pitches}

        missing = sorted(set(o.pitches) - set(g.pitches))
        extra = sorted(set(g.pitches) - set(o.pitches)
                       - consumed_extra.get(g.id, set()))

        # ---------- 和弦不同步吸收：缺音在邻近 Insert 组中 ----------
        # 一个琶音和弦会被拆成任意多个演奏组，不只两个：C 在 0ms、E 在 60ms、
        # G 在 130ms 是业余演奏的常态，浪漫派钢琴曲里更是写明的奏法。所以这里
        # 遍历所有 Insert 组直到缺音被认领完，而不是认领一个就停手 —— 后者会把
        # 同一个和弦的第三个音同时报成"多音"和"错音"。
        #
        # 组内音高也不要求全部属于缺音集合：转写常在真实音上多报一个泛音，
        # 严格子集判断会因为这一个幽灵音而放弃整组，级联误报随之回来。取交集
        # 认领，剩下的音仍按多音处理。
        if missing and p.operation == AlignOp.substitute:
            absorbed = False
            worst_delta = 0.0
            worst_pitches: list[int] = []
            exp_ms = tempo_map.expected_ms(onset_beat_abs(o))
            for ins in inserts:
                if not missing:
                    break
                if ins.performanceId in absorbed_inserts:
                    continue
                g_ins = group_index.get(ins.performanceId or "")
                if not g_ins:
                    continue
                claimed = sorted(set(g_ins.pitches) & set(missing)
                                 - consumed_extra.get(g_ins.id, set()))
                if not claimed:
                    continue
                delta = g_ins.tOnMs - exp_ms
                if abs(delta) > 1.0 * beat_ms:
                    continue
                missing = sorted(set(missing) - set(claimed))
                absorbed = True
                for pitch in claimed:
                    arrivals[o.onsetId][pitch] = (
                        g_ins.id, group_pitch_onsets[g_ins.id].get(pitch, g_ins.tOnMs))
                # 整组都被认领才算吸收；只认领了一部分时，组仍要走多音分支，
                # 由 consumed_extra 把已认领的音扣掉，避免重复报。
                if set(claimed) >= set(g_ins.pitches):
                    absorbed_inserts.add(ins.performanceId)
                else:
                    consumed_extra.setdefault(g_ins.id, set()).update(claimed)
                if abs(delta) > abs(worst_delta):
                    worst_delta = delta
                    worst_pitches = claimed
            # 偏移超过和弦窗口 → 真正的和弦不同步。整个和弦只报一条：三个音
            # 各报一次，等于把一次琶音说成三个毛病。
            if absorbed and abs(worst_delta) > 70.0:
                member_ids = [m.eventId for m in o.members
                              if set(m.pitches) & set(worst_pitches)]
                ev_id = ctx.add_evidence(
                    o.measureNo, o.onsetBeat,
                    msg("fact.chordSpread", pitches=pitch_set_str(worst_pitches),
                        direction=_direction(worst_delta), ms=f"{abs(worst_delta):.0f}"),
                    expected=msg("word.chordTogether"),
                    actual=msg("word.offsetMs", ms=f"{worst_delta:+.0f}"),
                    delta_ms=worst_delta)
                ctx.add_error(ErrorType.early_late, o.measureNo, o.onsetBeat,
                              member_ids, Severity.low, [ev_id],
                              msg("detail.chordSpread"))
            if absorbed and not missing and not extra:
                flagged_timing = (o.onsetId not in after_pause and
                                  _maybe_timing(ctx, o, p, timing_threshold, adjusted))
                if not flagged_timing:
                    if include_duration_errors:
                        _maybe_duration(ctx, take, o, arrivals.get(o.onsetId, {}), duration_tolerance)
                continue

        # ---------- 音高类错误 ----------
        if p.operation == AlignOp.substitute:
            if not missing and extra:
                # 期望音全弹出但多了音 → 多音
                ev_id = ctx.add_evidence(
                    o.measureNo, o.onsetBeat,
                    msg("fact.extraInChord", **ctx.at(o), extra=pitch_set_str(extra),
                        expected=pitch_set_str(o.pitches)),
                    expected=pitch_set_str(o.pitches), actual=pitch_set_str(g.pitches),
                    expected_pitches=o.pitches, actual_pitches=g.pitches)
                ctx.add_error(ErrorType.extra_note, o.measureNo, o.onsetBeat,
                              [m.eventId for m in o.members], Severity.medium, [ev_id])
            else:
                # 逐声部判定：整声部缺失且无替换音 → 漏音；其余 → 错音
                for m in o.members:
                    if m.optional:
                        continue
                    m_missing = sorted(set(m.pitches) - set(g.pitches))
                    if not m_missing:
                        continue
                    if len(m_missing) == len(set(m.pitches)) and not extra:
                        ev_id = _missed_evidence(ctx, o, m)
                        ctx.add_error(ErrorType.missed_note, o.measureNo, o.onsetBeat,
                                      [m.eventId], Severity.high, [ev_id])
                    else:
                        ev_id = ctx.add_evidence(
                            o.measureNo, o.onsetBeat,
                            msg("fact.wrongPitch", **ctx.at(o),
                                expected=pitch_set_str(m.pitches),
                                actual=pitch_set_str(g.pitches)),
                            expected=pitch_set_str(m.pitches),
                            actual=pitch_set_str(g.pitches),
                            expected_pitches=m.pitches, actual_pitches=g.pitches)
                        sev = Severity.high if p.cost >= 0.85 else Severity.medium
                        ctx.add_error(ErrorType.wrong_pitch, o.measureNo, o.onsetBeat,
                                      [m.eventId], sev, [ev_id])
                if extra and missing:
                    # 替换场景：多出的音视为错音一部分，不另报多音
                    pass

        # ---------- 时间与时值 ----------
        flagged_timing = (o.onsetId not in after_pause and
                          _maybe_timing(ctx, o, p, timing_threshold, adjusted))
        if not flagged_timing:
            if include_duration_errors:
                _maybe_duration(ctx, take, o, arrivals.get(o.onsetId, {}), duration_tolerance)

    # ---------- 未吸收的 Insert → 多音 ----------
    for ins in inserts:
        if ins.performanceId in absorbed_inserts:
            continue
        g = group_index.get(ins.performanceId or "")
        if not g:
            continue
        # 组里可能有音已经被和弦不同步吸收认领过（琶音里迟到的和弦音），
        # 那部分已按 early_late 报过一次，这里不能再当多音报第二次。
        remaining = sorted(set(g.pitches) - consumed_extra.get(g.id, set()))
        if not remaining:
            continue
        near_measure, near_beat = _nearest_score_position(
            g, onset_index, beats_per_measure, tempo_map)
        ev_id = ctx.add_evidence(
            near_measure, near_beat,
            msg("fact.extraNear", bar=ctx.label(near_measure),
                pitches=pitch_set_str(remaining)),
            expected=msg("word.noSuchNote"), actual=pitch_set_str(remaining),
            actual_pitches=remaining)
        ctx.add_error(ErrorType.extra_note, near_measure, near_beat,
                      [], Severity.medium, [ev_id],
                      msg("detail.extra", pitches=pitch_set_str(remaining)))

    # ---------- 速度不稳 ----------
    _tempo_instability(ctx, take, {**went_back_to, **after_pause})

    # ---------- 奏法与表情记号 ----------
    shaping = judge_shaping(ctx, take)

    # ---------- 力度 ----------
    # Velocity is evaluated only after alignment, so one hard/soft or accidental
    # press remains attached to its local score position and cannot shift the
    # surrounding note sequence.
    if include_dynamics_errors:
        _dynamics_anomalies(ctx, [item for item in matched_onsets
                                  if item[0].onsetId not in shaping.accented_onsets],
                            has_notated_dynamics=has_notated_dynamics)

    # ---------- 回填跨重复一致性 ----------
    type_counts: dict[ErrorType, int] = {}
    for e in ctx.errors:
        type_counts[e.type] = type_counts.get(e.type, 0) + 1
    for e in ctx.errors:
        e.confidence = confidence(e.type, len(e.evidenceIds),
                                  type_counts.get(e.type, 1))
    # In the order a player meets them on the page. The first is where the
    # report says to start, so it must be the first problem, not the first
    # rule that happened to run.
    errors = sorted(ctx.errors, key=lambda e: (
        e.location["measure"], e.location["beat"], _SEVERITY_ORDER[e.severity]))
    for number, error in enumerate(errors, start=1):
        error.id = f"err_{number:04d}"
    evidences = sorted(ctx.evidences, key=lambda ev: (ev.measureNo, ev.beat))
    return Findings(errors=errors, evidences=evidences, shaping=shaping,
                    after_pause=after_pause, replays=len(went_back_to),
                    went_back_to=went_back_to, arrivals=arrivals)


def _median_velocity(group: PerformanceGroup) -> float | None:
    values = [value for value in group.velocities if value > 0]
    return statistics.median(values) if values else None


def _dynamics_anomalies(
        ctx: Ledger,
        matched_onsets: list[tuple[ScoreOnset, PerformanceGroup, AlignmentPair]],
        target_tolerance: float = 18.0,
        outlier_floor: float = 22.0,
        has_notated_dynamics: bool = False) -> None:
    """Compare velocity against the page, or failing that against this take.

    ``dynamicTarget`` carries two different things depending on the source: a
    written p/mf/f from MusicXML, and a recorded note velocity from a MIDI
    import. Only the first is an instruction the player can be held to — a MIDI
    file's velocities describe how one person happened to play it, so grading
    against them flagged every note of a flawless take.
    """
    reliable: list[tuple[ScoreOnset, PerformanceGroup, float, float | None]] = []
    for onset, group, pair in matched_onsets:
        # Do not mix a pitch substitution into a velocity judgement.
        if pair.operation != AlignOp.match or set(onset.pitches) != set(group.pitches):
            continue
        actual = _median_velocity(group)
        if actual is None:
            continue
        targets = [member.dynamicTarget for member in onset.members
                   if member.dynamicTarget is not None]
        target = statistics.median(targets) if targets else None
        reliable.append((onset, group, actual, target))

    explicit = [item for item in reliable if item[3] is not None] \
        if has_notated_dynamics else []
    if explicit:
        for onset, _group, actual, target_value in explicit:
            target = float(target_value or 0)
            delta = actual - target
            if abs(delta) < target_tolerance:
                continue
            direction = msg("word.louder" if delta > 0 else "word.softer")
            severity = Severity.high if abs(delta) >= 30 else Severity.medium
            evidence_id = ctx.add_evidence(
                onset.measureNo, onset.onsetBeat,
                msg("fact.dynamicsTarget", target=f"{target:.0f}", actual=f"{actual:.0f}",
                    delta=f"{delta:+.0f}", direction=direction),
                expected=f"MIDI velocity {target:.0f}",
                actual=f"MIDI velocity {actual:.0f}",
                delta_velocity=round(delta, 1),
            )
            ctx.add_error(
                ErrorType.dynamics_anomaly, onset.measureNo, onset.onsetBeat,
                [member.eventId for member in onset.members], severity,
                [evidence_id],
                msg("detail.dynamics", direction=direction, amount=f"{abs(delta):.0f}"),
            )
        return

    # With no explicit score dynamic, report only isolated, very large attacks
    # relative to this same take. This is labelled as consistency evidence—not
    # as an invented notation target.
    if len(reliable) < 8:
        return
    velocities = [item[2] for item in reliable]
    centre = statistics.median(velocities)
    mad = statistics.median(abs(value - centre) for value in velocities)
    threshold = max(outlier_floor, 4.0 * mad + 8.0)
    for onset, _group, actual, _target in reliable:
        delta = actual - centre
        if abs(delta) < threshold:
            continue
        direction = msg("word.suddenlyLouder" if delta > 0 else "word.suddenlySofter")
        evidence_id = ctx.add_evidence(
            onset.measureNo, onset.onsetBeat,
            msg("fact.dynamicsOutlier", centre=f"{centre:.0f}", actual=f"{actual:.0f}",
                delta=f"{delta:+.0f}", direction=direction),
            expected=msg("word.takeMedianVelocity", value=f"{centre:.0f}"),
            actual=f"MIDI velocity {actual:.0f}",
            delta_velocity=round(delta, 1),
        )
        ctx.add_error(
            ErrorType.dynamics_anomaly, onset.measureNo, onset.onsetBeat,
            [member.eventId for member in onset.members], Severity.low,
            [evidence_id],
            msg("detail.dynamicsOutlier", direction=direction, amount=f"{abs(delta):.0f}"),
        )


def _maybe_timing(ctx: Ledger, o: ScoreOnset, p: AlignmentPair,
                  threshold: float,
                  adjusted: dict[str, float] | None = None) -> bool:
    resid = (adjusted or {}).get(p.scoreEventId or "", p.onsetResidualMs)
    if abs(resid) <= threshold:
        return False
    _report_timing(ctx, o, resid)
    return True


def _direction(delta_ms: float) -> Msg:
    return msg("word.early" if delta_ms < 0 else "word.late")


def _report_timing(ctx: Ledger, o: ScoreOnset, resid: float) -> None:
    sev = Severity.high if abs(resid) > 200 else Severity.medium
    ev_id = ctx.add_evidence(
        o.measureNo, o.onsetBeat,
        msg("fact.timing", direction=_direction(resid), ms=f"{abs(resid):.0f}"),
        expected="0 ms", actual=f"{resid:+.0f} ms", delta_ms=resid)
    ctx.add_error(ErrorType.early_late, o.measureNo, o.onsetBeat,
                  [m.eventId for m in o.members], sev, [ev_id],
                  msg("detail.timingAt", **ctx.at(o), direction=_direction(resid)))


def _missed_evidence(ctx: Ledger, o: ScoreOnset, member) -> str:
    return ctx.add_evidence(
        o.measureNo, o.onsetBeat,
        msg("fact.missed", bar=ctx.label(o.measureNo),
            hand=msg("word.rightHand" if member.part == "RH" else "word.leftHand"),
            pitches=pitch_set_str(member.pitches)),
        expected=pitch_set_str(member.pitches), actual=msg("word.notPlayed"),
        expected_pitches=member.pitches)


def _beats(value: float, fmt: str) -> Msg:
    shown = format(value, fmt)
    return msg("word.beatOne" if shown == "1" else "word.beats", n=shown)


def _maybe_duration(ctx: Ledger, take: Take, o: ScoreOnset,
                    arrived: dict[int, tuple[str, float]],
                    tolerance: float = .35) -> None:
    """Judge how long each hand held its own notes against their own value.

    Per hand, not per chord: a right-hand crotchet over a left-hand semibreve
    is two lengths, and holding the crotchet for a crotchet is correct however
    long the other hand holds on.

    Length is the smallest thing a note can get wrong. A note already named
    for its pitch or its timing — a correction struck late and so held short
    — is not named again for the length that followed from it.
    """
    if any(error.location["measure"] == o.measureNo and error.location["beat"] == o.onsetBeat
           for error in ctx.errors):
        return
    worst: tuple[float, float] | None = None       # (durationBeat, ratio)
    # The player's own pulse around this note, not the tempo map's slope: a
    # stop right after a long note stretches the map there, and the note would
    # be judged against a beat nobody played.
    ms_per_beat = take.local_ms_per_beat(take.beat(o))
    for member in o.members:
        # A staccato is meant to be short and has its own rule; a fermata is
        # held as long as the player chooses.
        if member.optional or set(member.articulations) & (SHORT_MARKS | {"fermata"}):
            continue
        notes = [note for pitch in member.pitches if pitch in arrived
                 for note in take.notes_in(take.groups[arrived[pitch][0]], [pitch])]
        held = [note.tOffMs - note.tOnMs for note in notes if note.tOffMs > note.tOnMs]
        if not held:
            continue
        ratio = max(held) / max(1.0, member.durationBeat * ms_per_beat)
        # Let go of the key with the pedal down and the note keeps sounding:
        # the key was short, the note was not.
        if ratio < 1.0 and any(note.pedalAtRelease for note in notes):
            continue
        if abs(ratio - 1.0) > tolerance and (worst is None or abs(ratio - 1) > abs(worst[1] - 1)):
            worst = (member.durationBeat, ratio)
    if worst is None:
        return
    value, ratio = worst
    ev_id = ctx.add_evidence(
        o.measureNo, o.onsetBeat,
        msg("fact.duration", expected=_beats(value, "g"),
            actual=_beats(value * ratio, ".2f")),
        expected=_beats(value, "g"), actual=_beats(value * ratio, ".2f"))
    ctx.add_error(ErrorType.duration_anomaly, o.measureNo, o.onsetBeat,
                  [m.eventId for m in o.members], Severity.low, [ev_id])


def _tempo_instability(ctx: Ledger, take: Take, stops: dict[str, float]) -> None:
    """Judge the pulse against the tempo the page asks for at each point.

    Every played tempo is read as a share of the written one there, so a new
    metronome mark is not a lapse, and the stretches under a written *rit.* or
    *accel.* are left out: slowing there is reading the page.
    """
    written = take.written
    beats_ms = [(beat, ms, onset.measureNo)
                for beat, ms, onset in take.played_without_stops(stops)]
    if len(beats_ms) < 4:
        return
    series = [(beat, value) for beat, value in local_bpm_series([(b, m) for b, m, _ in beats_ms])
              if written.steady_around(beat, 2.0)]
    if len(series) < 3:
        return
    bpms = [v for _, v in series]
    ratios = [v / written.bpm_at(b) for b, v in series]
    mean_ratio = statistics.mean(ratios)
    cv = statistics.pstdev(ratios) / mean_ratio if mean_ratio else 0.0
    third = max(1, len(ratios) // 3)
    first_third = statistics.mean(ratios[:third])
    last_third = statistics.mean(ratios[-third:])
    slowdown = (first_third - last_third) / first_third if first_third else 0.0
    overall_dev = abs(mean_ratio - 1.0)
    first_bpm = statistics.mean(bpms[:third])
    last_bpm = statistics.mean(bpms[-third:])
    mean_bpm = statistics.mean(bpms)
    marked = written.mean_bpm(series[0][0], series[-1][0])

    # 局部段落偏离：任一滑窗相对整体中位数偏离 >12%（局部拖拍段）
    med_ratio = statistics.median(ratios)
    deviations = [abs(r - med_ratio) / med_ratio for r in ratios]
    seg_dev = max(deviations, default=0.0)
    worst = deviations.index(seg_dev)
    seg_beat = series[worst][0]
    # beat → measure：找最近的锚点小节
    seg_measure = min(beats_ms, key=lambda t: abs(t[0] - seg_beat))[2]

    m_start = min(m for _, _, m in beats_ms)
    m_end = max(m for _, _, m in beats_ms)
    loc_measure = m_start
    if cv > 0.08 or slowdown > 0.12 or overall_dev > 0.10 or seg_dev > 0.12:
        span = {"start": ctx.label(m_start), "end": ctx.label(m_end)}
        detail = msg("detail.barSpan", **span)
        if slowdown > 0.12:
            fact = msg("fact.slowdown", **span, **{"from": f"{first_bpm:.0f}"},
                       to=f"{last_bpm:.0f}", pct=f"{slowdown * 100:.0f}")
            loc_measure = m_start
        elif seg_dev > 0.12:
            fact = msg("fact.localTempo", bar=ctx.label(seg_measure),
                       slowest=f"{min(bpms):.0f}", median=f"{statistics.median(bpms):.0f}",
                       pct=f"{seg_dev * 100:.0f}")
            loc_measure = seg_measure
        elif overall_dev > 0.10:
            direction = msg("word.slower" if mean_ratio < 1 else "word.faster")
            fact = msg("fact.overallTempo", mean=f"{mean_bpm:.0f}", marked=f"{marked:.0f}",
                       direction=direction, pct=f"{overall_dev * 100:.0f}")
            # A steady take at a slower tempo is a tempo *choice*, not shaky
            # playing — and it is exactly what the slow-practice exercises ask
            # for. Say which one it is instead of calling both "unstable".
            detail = msg("detail.overallTempo", **span, direction=direction,
                         pct=f"{overall_dev * 100:.0f}")
        else:
            fact = msg("fact.tempoSpread", cv=f"{cv * 100:.1f}",
                       low=f"{min(bpms):.0f}", high=f"{max(bpms):.0f}")
        ev_id = ctx.add_evidence(loc_measure, 0.0, fact,
                                 expected=msg("word.steadyBpm", bpm=f"{marked:.0f}"),
                                 actual=f"{min(bpms):.0f}–{max(bpms):.0f} BPM")
        ctx.add_error(ErrorType.tempo_instability, loc_measure, 0.0, [],
                      Severity.medium, [ev_id], detail)


def _nearest_score_position(g: PerformanceGroup,
                            onset_index: dict[str, ScoreOnset],
                            beats_per_measure: float,
                            tempo_map: TempoMap) -> tuple[int, float]:
    best = (1, 0.0)
    best_d = float("inf")
    for o in onset_index.values():
        beat = score_onset_beat(o, beats_per_measure)
        d = abs(tempo_map.expected_ms(beat) - g.tOnMs)
        if d < best_d:
            best_d = d
            best = (o.measureNo, o.onsetBeat)
    return best


def _adjusted_residuals(pairs: list[AlignmentPair],
                        onset_index: dict[str, ScoreOnset],
                        beats_per_measure: float,
                        window_beats: float = 2.0) -> dict[str, float]:
    """onsetId → 局部趋势修正后的残差（resid − 邻域中位数）。"""
    pts: list[tuple[float, str, float]] = []
    for p in pairs:
        if p.operation not in (AlignOp.match, AlignOp.substitute):
            continue
        o = onset_index.get(p.scoreEventId or "")
        if not o:
            continue
        beat = score_onset_beat(o, beats_per_measure)
        pts.append((beat, o.onsetId, p.onsetResidualMs))
    pts.sort()
    out: dict[str, float] = {}
    residuals = [r for _, _, r in pts]
    global_med = statistics.median(residuals) if residuals else 0.0
    for beat, oid, resid in pts:
        local = [r for (b, _, r) in pts if abs(b - beat) <= window_beats]
        med = statistics.median(local) if len(local) >= 3 else global_med
        out[oid] = resid - med
    return out


def played_tempo_curve(take: Take, stops: dict[str, float]) -> list[TempoPoint]:
    """The tempo the player actually kept, note by note.

    The same 4-beat sliding median the tempo-instability check reads, so the
    curve a player sees is the evidence that check judged — not a second,
    differently smoothed opinion of the same take. Each point carries the
    written tempo there, so a marked tempo change is drawn as a step. Stops
    are cut out, as the check cuts them: each is named once, as a stop.
    """
    anchors = [(beat, ms, onset.measureNo)
               for beat, ms, onset in take.played_without_stops(stops)]
    measure_at = {beat: measure for beat, _, measure in anchors}
    points = []
    for beat, bpm in local_bpm_series([(b, ms) for b, ms, _ in anchors]):
        span = take.written.span_at(beat)
        points.append(TempoPoint(beat=round(beat, 3), measure=measure_at.get(beat, 1),
                                 bpm=round(bpm, 1), targetBpm=round(span.bpm, 1),
                                 shape=span.shape))
    return points
