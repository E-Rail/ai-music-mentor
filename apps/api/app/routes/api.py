"""Versioned REST/WS API for import, capture, analysis, training, and comparison."""
from __future__ import annotations

import uuid
import tempfile
from datetime import datetime, timezone
from pathlib import Path

from fastapi import (APIRouter, File, HTTPException, Request, Response,
                     UploadFile, WebSocket, WebSocketDisconnect)
from fastapi.responses import FileResponse, JSONResponse
from pydantic import ValidationError

from app import config, storage
from app.db import repositories
from app.schemas.models import (AccompanimentCreate, ApiError, DiagnosisReport,
                                EventBatchCreate, ExerciseCreate, MentorRequest,
                                PerformanceEvent, ScoreBundle,
                                ScoreNormalization, ScoreNormalizationPatch,
                                SessionCreate, SessionFinish)
from app.services import analysis_jobs
from app.services.comparison import compare_reports
from app.services.file_store import artifact_path, local_file_store
from app.services.generation.accompaniment import generate_accompaniment
from app.services.generation.exercises import generate_exercise, suggest_strategy
from app.services.importers.base import ScoreImportError
from app.services.mentor import adapter as mentor_adapter
from app.services.midi_io import (MidiFileValidationError, load_midi_events,
                                  validate_midi_bytes)
from app.services.score_ingestion import ingest_score, renormalize_midi

router = APIRouter()


def _err(status: int, code: str, message: str) -> HTTPException:
    return HTTPException(status_code=status,
                         detail=ApiError(code=code, message=message).model_dump())


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:12]}"


def _api_prefix(request: Request | None = None) -> str:
    if request and request.url.path.startswith("/api/") and not request.url.path.startswith("/api/v1/"):
        return "/api"
    return "/api/v1"


def _load_bundle(score_id: str) -> ScoreBundle:
    data = storage.get("score", score_id)
    if not data:
        raise _err(404, "SCORE_NOT_FOUND", f"曲目 {score_id} 不存在")
    return ScoreBundle.model_validate(data["bundle"])


def _validated_range(bundle: ScoreBundle, start: int, end: int) -> tuple[int, int]:
    resolved_end = end or bundle.meta.measureCount
    if (start < 1 or start > bundle.meta.measureCount or
            resolved_end < start or resolved_end > bundle.meta.measureCount):
        raise _err(400, "RANGE_INVALID",
                   f"练习范围必须在 1–{bundle.meta.measureCount} 小节内")
    return start, resolved_end


def _uploaded_midi_path(session_id: str, reference: str) -> Path:
    """Resolve only a performance upload issued for this exact session."""
    if (Path(reference).name != reference or
            not reference.startswith(f"{session_id}_")):
        raise _err(400, "MIDI_FILE_INVALID", "MIDI 文件引用无效，请重新上传")
    mapping = storage.get("session_upload", reference)
    if mapping and mapping.get("sessionId") == session_id:
        path = artifact_path(mapping.get("artifactId", ""))
        if path:
            return path
    # Read-only compatibility with captures created by demo v1.
    path = (config.SESSION_STORAGE_DIR / reference).resolve()
    try:
        path.relative_to(config.SESSION_STORAGE_DIR.resolve())
    except ValueError as exc:
        raise _err(400, "MIDI_FILE_INVALID", "MIDI 文件引用无效，请重新上传") from exc
    if not path.exists() or not path.is_file():
        raise _err(400, "MIDI_FILE_NOT_FOUND", "上传的 MIDI 文件不存在")
    return path


