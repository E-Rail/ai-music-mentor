"""REST/WS 接口（方案 7）。错误以 {code, message} 返回（方案 7.1 错误码）。"""
from __future__ import annotations

import shutil
import uuid
from datetime import datetime, timezone
from pathlib import Path

from fastapi import (APIRouter, File, HTTPException, UploadFile, WebSocket,
                     WebSocketDisconnect)
from fastapi.responses import FileResponse

from app import config, storage
from app.schemas.models import (AccompanimentCreate, ApiError, ExerciseCreate,
                                MentorRequest, PerformanceEvent, ScoreBundle,
                                SessionCreate, SessionFinish)
from app.services.diagnosis.pipeline import (LowConfidenceAlignmentError,
                                             run_analysis)
from app.services.generation.accompaniment import generate_accompaniment
from app.services.generation.exercises import generate_exercise, suggest_strategy
from app.services.mentor import adapter as mentor_adapter
from app.services.midi_io import load_midi_events
from app.services.score_import import (ScoreUnsupportedError, parse_musicxml)

router = APIRouter()


def _err(status: int, code: str, message: str) -> HTTPException:
    return HTTPException(status_code=status,
                         detail=ApiError(code=code, message=message).model_dump())


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:10]}"


def _load_bundle(score_id: str) -> ScoreBundle:
    data = storage.get("score", score_id)
    if not data:
        raise _err(404, "SCORE_NOT_FOUND", f"曲目 {score_id} 不存在")
    return ScoreBundle.model_validate(data["bundle"])


# ---------------------------------------------------------------- 曲目

@router.get("/scores")
def list_scores():
    out = []
    for s in storage.list_kind("score"):
        meta = s["bundle"]["meta"]
        out.append({**meta, "builtin": s.get("builtin", False)})
    return {"scores": out}


@router.post("/scores/import")
async def import_score(file: UploadFile = File(...)):
    suffix = Path(file.filename or "").suffix.lower()
    if suffix not in (".musicxml", ".xml", ".mxl"):
        raise _err(400, "SCORE_UNSUPPORTED",
                   "仅支持 .musicxml/.xml/.mxl 文件")
    content = await file.read()
    if len(content) > config.MAX_SCORE_BYTES:
        raise _err(400, "SCORE_UNSUPPORTED", "文件超过 5 MB 上限")
    score_id = f"user_{uuid.uuid4().hex[:8]}"
    try:
        bundle = parse_musicxml(content, score_id)
    except ScoreUnsupportedError as e:
        raise _err(400, "SCORE_UNSUPPORTED", str(e)) from e

    xml_path = config.SCORE_STORAGE_DIR / f"{score_id}.musicxml"
    xml_path.write_bytes(content)
    storage.put("score", score_id, {
        "bundle": bundle.model_dump(), "builtin": False,
        "xmlPath": str(xml_path), "createdAt": _now()})
    return {"scoreId": score_id, "metadata": bundle.meta.model_dump(),
            "scoreEvents": [e.model_dump() for e in bundle.events],
            "renderUrl": f"/api/scores/{score_id}/musicxml"}


@router.get("/scores/{score_id}")
def get_score(score_id: str):
    bundle = _load_bundle(score_id)
    return {"metadata": bundle.meta.model_dump(),
            "scoreEvents": [e.model_dump() for e in bundle.events],
            "renderUrl": f"/api/scores/{score_id}/musicxml"}


@router.get("/scores/{score_id}/musicxml")
def get_score_xml(score_id: str):
    data = storage.get("score", score_id)
    if not data:
        raise _err(404, "SCORE_NOT_FOUND", f"曲目 {score_id} 不存在")
    path = Path(data["xmlPath"])
    if not path.exists():
        raise _err(404, "SCORE_NOT_FOUND", "乐谱文件缺失")
    return FileResponse(path, media_type="application/xml")


# ---------------------------------------------------------------- 会话与分析

@router.post("/sessions")
def create_session(req: SessionCreate):
    bundle = _load_bundle(req.scoreId)
    session_id = _new_id("sess")
    storage.put("session", session_id, {
        "id": session_id, "scoreId": req.scoreId,
        "rangeStart": req.rangeStart,
        "rangeEnd": req.rangeEnd or bundle.meta.measureCount,
        "device": req.device, "startedAt": _now(), "status": "recording",
        "events": []})
    return {"sessionId": session_id,
            "countIn": {"beats": int(bundle.meta.beatsPerMeasure),
                        "bpm": bundle.meta.tempo}}


@router.websocket("/ws/sessions/{session_id}/events")
async def session_events_ws(ws: WebSocket, session_id: str):
    """增量事件通道：接收 MIDI event/group，返回确认（可选）。"""
    await ws.accept()
    data = storage.get("session", session_id)
    if not data:
        await ws.close(code=4404)
        return
    try:
        while True:
            msg = await ws.receive_json()
            events = msg.get("events", [])
            if events:
                data["events"].extend(events)
                storage.put("session", session_id, data)
            await ws.send_json({"ack": len(data["events"])})
    except WebSocketDisconnect:
        storage.put("session", session_id, data)


