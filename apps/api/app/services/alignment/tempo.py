"""速度估计（方案 5.4/5.5）：高置信锚点 + 分段鲁棒速度拟合。

tempoMap：scoreBeat（绝对拍点）→ 期望毫秒。
- 先用首匹配对 + 乐谱标称 BPM 初始化线性映射
- DP 后收集 match 对，按滑动窗口计算局部 secPerBeat（相邻匹配对差分中位数）
- 分段线性插值，支持局部拖拍/渐慢
"""
from __future__ import annotations

import statistics
from bisect import bisect_right


#: A stop is at least this long…
STOP_MIN_MS = 450.0
#: …and this much of a beat longer than the page allows…
STOP_MIN_BEATS = 0.75
#: …and this share longer than the gap it happened in, so a long written note
#: held a little long is not a stop.
STOP_MIN_SHARE = 0.4
#: After a stop the pulse comes back. If the next gap is this much slower the
#: player changed tempo; if it is this much quicker they were catching up on
#: one late note. Neither is a stop.
RESUME_TOLERANCE = 1.4


def stop_excess(gap_ms: float, beats: float, pulse_ms: float,
                next_ms_per_beat: float | None = None, *,
                free: bool = False, leeway: float = 1.0) -> float:
    """How much of a gap between two notes is an unwritten stop, or 0.

    One definition, used twice: the tempo fit treats a stop as a jump in the
    timeline (so the notes around it are not read as early or short), and the
    report names it. ``free`` is a gap the page leaves to the player — after a
    fermata any extra time is a jump, never a tempo. ``leeway`` widens the
    thresholds where the page allows the tempo to move (a written rit.).
    """
    written = beats * pulse_ms
    excess = gap_ms - written
    if free:
        return excess if excess >= 0.1 * pulse_ms else 0.0
    if excess < leeway * max(STOP_MIN_MS, STOP_MIN_BEATS * pulse_ms, STOP_MIN_SHARE * written):
        return 0.0
    if next_ms_per_beat is not None and not (
            pulse_ms / RESUME_TOLERANCE <= next_ms_per_beat <= pulse_ms * RESUME_TOLERANCE):
        return 0.0
    return excess


class TempoMap:
    """分段线性 beat→ms 映射。"""

    def __init__(self, points: list[tuple[float, float]], default_sec_per_beat: float):
        # points: [(beat, ms)] 升序，至少 2 个
        self.points = sorted(points) if points else [(0.0, 0.0), (1.0, default_sec_per_beat * 1000)]
        self.default_spb = default_sec_per_beat

    def expected_ms(self, beat: float) -> float:
        pts = self.points
        if beat <= pts[0][0]:
            b0, m0 = pts[0]
            b1, m1 = pts[1] if len(pts) > 1 else (b0 + 1, m0 + self.default_spb * 1000)
            spb = (m1 - m0) / max(1e-6, b1 - b0)
            return m0 + (beat - b0) * spb
        if beat >= pts[-1][0]:
            b0, m0 = pts[-2] if len(pts) > 1 else (pts[-1][0] - 1, pts[-1][1] - self.default_spb * 1000)
            b1, m1 = pts[-1]
            spb = (m1 - m0) / max(1e-6, b1 - b0)
            return m1 + (beat - b1) * spb
        idx = bisect_right([p[0] for p in pts], beat) - 1
        b0, m0 = pts[idx]
        b1, m1 = pts[idx + 1]
        if b1 <= b0:
            return m0
        t = (beat - b0) / (b1 - b0)
        return m0 + t * (m1 - m0)

    def sec_per_beat_at(self, beat: float) -> float:
        eps = 0.25
        return (self.expected_ms(beat + eps) - self.expected_ms(beat - eps)) / (2 * eps * 1000)

    def bpm_at(self, beat: float) -> float:
        spb = self.sec_per_beat_at(beat)
        return 60.0 / spb if spb > 0 else 0.0


def initial_tempo_map(first_beat: float, first_ms: float, bpm: float) -> TempoMap:
    spb = 60.0 / bpm
    return TempoMap([(first_beat, first_ms), (first_beat + 4, first_ms + 4 * spb * 1000)], spb)