def _score_payload(score_id: str, data: dict, request: Request | None = None) -> dict:
    bundle = ScoreBundle.model_validate(data["bundle"])
    prefix = _api_prefix(request)
    return {
        "scoreId": score_id,
        "sourceType": data.get("sourceType", "musicxml"),
        "displayMode": data.get("displayMode", "exact_notation"),
        "metadata": bundle.meta.model_dump(),
        "normalizedMetadata": bundle.meta.model_dump(),
        "scoreEvents": [event.model_dump() for event in bundle.events],
        "warnings": data.get("warnings", []),
        "confidence": data.get("confidence", 1.0),
        "normalization": data.get("normalization", {}),
        "sourceReferences": data.get("sourceReferences", []),
        "generated": bool(data.get("generated", False)),
        "parentScoreId": data.get("parentScoreId"),
        "rootScoreId": data.get("rootScoreId") or score_id,
        "lineageDepth": int(data.get("lineageDepth", 0)),
        "sourceExerciseId": data.get("sourceExerciseId"),
        "sourceReportId": data.get("sourceReportId"),
        "renderUrl": f"{prefix}/scores/{score_id}/render.musicxml",
        "timelineUrl": (f"{prefix}/scores/{score_id}/timeline.midi"
                        if (data.get("sourceType") == "midi" or
                            data.get("timelineArtifactId")) else None),
    }


# ---------------------------------------------------------------- scores / import

@router.get("/scores")
def list_scores():
    scores = []
    for record in storage.list_kind("score"):
        meta = record["bundle"]["meta"]
        scores.append({
            **meta,
            "builtin": record.get("builtin", False),
            "sourceType": record.get("sourceType", "musicxml"),
            "displayMode": record.get("displayMode", "exact_notation"),
            "warnings": record.get("warnings", []),
            "confidence": record.get("confidence", 1.0),
            "generated": bool(record.get("generated", False)),
            "parentScoreId": record.get("parentScoreId"),
            "rootScoreId": record.get("rootScoreId") or meta.get("scoreId"),
            "lineageDepth": int(record.get("lineageDepth", 0)),
        })
    return {"scores": scores}


@router.post("/scores/import", status_code=201)
async def import_score(request: Request, file: UploadFile = File(...)):
    content = await file.read(config.MAX_SCORE_BYTES + 1)
    try:
        normalized = ingest_score(file.filename or "score", content)
    except ScoreImportError as exc:
        raise _err(400, getattr(exc, "code", "SCORE_UNSUPPORTED"), str(exc)) from exc
    data = storage.get("score", normalized.scoreId)
    return _score_payload(normalized.scoreId, data or {}, request)


@router.patch("/scores/{score_id}/normalization")
def patch_score_normalization(score_id: str, body: ScoreNormalizationPatch,
                              request: Request):
    try:
        normalized = renormalize_midi(score_id, ScoreNormalization.model_validate(body.model_dump()))
    except ScoreImportError as exc:
        code = "SCORE_NOT_FOUND" if "不存在" in str(exc) else getattr(exc, "code", "SCORE_UNSUPPORTED")
        raise _err(404 if code == "SCORE_NOT_FOUND" else 400, code, str(exc)) from exc
    return _score_payload(score_id, storage.get("score", normalized.scoreId) or {}, request)


@router.get("/scores/{score_id}")
def get_score(score_id: str, request: Request):
    data = storage.get("score", score_id)
    if not data:
        raise _err(404, "SCORE_NOT_FOUND", f"曲目 {score_id} 不存在")
    return _score_payload(score_id, data, request)


@router.get("/scores/{score_id}/render.musicxml")
@router.get("/scores/{score_id}/musicxml", include_in_schema=False)
def get_score_xml(score_id: str):
    data = storage.get("score", score_id)
    if not data:
        raise _err(404, "SCORE_NOT_FOUND", f"曲目 {score_id} 不存在")
    path = artifact_path(data.get("renderArtifactId", ""))
    if not path and data.get("xmlPath"):
        path = Path(data["xmlPath"])
    if not path or not path.exists():
        raise _err(404, "SCORE_NOT_FOUND", "乐谱渲染文件缺失")
    return FileResponse(path, media_type="application/vnd.recordare.musicxml")


@router.get("/scores/{score_id}/timeline.midi")
def get_score_timeline(score_id: str):
    data = storage.get("score", score_id)
    if not data:
        raise _err(404, "SCORE_NOT_FOUND", f"曲目 {score_id} 不存在")
    timeline_artifact_id = data.get("timelineArtifactId")
    if data.get("sourceType") != "midi" and not timeline_artifact_id:
        raise _err(404, "TIMELINE_NOT_AVAILABLE", "该 MusicXML 曲目没有原始 MIDI 时间线")
    path = artifact_path(timeline_artifact_id or data.get("sourceArtifactId", ""))
    if not path:
        raise _err(404, "TIMELINE_NOT_AVAILABLE", "原始 MIDI 时间线缺失")
    return FileResponse(path, media_type="audio/midi")


