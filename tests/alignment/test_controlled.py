"""受控样本算法回归（方案 11.2/11.3）。

对 3 首曲 × 注入错误样本运行诊断管线：
- 事件级 Precision / Recall / F1（目标 ≥ 0.90）
- 位置偏差：标记 eventId 与真值 eventId 的拍点距离（95% 在 ±0.25 拍内）
- 标准样本与真人样本不得崩溃；标准样本不得有误报

运行：cd apps/api && python -m pytest ../../tests/alignment -v
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "apps" / "api"))

from app.services.score_import import parse_musicxml            # noqa: E402
from app.services.midi_io import load_midi_events               # noqa: E402
from app.services.diagnosis.pipeline import run_analysis        # noqa: E402

FX = ROOT / "packages" / "score-fixtures"
SCORES = ["melody", "chords", "pattern"]

_bundles = {}


def bundle(score_id: str):
    if score_id not in _bundles:
        _bundles[score_id] = parse_musicxml(
            (FX / "scores" / f"{score_id}.musicxml").read_bytes(), score_id)
    return _bundles[score_id]


def event_beat(score_id: str, event_id: str) -> tuple[int, float]:
    b = bundle(score_id)
    for e in b.events:
        if e.eventId == event_id:
            return e.measureNo, e.onsetBeat
    return -1, -1.0


def match_errors(score_id: str, truth: list[dict], predicted) -> dict:
    """真值 ↔ 预测匹配，返回 TP/FP/FN 与位置偏差列表。"""
    used: set[int] = set()
    tp = 0
    deviations: list[float] = []
    for t in truth:
        t_type = t["errorType"]
        t_eid = t.get("eventId")
        t_measure = t.get("measureNo")
        best = None
        for i, e in enumerate(predicted):
            if i in used or e.type.value != t_type:
                continue
            loc = e.location
            pred_ids = loc.get("eventIds") or ([loc["eventId"]] if loc.get("eventId") else [])
            if t_eid is not None:
                if t_eid in pred_ids:
                    best = i
                    break
            else:
                # 无 eventId 的真值（extra_note / tempo_instability）按小节±1 匹配
                if t_measure is None or abs(loc["measure"] - t_measure) <= 1:
                    best = i
                    break
        if best is not None:
            used.add(best)
            tp += 1
            if t_eid is not None:
                tm, tb = event_beat(score_id, t_eid)
                pm = predicted[best].location["measure"]
                pb = predicted[best].location["beat"]
                b = bundle(score_id)
                dev = abs((pm - tm) * b.meta.beatsPerMeasure + (pb - tb))
                deviations.append(dev)
    fp = len(predicted) - tp
    fn = len(truth) - tp
    return {"tp": tp, "fp": fp, "fn": fn, "deviations": deviations}


def collect_results():
    results = []
    for score_id in SCORES:
        b = bundle(score_id)
        for truth_path in sorted(FX.glob(f"truth/{score_id}__*.json")):
            meta = json.loads(truth_path.read_text())
            name = meta["sample"]
            midi_path = FX / "midi" / f"{score_id}__{name}.mid"
            events = load_midi_events(str(midi_path))
            report = run_analysis(b, events, f"test_{name}", "test_session")
            results.append((score_id, name, meta, report))
    return results


RESULTS = collect_results()


def test_standard_no_false_positives():
    for score_id, name, meta, report in RESULTS:
        if name == "standard":
            assert not report.errors, \
                f"{score_id}/standard 出现误报: {[e.type.value for e in report.errors]}"


def test_event_level_f1():
    tp = fp = fn = 0
    details = []
    for score_id, name, meta, report in RESULTS:
        if meta.get("human") or not meta["groundTruth"]:
            continue
        r = match_errors(score_id, meta["groundTruth"], report.errors)
        tp, fp, fn = tp + r["tp"], fp + r["fp"], fn + r["fn"]
        details.append((score_id, name, r))
    precision = tp / (tp + fp) if tp + fp else 1.0
    recall = tp / (tp + fn) if tp + fn else 1.0
    f1 = 2 * precision * recall / (precision + recall) if precision + recall else 0.0
    print(f"\n受控样本: TP={tp} FP={fp} FN={fn} "
          f"P={precision:.3f} R={recall:.3f} F1={f1:.3f}")
    for score_id, name, r in details:
        if r["fp"] or r["fn"]:
            print(f"  [偏差] {score_id}/{name}: {r}")
    assert f1 >= 0.90, f"事件级 F1={f1:.3f} 未达标（<0.90）"


def test_position_deviation():
    deviations = []
    for score_id, name, meta, report in RESULTS:
        if meta.get("human") or not meta["groundTruth"]:
            continue
        r = match_errors(score_id, meta["groundTruth"], report.errors)
        deviations.extend(r["deviations"])
    if not deviations:
        pytest.skip("无可评估位置")
    within = sum(1 for d in deviations if d <= 0.25)
    ratio = within / len(deviations)
    print(f"\n位置偏差: {within}/{len(deviations)} 在 ±0.25 拍内（{ratio:.1%}）")
    assert ratio >= 0.95


def test_human_samples_no_crash():
    for score_id, name, meta, report in RESULTS:
        if meta.get("human"):
            assert report.metrics.overallScore >= 0


def test_error_details_never_expose_internal_group_ids():
    for score_id, name, _meta, report in RESULTS:
        for error in report.errors:
            assert not error.detail.startswith("group:"), \
                f"{score_id}/{name} 泄露内部诊断 ID: {error.detail}"
