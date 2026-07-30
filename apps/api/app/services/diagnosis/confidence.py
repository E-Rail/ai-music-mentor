"""置信度（方案 5.7）。

confidence = 0.45 × 证据数量得分 + 0.35 × 跨重复一致性 + 0.20 × 规则特异性
限制在 0–1；≥0.75 高，0.45–0.75 中，其余低。
"""
from __future__ import annotations

from app.schemas.models import ErrorType

RULE_SPECIFICITY = {
    ErrorType.wrong_pitch: 0.95,
    ErrorType.missed_note: 0.90,
    ErrorType.extra_note: 0.85,
    ErrorType.early_late: 0.80,
    ErrorType.duration_anomaly: 0.75,
    ErrorType.tempo_instability: 0.70,
    ErrorType.dynamics_anomaly: 0.60,
}


def evidence_score(n_evidences: int) -> float:
    if n_evidences >= 2:
        return 1.0
    if n_evidences == 1:
        return 0.75
    return 0.4


def consistency_score(same_type_count: int) -> float:
    """跨重复一致性：同类错误重复出现则更可信。"""
    if same_type_count >= 3:
        return 0.95
    if same_type_count >= 2:
        return 0.9
    return 0.6


def confidence(err_type: ErrorType, n_evidences: int, same_type_count: int) -> float:
    c = (0.45 * evidence_score(n_evidences)
         + 0.35 * consistency_score(same_type_count)
         + 0.20 * RULE_SPECIFICITY.get(err_type, 0.6))
    return round(max(0.0, min(1.0, c)), 3)


def confidence_label(c: float) -> str:
    if c >= 0.75:
        return "高"
    if c >= 0.45:
        return "中"
    return "低"