# ---------------------------------------------------------------- sessions / capture / analysis

@router.post("/sessions", status_code=201)
def create_session(req: SessionCreate):
    bundle = _load_bundle(req.scoreId)
    range_start, range_end = _validated_range(bundle, req.rangeStart, req.rangeEnd)
    session_id = _new_id("sess")
    count_in_beats = req.countInBeats or max(1, round(bundle.meta.beatsPerMeasure))
    count_in_bpm = req.countInBpm or bundle.meta.tempo
    storage.put("session", session_id, {
        "id": session_id, "sessionId": session_id, "profileId": config.LOCAL_PROFILE_ID,
        "scoreId": req.scoreId, "rangeStart": range_start, "rangeEnd": range_end,
        "device": req.device, "startedAt": _now(), "status": "recording",
        "countIn": {"beats": count_in_beats, "bpm": count_in_bpm},
    })
    return {"sessionId": session_id,
            "countIn": {"beats": count_in_beats, "bpm": count_in_bpm}}


@router.post("/sessions/{session_id}/event-batches")
def persist_event_batch(session_id: str, req: EventBatchCreate):
    session = storage.get("session", session_id)
    if not session:
        raise _err(404, "SESSION_NOT_FOUND", f"会话 {session_id} 不存在")
    if session.get("status") not in {"recording", "device_lost", "failed"}:
        raise _err(409, "SESSION_CLOSED", "该会话已提交，不能追加演奏事件")
    existing_ids = {event["id"] for event in repositories.get_session_events(session_id)}
    incoming_ids = {event.id for event in req.events}
    if len(existing_ids | incoming_ids) > config.MAX_PERFORMANCE_EVENTS:
        raise _err(400, "TOO_MANY_EVENTS", "演奏事件数量超过上限，请缩短练习范围")
    try:
        return repositories.append_event_batch(
            session_id, req.batchId, req.sequence,
            [event.model_dump() for event in req.events],
        )
    except ValueError as exc:
        if str(exc) == "BATCH_ID_CONFLICT":
            raise _err(409, "BATCH_ID_CONFLICT", "相同批次 ID 的内容不一致") from exc
        raise


@router.post("/sessions/{session_id}/device-lost")
def mark_device_lost(session_id: str):
    session = storage.get("session", session_id)
    if not session:
        raise _err(404, "SESSION_NOT_FOUND", f"会话 {session_id} 不存在")
    if session.get("status") == "recording":
        session["status"] = "device_lost"
        storage.put("session", session_id, session)
    return {"sessionId": session_id, "status": session.get("status")}


@router.delete("/sessions/{session_id}")
def discard_session(session_id: str):
    session = storage.get("session", session_id)
    if not session:
        raise _err(404, "SESSION_NOT_FOUND", f"会话 {session_id} 不存在")
    if session.get("status") in {"queued", "running", "completed", "analyzed"}:
        raise _err(409, "SESSION_CLOSED", "已提交分析的会话不能丢弃")
    session["status"] = "discarded"
    storage.put("session", session_id, session)
    return Response(status_code=204)


@router.websocket("/ws/sessions/{session_id}/events")
async def session_events_ws(ws: WebSocket, session_id: str):
    await ws.accept()
    session = storage.get("session", session_id)
    if not session:
        await ws.close(code=4404)
        return
    sequence = 0
    try:
        while True:
            message = await ws.receive_json()
            raw = message.get("events", []) if isinstance(message, dict) else []
            try:
                events = [PerformanceEvent.model_validate(event) for event in raw]
                if not events:
                    raise ValueError
            except (ValidationError, ValueError, TypeError):
                await ws.send_json({"error": {"code": "EVENT_INVALID",
                                               "message": "MIDI 事件字段不合法"}})
                continue
            existing_ids = {event["id"] for event in repositories.get_session_events(session_id)}
            if len(existing_ids | {event.id for event in events}) > config.MAX_PERFORMANCE_EVENTS:
                await ws.send_json({"error": {"code": "TOO_MANY_EVENTS",
                                               "message": "演奏事件数量超过上限"}})
                await ws.close(code=4400)
                return
            sequence += 1
            result = repositories.append_event_batch(
                session_id, str(message.get("batchId") or f"ws-{sequence}"),
                int(message.get("sequence", sequence)),
                [event.model_dump() for event in events],
            )
            await ws.send_json({"ack": result})
    except WebSocketDisconnect:
        return


