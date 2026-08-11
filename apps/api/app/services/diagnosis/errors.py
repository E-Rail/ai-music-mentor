"""错误检测（方案 5.6）：从对齐路径生成 Evidence 与 ErrorEvent。

对齐在 onset 层（多声部音高并集）完成，分类阶段分配到声部事件：
- 声部事件音高全部缺失 → 漏音（missed_note）
- 声部事件音高部分错误/缺失 → 错音（wrong_pitch）
- onset 期望音全弹出但有额外音 → 多音（extra_note）
- 演奏组无法对应任何 onset（Insert）→ 多音
- |onset residual| > max(80ms, 0.12 beat) → 提前/延后（early_late）
- |duration ratio − 1| > 0.35 → 时值异常（duration_anomaly）
- 4 拍滑窗 BPM CV>8% / 连续减速>12% / 整体偏离标称>10% → 速度不稳

特殊处理：和弦不同步（某音延迟超过 70ms 窗口形成独立演奏组）=
Substitute(缺音) + Insert(延迟音) → 合并为 early_late（低严重度），
避免误报多音/错音。
"""
from __future__ import annotations

import statistics

from app.schemas.models import (AlignmentPair, AlignOp, ErrorEvent, ErrorType,
                                Evidence, PerformanceGroup, Severity)
from app.services.alignment.onset import ScoreOnset, score_onset_beat
from app.services.alignment.tempo import TempoMap, local_bpm_series
from app.services.diagnosis.confidence import confidence

NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]


def pitch_name(midi: int) -> str:
    return f"{NOTE_NAMES[midi % 12]}{midi // 12 - 1}"


def pitch_set_str(pitches) -> str:
    return "/".join(pitch_name(p) for p in sorted(pitches))


class _Ctx:
    def __init__(self):
        self.errors: list[ErrorEvent] = []
        self.evidences: list[Evidence] = []
        self._err_n = 0
        self._ev_n = 0

    def add_evidence(self, measure: int, beat: float, fact: str,
                     expected: str = "", actual: str = "",
                     delta_ms: float | None = None,
                     delta_velocity: float | None = None) -> str:
        self._ev_n += 1
        ev_id = f"ev_{self._ev_n:04d}"
        self.evidences.append(Evidence(id=ev_id, fact=fact, measureNo=measure,
                                       beat=beat, expected=expected,
                                       actual=actual, deltaMs=delta_ms,
                                       deltaVelocity=delta_velocity))
        return ev_id

    def add_error(self, err_type: ErrorType, measure: int, beat: float,
                  event_ids: list[str], severity: Severity,
                  evidence_ids: list[str], detail: str = "") -> None:
        self._err_n += 1
        conf = confidence(err_type, len(evidence_ids), 1)
        self.errors.append(ErrorEvent(
            id=f"err_{self._err_n:04d}", type=err_type,
            location={"measure": measure, "beat": beat,
                      "eventId": event_ids[0] if event_ids else None,
                      "eventIds": event_ids},
            severity=severity, evidenceIds=evidence_ids, confidence=conf,
            detail=detail))