@router.post("/sessions/{session_id}/finish")
def finish_session(session_id: str, req: SessionFinish):
    data = storage.get("session", session_id)
    if not data:
        raise _err(404, "SESSION_NOT_FOUND", f"会话 {session_id} 不存在")

    events = [PerformanceEvent.model_validate(e) for e in req.events]
    if not events and req.uploadedMidiRef:
        path = config.SESSION_STORAGE_DIR / req.uploadedMidiRef
        if not path.exists():
            raise _err(400, "MIDI_FILE_NOT_FOUND", "上传的 MIDI 文件不存在")
        events = load_midi_events(str(path))
    if not events and data.get("events"):
        events = [PerformanceEvent.model_validate(e) for e in data["events"]]
    if not events:
        raise _err(400, "NO_PERFORMANCE_EVENTS", "没有演奏事件，请重录")

    bundle = _load_bundle(data["scoreId"])
    report_id = _new_id("rep")
    try:
        report = run_analysis(
            bundle, events, report_id, session_id,
            range_start=data["rangeStart"], range_end=data["rangeEnd"],
            created_at=_now())
    except LowConfidenceAlignmentError as e:
        raise _err(422, "ALIGNMENT_LOW_CONFIDENCE", str(e)) from e

    storage.put("report", report_id, report.model_dump())
    data["status"] = "analyzed"
    data["reportId"] = report_id
    storage.put("session", session_id, data)

    job_id = _new_id("job")
    storage.put("job", job_id, {"id": job_id, "status": "completed",
                                "reportId": report_id, "progress": 100})
    return {"analysisJobId": job_id, "reportId": report_id}


@router.post("/sessions/{session_id}/upload-midi")
async def upload_midi(session_id: str, file: UploadFile = File(...)):
    """无设备降级：上传 MIDI 文件作为演奏记录。"""
    data = storage.get("session", session_id)
    if not data:
        raise _err(404, "SESSION_NOT_FOUND", f"会话 {session_id} 不存在")
    content = await file.read()
    name = f"{session_id}_{file.filename}"
    path = config.SESSION_STORAGE_DIR / name
    path.write_bytes(content)
    return {"uploadedMidiRef": name}


@router.get("/analysis/{job_id}")
def get_analysis(job_id: str):
    job = storage.get("job", job_id)
    if not job:
        raise _err(404, "JOB_NOT_FOUND", f"分析任务 {job_id} 不存在")
    return job


@router.get("/reports/{report_id}")
def get_report(report_id: str):
    rep = storage.get("report", report_id)
    if not rep:
        raise _err(404, "REPORT_NOT_FOUND", f"报告 {report_id} 不存在")
    return rep


# ---------------------------------------------------------------- 练习 / 伴奏 / 导师 / 对比

@router.post("/exercises")
def create_exercise(req: ExerciseCreate):
    rep_data = storage.get("report", req.reportId)
    if not rep_data:
        raise _err(404, "REPORT_NOT_FOUND", f"报告 {req.reportId} 不存在")
    from app.schemas.models import DiagnosisReport
    report = DiagnosisReport.model_validate(rep_data)
    bundle = _load_bundle(report.scoreId)
    params = req.params
    if params.strategy == "auto":
        params = params.model_copy(
            update={"strategy": suggest_strategy(report)})
    exercise = generate_exercise(report, bundle, params,
                                 config.GENERATED_STORAGE_DIR)
    storage.put("exercise", exercise.exerciseId, exercise.model_dump())
    return {"exerciseId": exercise.exerciseId,
            "ruleId": exercise.ruleId,
            "sourceMeasures": exercise.sourceMeasures,
            "tempoPlan": exercise.tempoPlan,
            "successCriterion": exercise.successCriterion,
            "musicXmlUrl": f"/api/exercises/{exercise.exerciseId}/musicxml",
            "midiUrl": f"/api/exercises/{exercise.exerciseId}/midi"}


@router.get("/exercises/{exercise_id}/musicxml")
def get_exercise_xml(exercise_id: str):
    ex = storage.get("exercise", exercise_id)
    if not ex or not Path(ex["musicXmlPath"]).exists():
        raise _err(404, "EXERCISE_NOT_FOUND", "练习不存在")
    return FileResponse(ex["musicXmlPath"], media_type="application/xml")


@router.get("/exercises/{exercise_id}/midi")
def get_exercise_midi(exercise_id: str):
    ex = storage.get("exercise", exercise_id)
    if not ex or not Path(ex["midiPath"]).exists():
        raise _err(404, "EXERCISE_NOT_FOUND", "练习不存在")
    return FileResponse(ex["midiPath"], media_type="audio/midi")