@router.post("/sessions/{session_id}/upload-midi")
async def upload_midi(session_id: str, file: UploadFile = File(...)):
    session = storage.get("session", session_id)
    if not session:
        raise _err(404, "SESSION_NOT_FOUND", f"会话 {session_id} 不存在")
    if session.get("status") not in {"recording", "device_lost", "failed"}:
        raise _err(409, "SESSION_CLOSED", "该会话已提交，不能再上传 MIDI")
    suffix = Path(file.filename or "").suffix.lower()
    if suffix not in {".mid", ".midi"}:
        raise _err(400, "MIDI_FILE_INVALID", "仅支持 .mid/.midi 文件")
    content = await file.read(config.MAX_MIDI_BYTES + 1)
    if not content:
        raise _err(400, "MIDI_FILE_INVALID", "MIDI 文件为空")
    if len(content) > config.MAX_MIDI_BYTES:
        raise _err(400, "MIDI_FILE_TOO_LARGE",
                   f"MIDI 文件超过 {config.MAX_MIDI_BYTES // (1024 * 1024)} MB 上限")
    try:
        validate_midi_bytes(content)
    except MidiFileValidationError as exc:
        raise _err(400, "MIDI_FILE_INVALID", str(exc)) from exc
    artifact = local_file_store.put(
        kind="performance-upload", content=content,
        original_name=file.filename or "performance.mid", suffix=suffix,
        media_type="audio/midi",
    )
    reference = f"{session_id}_{artifact.artifact_id}"
    storage.put("session_upload", reference, {
        "sessionId": session_id, "artifactId": artifact.artifact_id,
        "originalName": file.filename or "performance.mid", "createdAt": _now(),
    })
    return {"uploadedMidiRef": reference, "originalName": file.filename,
            "artifactId": artifact.artifact_id}


@router.post("/sessions/{session_id}/finish", status_code=202)
def finish_session(session_id: str, req: SessionFinish):
    session = storage.get("session", session_id)
    if not session:
        raise _err(404, "SESSION_NOT_FOUND", f"会话 {session_id} 不存在")
    if session.get("status") in {"completed", "analyzed"} and session.get("reportId"):
        return {"analysisJobId": session.get("jobId"),
                "reportId": session["reportId"]}
    if session.get("jobId"):
        existing = repositories.get_job(session["jobId"])
        if existing:
            return {"analysisJobId": existing["analysisJobId"],
                    "reportId": existing.get("reportId"), "status": existing["status"]}
    events = list(req.events)
    if not events and req.uploadedMidiRef:
        path = _uploaded_midi_path(session_id, req.uploadedMidiRef)
        try:
            events = load_midi_events(str(path))
        except Exception as exc:
            raise _err(400, "MIDI_FILE_INVALID", "无法解析该 MIDI 文件，请重新导出后上传") from exc
    if events:
        repositories.append_event_batch(
            session_id, f"finish-{session_id}", 2_147_483_647,
            [event.model_dump() for event in events],
        )
    persisted = repositories.get_session_events(session_id)
    if len(persisted) > config.MAX_PERFORMANCE_EVENTS:
        raise _err(400, "TOO_MANY_EVENTS", "演奏事件数量超过上限，请缩短练习范围")
    if not persisted:
        raise _err(400, "NO_PERFORMANCE_EVENTS", "没有演奏事件，请重录")
    job = analysis_jobs.create_or_get_job(session_id)
    job_id = job.get("analysisJobId") or job.get("id")
    analysis_jobs.enqueue(job_id)
    return JSONResponse(status_code=202, content={
        "analysisJobId": job_id, "reportId": job.get("reportId"),
        "status": job.get("status", "queued"),
    })