def classify_errors(pairs: list[AlignmentPair],
                    onset_index: dict[str, ScoreOnset],
                    group_index: dict[str, PerformanceGroup],
                    tempo_map: TempoMap,
                    beats_per_measure: float,
                    bpm: float,
                    group_pitch_onsets: dict[str, dict[int, float]] | None = None,
                    include_duration_errors: bool = True,
                    duration_tolerance: float = .35,
                    include_dynamics_errors: bool = True,
                    has_notated_dynamics: bool = False,
                    ) -> tuple[list[ErrorEvent], list[Evidence]]:
    ctx = _Ctx()
    beat_ms = 60000.0 / bpm
    timing_threshold = max(80.0, 0.12 * beat_ms)

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
                    direction = "提前" if resid < 0 else "延后"
                    sev = Severity.high if abs(resid) > 200 else Severity.medium
                    ev_id = ctx.add_evidence(
                        o.measureNo, o.onsetBeat,
                        f"相对局部速度{direction} {abs(resid):.0f} ms",
                        expected="0 ms", actual=f"{resid:+.0f} ms", delta_ms=resid)
                    ctx.add_error(ErrorType.early_late, o.measureNo, o.onsetBeat,
                                  [m.eventId for m in o.members], sev, [ev_id],
                                  f"第 {o.measureNo} 小节第 {o.onsetBeat + 1:g} 拍{direction}")
                continue
            for m in o.members:
                if m.optional:
                    continue
                ev_id = ctx.add_evidence(
                    o.measureNo, o.onsetBeat,
                    f"第 {o.measureNo} 小节{'右手' if m.part == 'RH' else '左手'} "
                    f"{pitch_set_str(m.pitches)} 未出现",
                    expected=pitch_set_str(m.pitches), actual="（未演奏）")
                ctx.add_error(ErrorType.missed_note, o.measureNo, o.onsetBeat,
                              [m.eventId], Severity.high, [ev_id])
            continue

        if not g:
            continue
        matched_onsets.append((o, g, p))

        missing = sorted(set(o.pitches) - set(g.pitches))
        extra = sorted(set(g.pitches) - set(o.pitches)
                       - consumed_extra.get(g.id, set()))

        # ---------- 和弦不同步吸收：缺音在邻近 Insert 组中 ----------
        if missing and p.operation == AlignOp.substitute:
            absorbed = False
            exp_ms = tempo_map.expected_ms(onset_beat_abs(o))
            for ins in inserts:
                if ins.performanceId in absorbed_inserts:
                    continue
                g_ins = group_index.get(ins.performanceId or "")
                if not g_ins or not set(g_ins.pitches) <= set(missing):
                    continue
                delta = g_ins.tOnMs - exp_ms
                if abs(delta) <= 1.0 * beat_ms:
                    absorbed_inserts.add(ins.performanceId)
                    missing = sorted(set(missing) - set(g_ins.pitches))
                    absorbed = True
                    if abs(delta) > 70.0:
                        # 偏移超过和弦窗口 → 真正的和弦不同步
                        member_ids = [m.eventId for m in o.members
                                      if set(m.pitches) & set(g_ins.pitches)]
                        ev_id = ctx.add_evidence(
                            o.measureNo, o.onsetBeat,
                            f"和弦音 {pitch_set_str(g_ins.pitches)} 相对和弦主体"
                            f"{'延后' if delta > 0 else '提前'} {abs(delta):.0f} ms",
                            expected="和弦同时发声", actual=f"偏移 {delta:+.0f} ms",
                            delta_ms=delta)
                        ctx.add_error(ErrorType.early_late, o.measureNo, o.onsetBeat,
                                      member_ids, Severity.low, [ev_id], "和弦不同步")
                    break
            if absorbed and not missing and not extra:
                flagged_timing = _maybe_timing(ctx, o, p, timing_threshold, adjusted)
                if not flagged_timing:
                    if include_duration_errors:
                        _maybe_duration(ctx, o, p, duration_tolerance)
                continue

        # ---------- 音高类错误 ----------
        if p.operation == AlignOp.substitute:
            if not missing and extra:
                # 期望音全弹出但多了音 → 多音
                ev_id = ctx.add_evidence(
                    o.measureNo, o.onsetBeat,
                    f"第 {o.measureNo} 小节第 {o.onsetBeat + 1:g} 拍多弹 "
                    f"{pitch_set_str(extra)}（期望 {pitch_set_str(o.pitches)}）",
                    expected=pitch_set_str(o.pitches), actual=pitch_set_str(g.pitches))
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
                        ev_id = ctx.add_evidence(
                            o.measureNo, o.onsetBeat,
                            f"第 {o.measureNo} 小节{'右手' if m.part == 'RH' else '左手'} "
                            f"{pitch_set_str(m.pitches)} 未出现",
                            expected=pitch_set_str(m.pitches), actual="（未演奏）")
                        ctx.add_error(ErrorType.missed_note, o.measureNo, o.onsetBeat,
                                      [m.eventId], Severity.high, [ev_id])
                    else:
                        ev_id = ctx.add_evidence(
                            o.measureNo, o.onsetBeat,
                            f"期望 {pitch_set_str(m.pitches)}，实际 {pitch_set_str(g.pitches)}；"
                            f"位置：第 {o.measureNo} 小节第 {o.onsetBeat + 1:g} 拍",
                            expected=pitch_set_str(m.pitches),
                            actual=pitch_set_str(g.pitches))
                        sev = Severity.high if p.cost >= 0.85 else Severity.medium
                        ctx.add_error(ErrorType.wrong_pitch, o.measureNo, o.onsetBeat,
                                      [m.eventId], sev, [ev_id])
                if extra and missing:
                    # 替换场景：多出的音视为错音一部分，不另报多音
                    pass

        # ---------- 时间与时值 ----------
        flagged_timing = _maybe_timing(ctx, o, p, timing_threshold, adjusted)
        if not flagged_timing:
            if include_duration_errors:
                _maybe_duration(ctx, o, p, duration_tolerance)

    # ---------- 未吸收的 Insert → 多音 ----------
    for ins in inserts:
        if ins.performanceId in absorbed_inserts:
            continue
        g = group_index.get(ins.performanceId or "")
        if not g:
            continue
        near_measure, near_beat = _nearest_score_position(
            g, onset_index, beats_per_measure, tempo_map)
        ev_id = ctx.add_evidence(
            near_measure, near_beat,
            f"第 {near_measure} 小节附近多弹 {pitch_set_str(g.pitches)}",
            expected="（无此音）", actual=pitch_set_str(g.pitches))
        ctx.add_error(ErrorType.extra_note, near_measure, near_beat,
                      [], Severity.medium, [ev_id],
                      f"实际多弹 {pitch_set_str(g.pitches)}")

    # ---------- 速度不稳 ----------
    _tempo_instability(ctx, matched_onsets, onset_beat_abs, bpm)

    # ---------- 力度 ----------
    # Velocity is evaluated only after alignment, so one hard/soft or accidental
    # press remains attached to its local score position and cannot shift the
    # surrounding note sequence.
    if include_dynamics_errors:
        _dynamics_anomalies(ctx, matched_onsets,
                            has_notated_dynamics=has_notated_dynamics)

    # ---------- 回填跨重复一致性 ----------
    type_counts: dict[ErrorType, int] = {}
    for e in ctx.errors:
        type_counts[e.type] = type_counts.get(e.type, 0) + 1
    for e in ctx.errors:
        e.confidence = confidence(e.type, len(e.evidenceIds),
                                  type_counts.get(e.type, 1))
    return ctx.errors, ctx.evidences


