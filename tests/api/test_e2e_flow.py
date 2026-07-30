"""端到端接口测试（方案 11.3 接口测试 + e2e 主链路）。

走「无设备降级」路径完成完整闭环：
选曲 → 建会话 → 上传 MIDI → 分析 → 报告 → 生成练习 → AI 导师
→ 伴奏 → 第二次演奏（改善版）→ 前后对比

需要后端运行在 localhost:8000：
  cd apps/api && uvicorn app.main:app --port 8000
运行：python tests/api/test_e2e_flow.py
"""
from __future__ import annotations

import sys
from pathlib import Path

import httpx

BASE = "http://localhost:8000/api"
ROOT = Path(__file__).resolve().parents[2]
FX = ROOT / "packages" / "score-fixtures"


def main() -> None:
    c = httpx.Client(base_url=BASE, timeout=30)

    # 1. 曲目列表
    scores = c.get("/scores").json()["scores"]
    assert len(scores) >= 3, "内置曲目未注册"
    score_id = "melody"
    meta = c.get(f"/scores/{score_id}").json()["metadata"]
    print(f"[1] 曲目 {score_id}: {meta['measureCount']} 小节, {meta['tempo']} BPM")

    # 2. 第一次演奏：上传含注入错误的 MIDI（错音+漏音样本）
    sess = c.post("/sessions", json={
        "scoreId": score_id, "rangeStart": 1, "rangeEnd": 8,
        "device": "midi-file"}).json()
    sid = sess["sessionId"]
    print(f"[2] 会话 {sid}, 预备拍 {sess['countIn']}")

    ref = c.post(f"/sessions/{sid}/upload-midi",
                 files={"file": ("wrong.mid",
                                 (FX / "midi" / "melody__wrong_pitch.mid").read_bytes(),
                                 "audio/midi")}).json()
    fin = c.post(f"/sessions/{sid}/finish",
                 json={"events": [], "uploadedMidiRef": ref["uploadedMidiRef"]})
    assert fin.status_code == 200, fin.text
    rep_id = fin.json()["reportId"]

    rep = c.get(f"/reports/{rep_id}").json()
    m = rep["metrics"]
    print(f"[3] 报告 {rep_id}: overall={m['overallScore']} "
          f"pitch={m['pitchScore']} MAE={m['timingMaeMs']}ms")
    for e in rep["errors"]:
        print(f"    - {e['type']} 第{e['location']['measure']}小节 "
              f"({e['severity']}, conf={e['confidence']})")
    assert any(e["type"] == "wrong_pitch" for e in rep["errors"]), "应检出错音"

    # 3. 生成练习（自动策略）
    ex = c.post("/exercises", json={
        "reportId": rep_id, "errorIds": [],
        "params": {"strategy": "auto", "tempoRatio": 0.6,
                   "loopCount": 4}}).json()
    assert "musicXmlUrl" in ex, ex
    xml = c.get(ex["musicXmlUrl"].replace("/api", ""))
    mid = c.get(ex["midiUrl"].replace("/api", ""))
    assert xml.status_code == 200 and mid.status_code == 200
    print(f"[4] 练习 {ex['exerciseId']} 策略={ex['ruleId']} "
          f"小节={ex['sourceMeasures']} XML={len(xml.content)}B MIDI={len(mid.content)}B")

    # 4. AI 导师（规则模板 + 追问）
    mentor = c.post("/mentor/respond", json={
        "reportId": rep_id, "question": "为什么这里总是错？"}).json()
    print(f"[5] 导师({mentor['provider']}): {mentor['summary'][:80]}...")
    assert mentor["summary"]

    # 5. 伴奏
    acc = c.post("/accompaniments", json={
        "scoreId": score_id, "rangeStart": 1, "rangeEnd": 8,
        "style": "chord_bass", "mode": "flexible"}).json()
    acc_mid = c.get(acc["midiUrl"].replace("/api", ""))
    assert acc_mid.status_code == 200
    print(f"[6] 伴奏 {acc['accompanimentId']} baseTempo={acc['baseTempo']} "
          f"MIDI={len(acc_mid.content)}B")

    # 6. 第二次演奏：标准 MIDI（无错误）→ 对比
    sess2 = c.post("/sessions", json={
        "scoreId": score_id, "rangeStart": 1, "rangeEnd": 8,
        "device": "midi-file"}).json()
    sid2 = sess2["sessionId"]
    ref2 = c.post(f"/sessions/{sid2}/upload-midi",
                  files={"file": ("std.mid",
                                  (FX / "midi" / "melody__standard.mid").read_bytes(),
                                  "audio/midi")}).json()
    fin2 = c.post(f"/sessions/{sid2}/finish",
                  json={"events": [], "uploadedMidiRef": ref2["uploadedMidiRef"]})
    rep_id2 = fin2.json()["reportId"]

    comp = c.get("/comparisons",
                 params={"baselineId": rep_id, "retryId": rep_id2}).json()
    print(f"[7] 前后对比: Δoverall={comp['metricDelta']['overallScore']} "
          f"已解决={comp['resolvedErrors']} 建议: {comp['suggestion'][:50]}")
    assert comp["metricDelta"]["overallScore"] > 0, "第二次应比第一次好"
    assert comp["resolvedErrors"], "应有已解决错误"

    # 7. 异常路径：坏 MusicXML / 无法对齐
    bad = c.post("/scores/import",
                 files={"file": ("bad.musicxml", b"<not-xml", "text/xml")})
    assert bad.status_code == 400 and bad.json()["detail"]["code"] == "SCORE_UNSUPPORTED"
    print("[8] 坏 MusicXML 正确返回 SCORE_UNSUPPORTED")

    print("\n✅ 端到端闭环全部通过")


if __name__ == "__main__":
    sys.exit(main())