@router.get("/analysis/{job_id}")
def get_analysis(job_id: str):
    job = repositories.get_job(job_id)
    if not job:
        raise _err(404, "JOB_NOT_FOUND", f"分析任务 {job_id} 不存在")
    return job


@router.get("/reports/{report_id}")
def get_report(report_id: str):
    report = storage.get("report", report_id)
    if not report:
        raise _err(404, "REPORT_NOT_FOUND", f"报告 {report_id} 不存在")
    return report


# ---------------------------------------------------------------- exercise / accompaniment / mentor / comparison

def _public_exercise(exercise_id: str, exercise: dict, request: Request) -> dict:
    """Return only stable, client-safe exercise fields for create and recovery."""
    prefix = _api_prefix(request)
    optional = {
        key: exercise[key]
        for key in (
            "aiPlan", "plannerProvider", "plannerModel", "plannerLatencyMs",
            "plannerFallbackReason", "algorithmVersion", "lineageDepth",
        )
        if key in exercise
    }
    return {
        "exerciseId": exercise_id,
        "sourceScoreId": exercise.get("sourceScoreId"),
        "practiceScoreId": exercise.get("practiceScoreId"),
        "ruleId": exercise["ruleId"],
        "sourceMeasures": exercise["sourceMeasures"],
        "tempoPlan": exercise.get("tempoPlan", []),
        "successCriterion": exercise["successCriterion"],
        "musicXmlUrl": f"{prefix}/exercises/{exercise_id}/musicxml",
        "midiUrl": f"{prefix}/exercises/{exercise_id}/midi",
        **optional,
    }


@router.post("/exercises", status_code=201)
def create_exercise(req: ExerciseCreate, request: Request):
    report_data = storage.get("report", req.reportId)
    if not report_data:
        raise _err(404, "REPORT_NOT_FOUND", f"报告 {req.reportId} 不存在")
    report = DiagnosisReport.model_validate(report_data)
    bundle = _load_bundle(report.scoreId)
    # errorIds is part of the public request rather than nested params; merge it
    # before either AI planning or deterministic generation.
    params = req.params.model_copy(update={"errorIds": req.errorIds})
    planner_outcome = None
    if req.aiAssist:
        planner_outcome = mentor_adapter.plan_exercise(
            report, req.generationNote, req.errorIds, params, bundle.meta.parts)
        plan = planner_outcome.response
        params = params.model_copy(update={
            "strategy": plan.strategy, "errorIds": plan.errorIds,
            "tempoRatio": plan.tempoRatio, "loopCount": plan.loopCount,
            "hands": plan.hands,
        })
        repositories.save_mentor_interaction({
            "reportId": req.reportId, "provider": planner_outcome.provider,
            "model": planner_outcome.model,
            "promptVersion": mentor_adapter.EXERCISE_PROMPT_VERSION,
            "responseMode": planner_outcome.response_mode,
            "latencyMs": planner_outcome.latency_ms,
            "fallbackReason": planner_outcome.fallback_reason,
            "payload": {
                "kind": "exercise-planner", "hasUserNote": bool(req.generationNote),
                "selectedErrorCount": len(plan.errorIds),
            },
        })
    elif params.strategy == "auto":
        params = params.model_copy(update={"strategy": suggest_strategy(report)})
    with tempfile.TemporaryDirectory(prefix="music-mentor-exercise-") as temp_dir:
        exercise = generate_exercise(report, bundle, params, Path(temp_dir))
        xml_content = Path(exercise.musicXmlPath).read_bytes()
        midi_content = Path(exercise.midiPath).read_bytes()
        practice_score_id = f"practice_{exercise.exerciseId}"
        # Generated notation re-enters the exact same validated ingestion
        # pipeline as an upload. From this point it is a normal score target.
        ingest_score(
            f"{practice_score_id}.musicxml", xml_content,
            score_id=practice_score_id,
        )
        midi_artifact = local_file_store.put(
            kind="score-timeline", content=midi_content,
            original_name=f"{exercise.exerciseId}.mid", suffix=".mid",
            media_type="audio/midi", generated=False,
        )

    practice_data = storage.get("score", practice_score_id)
    parent_data = storage.get("score", report.scoreId)
    if not practice_data or not parent_data:
        raise _err(500, "EXERCISE_SCORE_FAILED", "生成练习无法注册为可分析曲目")
    lineage_depth = int(parent_data.get("lineageDepth", 0)) + 1
    root_score_id = parent_data.get("rootScoreId") or report.scoreId
    timeline_reference = {
        "artifactId": midi_artifact.artifact_id, "kind": "score-timeline",
        "sha256": midi_artifact.sha256, "originalName": midi_artifact.original_name,
    }
    practice_data = {
        **practice_data,
        "generated": True,
        "parentScoreId": report.scoreId,
        "rootScoreId": root_score_id,
        "lineageDepth": lineage_depth,
        "sourceExerciseId": exercise.exerciseId,
        "sourceReportId": req.reportId,
        "timelineArtifactId": midi_artifact.artifact_id,
        "sourceReferences": [*practice_data.get("sourceReferences", []), timeline_reference],
    }
    storage.put("score", practice_score_id, practice_data)
    exercise.practiceScoreId = practice_score_id
    exercise.musicXmlPath = practice_data["xmlPath"]
    exercise.midiPath = str(local_file_store.resolve(midi_artifact.storage_key))
    planner_payload = ({
        "aiPlan": planner_outcome.response.model_dump(),
        "plannerProvider": planner_outcome.provider,
        "plannerModel": planner_outcome.model,
        "plannerLatencyMs": planner_outcome.latency_ms,
        "plannerFallbackReason": planner_outcome.fallback_reason,
    } if planner_outcome else {})
    payload = {**exercise.model_dump(), **planner_payload,
               "generationNote": req.generationNote, "reportId": req.reportId,
               "lineageDepth": lineage_depth,
               "algorithmVersion": report.algorithmVersion,
               "thresholdProfile": report.thresholdProfile,
               "scoreHash": report.scoreHash,
               "sourceReferences": [*report_data.get("sourceReferences", []),
                                    *practice_data.get("sourceReferences", [])]}
    storage.put("exercise", exercise.exerciseId, payload)
    return _public_exercise(exercise.exerciseId, payload, request)