def fit_piecewise_tempo(matched: list[tuple[float, float]],
                        bpm: float,
                        window_beats: float = 4.0,
                        free_after: set[float] | frozenset[float] = frozenset()) -> TempoMap:
    """matched: [(scoreBeat, onsetMs)] 高置信匹配对，按拍点升序。

    相邻匹配对差分得到瞬时 secPerBeat，窗口内取中位数（鲁棒），
    再生成等距锚点构建分段线性映射。

    ``free_after`` are beats whose following gap the page leaves to the player
    (a fermata). Any extra time there is a jump in the timeline, however short,
    and never counts as tempo.
    """
    spb_default = 60.0 / bpm
    if len(matched) < 2:
        return initial_tempo_map(0.0, 0.0, bpm)

    matched = sorted(matched)
    # 相邻对差分。极长间隔先不当成速度；它通常是停顿、重试某个音，
    # 或设备短暂中断。后面将它建模成时间轴上的离散位移。
    intervals: list[tuple[float, float, float, float]] = []  # (b0, b1, ms, secPerBeat)
    for (b0, m0), (b1, m1) in zip(matched, matched[1:]):
        db, dm = b1 - b0, m1 - m0
        if db > 0 and dm > 0:
            intervals.append((b0, b1, dm, dm / db / 1000.0))

    def free(interval) -> bool:
        return any(abs(interval[0] - beat) < 1e-6 for beat in free_after)

    def pulse_candidates(excluded: set[tuple[float, float]]) -> list[tuple[float, float]]:
        """(midBeat, secPerBeat) of every gap that can speak for the tempo."""
        # 过滤异常差分（±60% 以外不纳入）
        return [((b0 + b1) / 2, spb) for b0, b1, _, spb in intervals
                if not free((b0, b1)) and (b0, b1) not in excluded
                and 0.4 * spb_default <= spb <= 2.5 * spb_default]

    inst = pulse_candidates(set())
    if not inst:
        return initial_tempo_map(matched[0][0], matched[0][1], bpm)

    normal_spb = statistics.median([spb for _, spb in inst])
    pause_jumps: list[tuple[float, float, float]] = []  # (startBeat, resumeBeat, excessMs)
    for index, interval in enumerate(intervals):
        b0, b1, dm, observed_spb = interval
        midpoint = (b0 + b1) / 2
        nearby = [spb for beat, spb in inst
                  if 1e-9 < abs(beat - midpoint) <= 1.5 * window_beats]
        reference_spb = statistics.median(nearby) if nearby else normal_spb
        excess_ms = dm - (b1 - b0) * reference_spb * 1000.0
        following = intervals[index + 1] if index + 1 < len(intervals) else None
        next_ms_per_beat = (following[3] * 1000.0
                            if following and abs(following[0] - b1) < 1e-9 else None)
        # A very long gap is a jump whatever follows it; a shorter one is a
        # jump when it is a stop by the one definition the report also uses.
        very_long = (observed_spb > 2.5 * spb_default
                     and excess_ms >= 0.75 * spb_default * 1000.0)
        stop = stop_excess(dm, b1 - b0, reference_spb * 1000.0, next_ms_per_beat,
                           free=free(interval))
        if very_long or stop > 0:
            pause_jumps.append((b0, b1, excess_ms))
    # A stop is a jump, not a tempo: keep it out of the pulse it is measured
    # against.
    inst = pulse_candidates({(b0, b1) for b0, b1, _ in pause_jumps}) or inst

    b_start, b_end = matched[0][0], matched[-1][0]
    anchors: list[tuple[float, float]] = []
    b = b_start
    beats_grid = [b_start]
    while b < b_end:
        b = min(b + window_beats, b_end)
        beats_grid.append(b)
    if beats_grid[-1] < b_end:
        beats_grid.append(b_end)
    # A grid point at every resume beat preserves a long pause without
    # smearing its offset across later measures.
    beats_grid = sorted(set([
        *beats_grid,
        *(beat for start, resume, _ in pause_jumps
          for beat in (start, resume) if b_start < beat < b_end),
    ]))

    # 每个网格点的局部 spb = 窗口内瞬时 spb 中位数
    spb_at: list[float] = []
    for gb in beats_grid:
        local = [s for (mb, s) in inst if abs(mb - gb) <= window_beats]
        spb_at.append(statistics.median(local) if local else spb_default)

    # 由局部 spb 积分出 ms
    anchors.append((beats_grid[0], matched[0][1]))
    for i in range(1, len(beats_grid)):
        b0, m0 = anchors[-1]
        b1 = beats_grid[i]
        spb = (spb_at[i - 1] + spb_at[i]) / 2
        jump_ms = sum(excess for _, resume, excess in pause_jumps
                      if b0 < resume <= b1)
        anchors.append((b1, m0 + (b1 - b0) * spb * 1000 + jump_ms))

    # Re-anchor the integrated curve to the median local observation. Without
    # this correction, a small tempo-estimation bias accumulates over a long
    # take until later notes fall outside the matching gate. A local median
    # follows genuine gradual tempo changes while ignoring isolated early/late
    # notes that should remain diagnosable as timing errors.
    base_map = TempoMap(anchors, spb_default)
    corrected: list[tuple[float, float]] = []
    correction_radius = max(1.0, window_beats / 2)
    for grid_beat, grid_ms in anchors:
        local_residuals = [
            observed_ms - base_map.expected_ms(observed_beat)
            for observed_beat, observed_ms in matched
            if abs(observed_beat - grid_beat) <= correction_radius
        ]
        correction = (statistics.median(local_residuals)
                      if local_residuals else 0.0)
        corrected_ms = grid_ms + correction
        if corrected:
            previous_beat, previous_ms = corrected[-1]
            minimum_step = ((grid_beat - previous_beat) * spb_default
                            * 1000.0 * 0.20)
            corrected_ms = max(corrected_ms, previous_ms + minimum_step)
        corrected.append((grid_beat, corrected_ms))

    return TempoMap(corrected, spb_default)


def local_bpm_series(matched: list[tuple[float, float]],
                     window_beats: float = 4.0) -> list[tuple[float, float]]:
    """4 拍滑窗 BPM 序列（速度不稳检测用）。

    每个锚点取窗口内相邻差分 BPM 的**中位数**，对单音提前/延后鲁棒。
    """
    matched = sorted(matched)
    # 相邻差分瞬时 BPM
    inst: list[tuple[float, float]] = []
    for (b0, m0), (b1, m1) in zip(matched, matched[1:]):
        db, dm = b1 - b0, m1 - m0
        if db > 0 and dm > 0:
            inst.append(((b0 + b1) / 2, 60.0 / (dm / db / 1000.0)))
    if not inst:
        return []
    out = []
    for (b, _) in matched:
        local = [v for (mb, v) in inst if abs(mb - b) <= window_beats / 2]
        if len(local) >= 2:
            out.append((b, statistics.median(local)))
    return out
