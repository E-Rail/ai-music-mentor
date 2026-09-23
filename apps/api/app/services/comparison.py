"""前后演奏的可复算对比逻辑。

比较键优先使用稳定的乐谱 eventId，而不是只看小节号。这样同一小节内的
多个同类错误不会被错误地合并，前端也能准确标出真正改善的位置。
"""
from __future__ import annotations

from typing import Any

from app.i18n import localized, msg


METRIC_KEYS = (
    "pitchScore", "rhythmScore", "fluencyScore", "overallScore",
    "timingMaeMs", "avgBpm",
)
SCORE_KEYS = ("pitchScore", "rhythmScore", "fluencyScore", "overallScore")


def error_comparison_key(error: dict[str, Any]) -> str:
    location = error.get("location") or {}
    raw_ids = location.get("eventIds") or []
    event_ids = [str(value) for value in raw_ids if value]
    if location.get("eventId"):
        event_ids.append(str(location["eventId"]))

    if event_ids:
        anchor = "events:" + "|".join(sorted(set(event_ids)))
    else:
        measure = int(location.get("measure") or 0)
        beat = float(location.get("beat") or 0.0)
        detail = " ".join(str(error.get("detail") or "").split())
        anchor = f"m:{measure}|b:{beat:.3f}|d:{detail}"
    return f"{error.get('type', 'unknown')}@{anchor}"


def compare_reports(baseline: dict[str, Any], retry: dict[str, Any],
                    *, target_changed: bool = False) -> dict[str, Any]:
    baseline_metrics = baseline["metrics"]
    retry_metrics = retry["metrics"]
    delta = {
        key: round(float(retry_metrics[key]) - float(baseline_metrics[key]), 1)
        for key in METRIC_KEYS
    }

    if target_changed:
        # Descendant exercises may remove a hand, alter rhythm, or shorten the
        # score. Compare recurring problem categories without pretending their
        # note-level event IDs are identical.
        baseline_errors = {
            f"type:{error.get('type', 'unknown')}"
            for error in baseline.get("errors", [])
        }
        retry_errors = {
            f"type:{error.get('type', 'unknown')}"
            for error in retry.get("errors", [])
        }
    else:
        baseline_errors = {error_comparison_key(error) for error in baseline.get("errors", [])}
        retry_errors = {error_comparison_key(error) for error in retry.get("errors", [])}
    resolved = sorted(baseline_errors - retry_errors)
    persistent = sorted(baseline_errors & retry_errors)
    new = sorted(retry_errors - baseline_errors)

    improved = sum(1 for key in SCORE_KEYS if delta[key] > 0)
    timing_improved = delta["timingMaeMs"] < 0
    retry_quality = (retry.get("inputQuality") or {}).get("status")
    if retry_quality == "insufficient":
        suggestion = msg("compare.insufficient")
    elif target_changed and retry.get("errors"):
        suggestion = msg("compare.generatedStillHas", count=len(retry.get("errors", [])))
    elif target_changed:
        suggestion = msg("compare.generatedPassed")
    elif resolved and (improved >= 2 or timing_improved):
        suggestion = msg("compare.resolved", resolved=len(resolved), remaining=len(persistent))
    elif persistent:
        suggestion = msg("compare.persistent", count=len(persistent))
    elif new:
        suggestion = msg("compare.newProblems", count=len(new))
    else:
        suggestion = msg("compare.unclear")

    return {
        "metricDelta": delta,
        "resolvedErrors": resolved,
        "persistentErrors": persistent,
        "newErrors": new,
        "targetChanged": target_changed,
        **localized(suggestion=suggestion),
    }