@router.get("/exercises/{exercise_id}")
def get_exercise(exercise_id: str, request: Request):
    exercise = storage.get("exercise", exercise_id)
    if not exercise:
        raise _err(404, "EXERCISE_NOT_FOUND", "练习不存在或已经过期")
    return _public_exercise(exercise_id, exercise, request)


@router.get("/exercises/{exercise_id}/musicxml")
def get_exercise_xml(exercise_id: str):
    exercise = storage.get("exercise", exercise_id)
    if not exercise or not Path(exercise["musicXmlPath"]).exists():
        raise _err(404, "EXERCISE_NOT_FOUND", "练习不存在")
    return FileResponse(exercise["musicXmlPath"], media_type="application/vnd.recordare.musicxml")


@router.get("/exercises/{exercise_id}/midi")
def get_exercise_midi(exercise_id: str):
    exercise = storage.get("exercise", exercise_id)
    if not exercise or not Path(exercise["midiPath"]).exists():
        raise _err(404, "EXERCISE_NOT_FOUND", "练习不存在")
    return FileResponse(exercise["midiPath"], media_type="audio/midi")


@router.post("/accompaniments", status_code=201)
def create_accompaniment(req: AccompanimentCreate, request: Request):
    bundle = _load_bundle(req.scoreId)
    range_start, range_end = _validated_range(bundle, req.rangeStart, req.rangeEnd)
    with tempfile.TemporaryDirectory(prefix="music-mentor-accompaniment-") as temp_dir:
        result = generate_accompaniment(bundle, range_start, range_end, Path(temp_dir))
        midi_artifact = local_file_store.put(
            kind="accompaniment", content=Path(result["midiPath"]).read_bytes(),
            original_name=f"{result['accompanimentId']}.mid", suffix=".mid",
            media_type="audio/midi", generated=True,
        )
    result["midiPath"] = str(local_file_store.resolve(midi_artifact.storage_key))
    storage.put("accompaniment", result["accompanimentId"], {
        **result, "mode": req.mode, "scoreHash": bundle.meta.scoreHash,
        "artifactId": midi_artifact.artifact_id,
    })
    return {
        "accompanimentId": result["accompanimentId"],
        "baseTempo": result["baseTempo"], "harmonyEvents": result["harmonyEvents"],
        "beatsPerMeasure": result["beatsPerMeasure"],
        "mode": req.mode,
        "midiUrl": f"{_api_prefix(request)}/accompaniments/{result['accompanimentId']}/midi",
    }