@router.post("/accompaniments")
def create_accompaniment(req: AccompanimentCreate):
    bundle = _load_bundle(req.scoreId)
    result = generate_accompaniment(bundle, req.rangeStart,
                                    req.rangeEnd or bundle.meta.measureCount,
                                    config.GENERATED_STORAGE_DIR)
    storage.put("accompaniment", result["accompanimentId"], result)
    return {"accompanimentId": result["accompanimentId"],
            "baseTempo": result["baseTempo"],
            "harmonyEvents": result["harmonyEvents"],
            "beatsPerMeasure": result["beatsPerMeasure"],
            "midiUrl": f"/api/accompaniments/{result['accompanimentId']}/midi"}


@router.get("/accompaniments/{acc_id}/midi")
def get_accompaniment_midi(acc_id: str):
    acc = storage.get("accompaniment", acc_id)
    if not acc or not Path(acc["midiPath"]).exists():
        raise _err(404, "ACCOMPANIMENT_NOT_FOUND", "伴奏不存在")
    return FileResponse(acc["midiPath"], media_type="audio/midi")


@router.post("/mentor/respond")
def mentor_respond(req: MentorRequest):
    rep_data = storage.get("report", req.reportId)
    if not rep_data:
        raise _err(404, "REPORT_NOT_FOUND", f"报告 {req.reportId} 不存在")
    from app.schemas.models import DiagnosisReport
    report = DiagnosisReport.model_validate(rep_data)
    resp, provider = mentor_adapter.respond(report, req.question, req.errorId)
    return {"provider": provider, "promptVersion": mentor_adapter.PROMPT_VERSION,
            "reportId": req.reportId, **resp.model_dump()}


@router.get("/comparisons")
def compare_sessions(baselineId: str, retryId: str):
    a = storage.get("report", baselineId)
    b = storage.get("report", retryId)
    if not a or not b:
        raise _err(404, "REPORT_NOT_FOUND", "对比报告不存在")

    ma, mb = a["metrics"], b["metrics"]
    delta = {k: round(mb[k] - ma[k], 1) for k in
             ("pitchScore", "rhythmScore", "fluencyScore", "overallScore",
              "timingMaeMs", "avgBpm")}

    def err_key(e: dict) -> str:
        return f"{e['type']}@{e['location']['measure']}"

    set_a = {err_key(e) for e in a["errors"]}
    set_b = {err_key(e) for e in b["errors"]}
    resolved = sorted(set_a - set_b)
    persistent = sorted(set_a & set_b)
    new = sorted(set_b - set_a)

    improved = sum(1 for k in ("pitchScore", "rhythmScore",
                               "fluencyScore", "overallScore")
                   if delta[k] > 0)
    if resolved and improved >= 2:
        suggestion = (f"有 {len(resolved)} 处问题已解决，保持当前练习方法；"
                      f"剩余 {len(persistent)} 处建议继续慢速循环。")
    elif persistent:
        suggestion = (f"{len(persistent)} 处问题仍存在，"
                      f"建议降低速度阶梯一级并增加循环次数。")
    else:
        suggestion = "指标变化不明显，建议用同一练习再验证一次。"

    return {"baselineId": baselineId, "retryId": retryId,
            "metricDelta": delta, "resolvedErrors": resolved,
            "persistentErrors": persistent, "newErrors": new,
            "suggestion": suggestion}


# ---------------------------------------------------------------- 内置曲目注册

def register_builtin_scores() -> None:
    """启动时把 fixtures 中的 3 首内置曲注册进库（幂等）。"""
    fx = config.FIXTURES_DIR
    manifest = fx / "manifest.json"
    if not manifest.exists():
        return
    import json as _json
    for item in _json.loads(manifest.read_text()):
        score_id = item["scoreId"]
        xml_path = fx / item["musicxml"]
        if not xml_path.exists():
            continue
        content = xml_path.read_bytes()
        bundle = parse_musicxml(content, score_id)
        # 内置曲同时复制一份标准 MIDI 作为演示/降级素材
        std_midi = fx / item["standardMidi"]
        dst_xml = config.SCORE_STORAGE_DIR / f"{score_id}.musicxml"
        if not dst_xml.exists():
            shutil.copy(xml_path, dst_xml)
        if std_midi.exists():
            dst_mid = config.SESSION_STORAGE_DIR / f"{score_id}__standard.mid"
            if not dst_mid.exists():
                shutil.copy(std_midi, dst_mid)
        existing = storage.get("score", score_id)
        if not existing:
            storage.put("score", score_id, {
                "bundle": bundle.model_dump(), "builtin": True,
                "xmlPath": str(dst_xml), "createdAt": _now(),
                "title": item["title"]})
