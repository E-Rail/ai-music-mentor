"""模式聚合与可能成因（方案 5.7）。

- 模式判断：规则基于多个事实聚合，显示覆盖样本数
- 可能成因：规则候选（AI 只做语言化），使用"可能/疑似"并带置信度与限制说明
- 动作结论：无视频时禁止确定性表达
"""
from __future__ import annotations

from app.i18n import localized, msg
from app.schemas.models import ErrorEvent, ErrorType, Pattern

# 可能成因规则候选（含限制说明）. Message keys: cause.<id> / limit.<id>.
CAUSE_CANDIDATES = {
    ErrorType.wrong_pitch: ["shiftPrep", "keyUnfamiliar"],
    ErrorType.missed_note: ["skippedVoice", "voiceDropped"],
    ErrorType.extra_note: ["neighbourTouch"],
    ErrorType.early_late: ["localTempoSense", "rushDrag"],
    ErrorType.duration_anomaly: ["durationConcept"],
    ErrorType.tempo_instability: ["difficultyDrift", "fatigueSlowdown"],
}

PATTERN_NAMES = {
    ErrorType.early_late: "pattern.timing",
    ErrorType.wrong_pitch: "pattern.wrongPitch",
    ErrorType.missed_note: "pattern.missed",
    ErrorType.extra_note: "pattern.extra",
    ErrorType.duration_anomaly: "pattern.duration",
    ErrorType.tempo_instability: "pattern.tempo",
    ErrorType.dynamics_anomaly: "pattern.dynamics",
}


def aggregate_patterns(errors: list[ErrorEvent],
                       measure_labels: list[str] | None = None) -> list[Pattern]:
    def label(measure: int) -> str:
        """The number printed on the page, not the timeline position."""
        if measure_labels and 1 <= measure <= len(measure_labels):
            return measure_labels[measure - 1]
        return str(measure)

    patterns: list[Pattern] = []
    n = 0

    # 同类型错误在相邻小节重复 → 模式
    by_type: dict[ErrorType, list[ErrorEvent]] = {}
    for e in errors:
        by_type.setdefault(e.type, []).append(e)

    for err_type, group in by_type.items():
        if len(group) < 2:
            continue
        measures = sorted({e.location["measure"] for e in group})
        clustered = any(b - a <= 2 for a, b in zip(measures, measures[1:]))
        if clustered or len(group) >= 3:
            n += 1
            patterns.append(Pattern(
                id=f"pat_{n:03d}",
                coveredErrorIds=[e.id for e in group],
                sampleCount=len(group),
                **localized(description=msg(
                    "pattern.repeated", name=msg(PATTERN_NAMES[err_type]),
                    count=len(group), start=label(measures[0]), end=label(measures[-1])))))

    # 单小节多类型错误集中 → 难点小节
    by_measure: dict[int, list[ErrorEvent]] = {}
    for e in errors:
        by_measure.setdefault(e.location["measure"], []).append(e)
    for m, group in by_measure.items():
        if len(group) >= 2 and len({e.type for e in group}) >= 2:
            n += 1
            patterns.append(Pattern(
                id=f"pat_{n:03d}",
                coveredErrorIds=[e.id for e in group],
                sampleCount=len(group),
                **localized(description=msg("pattern.hardBar", bar=label(m),
                                            count=len(group)))))
    return patterns


def build_hypotheses(errors: list[ErrorEvent],
                     patterns: list[Pattern]) -> list[dict]:
    """可能成因：规则候选 + 置信度 + 限制说明（中等置信度措辞）。"""
    if not errors:
        return []
    type_counts: dict[ErrorType, int] = {}
    for e in errors:
        type_counts[e.type] = type_counts.get(e.type, 0) + 1
    ranked = sorted(type_counts.items(), key=lambda kv: -kv[1])

    out = []
    for err_type, count in ranked[:3]:
        for candidate in CAUSE_CANDIDATES.get(err_type, [])[:1]:
            base = 0.55 if count >= 2 else 0.45
            of_type = {er.id for er in errors if er.type == err_type}
            if any(of_type & set(p.coveredErrorIds) for p in patterns):
                base += 0.1
            out.append({
                "confidence": round(min(0.75, base), 2),   # 可能成因上限中等
                "relatedType": err_type.value,
                "sampleCount": count,
                **localized(cause=msg(f"cause.{candidate}"),
                            limitation=msg(f"limit.{candidate}")),
            })
    return out