@router.get("/accompaniments/{acc_id}/midi")
def get_accompaniment_midi(acc_id: str):
    accompaniment = storage.get("accompaniment", acc_id)
    if not accompaniment or not Path(accompaniment["midiPath"]).exists():
        raise _err(404, "ACCOMPANIMENT_NOT_FOUND", "伴奏不存在")
    return FileResponse(accompaniment["midiPath"], media_type="audio/midi")


@router.post("/mentor/responses")
@router.post("/mentor/respond", include_in_schema=False)
def mentor_respond(req: MentorRequest):
    report_data = storage.get("report", req.reportId)
    if not report_data:
        raise _err(404, "REPORT_NOT_FOUND", f"报告 {req.reportId} 不存在")
    report = DiagnosisReport.model_validate(report_data)
    outcome = mentor_adapter.respond(report, req.question, req.errorId, req.history)
    repositories.save_mentor_interaction({
        "reportId": req.reportId, "provider": outcome.provider,
        "model": outcome.model, "promptVersion": mentor_adapter.PROMPT_VERSION,
        "responseMode": outcome.response_mode, "latencyMs": outcome.latency_ms,
        "fallbackReason": outcome.fallback_reason,
        "payload": {
            "kind": "chat" if req.history else "explanation",
            "selectedErrorId": req.errorId, "hasQuestion": bool(req.question),
            "historyCount": len(req.history),
        },
    })
    return {
        "provider": outcome.provider, "model": outcome.model,
        "promptVersion": mentor_adapter.PROMPT_VERSION,
        "responseMode": outcome.response_mode, "latencyMs": outcome.latency_ms,
        "fallbackReason": outcome.fallback_reason, "reportId": req.reportId,
        **outcome.response.model_dump(),
    }


@router.get("/comparisons")
def compare_sessions(baselineId: str, retryId: str):
    baseline = storage.get("report", baselineId)
    retry = storage.get("report", retryId)
    if not baseline or not retry:
        raise _err(404, "REPORT_NOT_FOUND", "对比报告不存在")
    baseline_score_id = baseline.get("scoreId", "")
    retry_score_id = retry.get("scoreId", "")
    baseline_score = storage.get("score", baseline_score_id) or {}
    retry_score = storage.get("score", retry_score_id) or {}
    baseline_root = baseline_score.get("rootScoreId") or baseline_score_id
    retry_root = retry_score.get("rootScoreId") or retry_score_id
    if baseline_root != retry_root:
        raise _err(400, "COMPARISON_MISMATCH", "只能对比同一首曲目的两次演奏")
    target_changed = baseline_score_id != retry_score_id
    result = {"baselineId": baselineId, "retryId": retryId,
              "baselineScoreId": baseline_score_id, "retryScoreId": retry_score_id,
              **compare_reports(baseline, retry, target_changed=target_changed)}
    repositories.save_comparison(result)
    return result


def register_builtin_scores() -> None:
    """Register controlled offline fixtures through the same importer contract."""
    manifest = config.FIXTURES_DIR / "manifest.json"
    if not manifest.exists():
        return
    import json

    for item in json.loads(manifest.read_text()):
        score_id = item["scoreId"]
        if storage.get("score", score_id):
            continue
        xml_path = config.FIXTURES_DIR / item["musicxml"]
        if not xml_path.exists():
            continue
        ingest_score(xml_path.name, xml_path.read_bytes(), score_id=score_id, builtin=True)
