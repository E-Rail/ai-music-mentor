"""模式聚合与可能成因（方案 5.7）。

- 模式判断：规则基于多个事实聚合，显示覆盖样本数
- 可能成因：规则候选（AI 只做语言化），使用"可能/疑似"并带置信度与限制说明
- 动作结论：无视频时禁止确定性表达
"""
from __future__ import annotations

from app.schemas.models import ErrorEvent, ErrorType, Pattern

# 可能成因规则候选（含限制说明）
CAUSE_CANDIDATES = {
    ErrorType.wrong_pitch: [
        ("可能因换位准备不足或视线切换晚", "仅凭 MIDI 无法确认手型/指法，动作级归因需视频证据"),
        ("可能对该调号音位不熟", "需结合长期记录确认"),
    ],
    ErrorType.missed_note: [
        ("可能视奏时跳过了该声部", "无法区分是未看到还是来不及弹"),
        ("可能双手配合时该声部被放弃", "需拆手练习验证"),
    ],
    ErrorType.extra_note: [
        ("可能邻音误触或换把位时带音", "仅凭 MIDI 无法确认手指动作"),
    ],
    ErrorType.early_late: [
        ("可能对局部速度感知不稳定", "建议配合节拍器慢速验证"),
        ("可能在难点处下意识抢拍/拖拍", "需重复样本确认是否为习惯模式"),
    ],
    ErrorType.duration_anomaly: [
        ("可能音符时值概念不清或提前松键", "踏板使用可能影响判断"),
    ],
    ErrorType.tempo_instability: [
        ("可能随难度波动下意识变速", "建议分句配合节拍器"),
        ("可能体力/紧张导致后半段减速", "需多次演奏交叉验证"),
    ],
}


def aggregate_patterns(errors: list[ErrorEvent]) -> list[Pattern]:
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
            name = {
                ErrorType.early_late: "节奏偏移重复出现，疑似局部速度控制模式",
                ErrorType.wrong_pitch: "错音集中出现，疑似音位/换位不稳定",
                ErrorType.missed_note: "漏音重复出现，疑似声部跟踪丢失",
                ErrorType.extra_note: "多音重复出现，疑似换把位带音",
                ErrorType.duration_anomaly: "时值偏差重复出现，疑似节奏概念不稳定",
                ErrorType.tempo_instability: "速度波动呈段落性",
            }.get(err_type, f"{err_type.value} 重复出现")
            patterns.append(Pattern(
                id=f"pat_{n:03d}",
                description=f"{name}（覆盖 {len(group)} 处，分布于第 "
                            f"{measures[0]}–{measures[-1]} 小节）",
                coveredErrorIds=[e.id for e in group],
                sampleCount=len(group)))

    # 单小节多类型错误集中 → 难点小节
    by_measure: dict[int, list[ErrorEvent]] = {}
    for e in errors:
        by_measure.setdefault(e.location["measure"], []).append(e)
    for m, group in by_measure.items():
        if len(group) >= 2 and len({e.type for e in group}) >= 2:
            n += 1
            patterns.append(Pattern(
                id=f"pat_{n:03d}",
                description=f"第 {m} 小节多类错误集中（{len(group)} 处），疑似难点小节",
                coveredErrorIds=[e.id for e in group],
                sampleCount=len(group)))
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
        for cause, limitation in CAUSE_CANDIDATES.get(err_type, [])[:1]:
            base = 0.55 if count >= 2 else 0.45
            if patterns and any(err_type.value in p.description or
                                any(e in p.coveredErrorIds for e in
                                    [er.id for er in errors if er.type == err_type])
                                for p in patterns):
                base += 0.1
            out.append({
                "cause": cause,
                "confidence": round(min(0.75, base), 2),   # 可能成因上限中等
                "limitation": limitation,
                "relatedType": err_type.value,
                "sampleCount": count,
            })
    return out