def _median_velocity(group: PerformanceGroup) -> float | None:
    values = [value for value in group.velocities if value > 0]
    return statistics.median(values) if values else None


def _dynamics_anomalies(
        ctx: _Ctx,
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
            direction = "偏强" if delta > 0 else "偏弱"
            severity = Severity.high if abs(delta) >= 30 else Severity.medium
            evidence_id = ctx.add_evidence(
                onset.measureNo, onset.onsetBeat,
                f"力度目标 {target:.0f}，实际中位力度 {actual:.0f}（{delta:+.0f}，{direction}）",
                expected=f"MIDI velocity {target:.0f}",
                actual=f"MIDI velocity {actual:.0f}",
                delta_velocity=round(delta, 1),
            )
            ctx.add_error(
                ErrorType.dynamics_anomaly, onset.measureNo, onset.onsetBeat,
                [member.eventId for member in onset.members], severity,
                [evidence_id], f"力度{direction} {abs(delta):.0f}",
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
        direction = "突然偏强" if delta > 0 else "突然偏弱"
        evidence_id = ctx.add_evidence(
            onset.measureNo, onset.onsetBeat,
            f"乐谱无明确力度标记；本次演奏中位力度 {centre:.0f}，"
            f"此音 {actual:.0f}（{delta:+.0f}，{direction}）",
            expected=f"相邻演奏中位 velocity {centre:.0f}",
            actual=f"MIDI velocity {actual:.0f}",
            delta_velocity=round(delta, 1),
        )
        ctx.add_error(
            ErrorType.dynamics_anomaly, onset.measureNo, onset.onsetBeat,
            [member.eventId for member in onset.members], Severity.low,
            [evidence_id], f"相对本轮力度{direction} {abs(delta):.0f}",
        )


def _maybe_timing(ctx: _Ctx, o: ScoreOnset, p: AlignmentPair,
                  threshold: float,
                  adjusted: dict[str, float] | None = None) -> bool:
    resid = (adjusted or {}).get(p.scoreEventId or "", p.onsetResidualMs)
    if abs(resid) <= threshold:
        return False
    direction = "提前" if resid < 0 else "延后"
    sev = Severity.high if abs(resid) > 200 else Severity.medium
    ev_id = ctx.add_evidence(
        o.measureNo, o.onsetBeat,
        f"相对局部速度{direction} {abs(resid):.0f} ms",
        expected="0 ms", actual=f"{resid:+.0f} ms", delta_ms=resid)
    ctx.add_error(ErrorType.early_late, o.measureNo, o.onsetBeat,
                  [m.eventId for m in o.members], sev, [ev_id],
                  f"第 {o.measureNo} 小节第 {o.onsetBeat + 1:g} 拍{direction}")
    return True


def _maybe_duration(ctx: _Ctx, o: ScoreOnset, p: AlignmentPair,
                    tolerance: float = .35) -> None:
    ratio = p.durationRatio
    if abs(ratio - 1.0) <= tolerance:
        return
    ev_id = ctx.add_evidence(
        o.measureNo, o.onsetBeat,
        f"期望 {o.durationBeat:g} 拍，实际约 {o.durationBeat * ratio:.2f} 拍",
        expected=f"{o.durationBeat:g} 拍", actual=f"{o.durationBeat * ratio:.2f} 拍")
    ctx.add_error(ErrorType.duration_anomaly, o.measureNo, o.onsetBeat,
                  [m.eventId for m in o.members], Severity.low, [ev_id])


def _tempo_instability(ctx: _Ctx,
                       matched_onsets: list[tuple[ScoreOnset, PerformanceGroup, AlignmentPair]],
                       onset_beat_abs, bpm: float) -> None:
    beats_ms = [(onset_beat_abs(o), g.tOnMs, o.measureNo) for o, g, _ in matched_onsets]
    if len(beats_ms) < 4:
        return
    series = local_bpm_series([(b, m) for b, m, _ in beats_ms])
    if len(series) < 3:
        return
    bpms = [v for _, v in series]
    mean_bpm = statistics.mean(bpms)
    cv = statistics.pstdev(bpms) / mean_bpm if mean_bpm else 0.0
    first_third = statistics.mean(bpms[: max(1, len(bpms) // 3)])
    last_third = statistics.mean(bpms[-max(1, len(bpms) // 3):])
    slowdown = (first_third - last_third) / first_third if first_third else 0.0
    overall_dev = abs(mean_bpm - bpm) / bpm if bpm else 0.0

    # 局部段落偏离：任一滑窗中位 BPM 相对整体中位数偏离 >12%（局部拖拍段）
    med_bpm = statistics.median(bpms)
    seg_dev = max((abs(v - med_bpm) / med_bpm for v in bpms), default=0.0)
    # 位置定位到偏离最大的窗口所在小节（而非全曲起点）
    seg_beat = max(series, key=lambda kv: abs(kv[1] - med_bpm))[0]
    seg_measure = min((m for b, _, m in beats_ms),
                      key=lambda m: 0) if False else None
    # beat → measure：找最近的锚点小节
    seg_measure = min(beats_ms, key=lambda t: abs(t[0] - seg_beat))[2]

    m_start = min(m for _, _, m in beats_ms)
    m_end = max(m for _, _, m in beats_ms)
    loc_measure = m_start
    if cv > 0.08 or slowdown > 0.12 or overall_dev > 0.10 or seg_dev > 0.12:
        detail = f"第 {m_start}–{m_end} 小节"
        if slowdown > 0.12:
            fact = (f"第 {m_start}–{m_end} 小节速度由约 {first_third:.0f} BPM "
                    f"降至 {last_third:.0f} BPM（连续减速 {slowdown * 100:.0f}%）")
            loc_measure = m_start
        elif seg_dev > 0.12:
            slowest = min(bpms)
            fact = (f"第 {seg_measure} 小节附近存在局部变速："
                    f"段落速度最慢约 {slowest:.0f} BPM，"
                    f"相对整体 {med_bpm:.0f} BPM 偏离 {seg_dev * 100:.0f}%")
            loc_measure = seg_measure
        elif overall_dev > 0.10:
            direction = "慢" if mean_bpm < bpm else "快"
            fact = (f"整体速度约 {mean_bpm:.0f} BPM，比乐谱标记 "
                    f"{bpm:.0f} BPM {direction} {overall_dev * 100:.0f}%")
            # A steady take at a slower tempo is a tempo *choice*, not shaky
            # playing — and it is exactly what the slow-practice exercises ask
            # for. Say which one it is instead of calling both "unstable".
            detail = (f"整体比标记速度{direction} {overall_dev * 100:.0f}%"
                      f"（第 {m_start}–{m_end} 小节；本次拍点本身是稳的）")
        else:
            fact = (f"4 拍滑窗 BPM 变异系数 {cv * 100:.1f}%（>8%），"
                    f"区间 {min(bpms):.0f}–{max(bpms):.0f} BPM")
        ev_id = ctx.add_evidence(loc_measure, 0.0, fact,
                                 expected=f"{bpm:.0f} BPM 稳定",
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
