"""核心数据模型（对应方案第 4 章）。

所有报告记录 algorithmVersion / thresholdProfile / scoreHash，保证同一份数据可复算。
AI 文本保存 modelAdapter / promptVersion / reportId，但不作为成绩真值。
"""
from __future__ import annotations

from enum import Enum
from typing import Optional
from pydantic import BaseModel, Field

ALGORITHM_VERSION = "1.0.0"
DEFAULT_THRESHOLD_PROFILE = "default-v1"


# ---------- 乐谱侧 ----------

class ScoreEvent(BaseModel):
    """评分的最小乐谱事件。eventId 规则：scoreId:part:measure:onset:index"""
    eventId: str
    measureNo: int
    onsetBeat: float            # 绝对拍点（反复记号已展开）
    durationBeat: float
    pitches: list[int]          # 和弦音共享 onsetBeat，合并为一个事件
    part: str = "RH"            # RH / LH
    voice: int = 1
    dynamicTarget: Optional[int] = None
    optional: bool = False      # 装饰音，不参与主评分


class ScoreMeta(BaseModel):
    scoreId: str
    title: str
    composer: str = ""
    tempo: float = 96.0         # BPM
    timeSignature: str = "4/4"
    beatsPerMeasure: float = 4.0
    measureCount: int = 0
    parts: list[str] = Field(default_factory=list)
    scoreHash: str = ""
    builtin: bool = False


class ScoreBundle(BaseModel):
    meta: ScoreMeta
    events: list[ScoreEvent]


# ---------- 演奏侧 ----------

class PerformanceEvent(BaseModel):
    """原始演奏证据，不可被 AI 修改。"""
    id: str
    tOnMs: float
    tOffMs: float = 0.0
    pitch: int
    velocity: int = 64
    channel: int = 0
    source: str = "web-midi"
    pedalDown: bool = False


class PerformanceGroup(BaseModel):
    """和弦窗口聚合后的演奏组（与 ScoreEvent 比较的基本单元）。"""
    id: str
    tOnMs: float                       # 组内最早 onset
    tOffMs: float = 0.0
    pitches: list[int]
    velocities: list[int] = Field(default_factory=list)
    eventIds: list[str] = Field(default_factory=list)

    @property
    def durationMs(self) -> float:
        return max(0.0, self.tOffMs - self.tOnMs)


# ---------- 对齐与诊断 ----------

class AlignOp(str, Enum):
    match = "match"
    delete = "delete"          # 乐谱有、演奏无 → 漏音
    insert = "insert"          # 演奏有、乐谱无 → 多音
    substitute = "substitute"  # 位置相近但音高不同 → 错音


class AlignmentPair(BaseModel):
    scoreEventId: Optional[str] = None     # insert 时为空
    performanceId: Optional[str] = None    # delete 时为空
    operation: AlignOp
    cost: float
    confidence: float = 1.0
    onsetResidualMs: float = 0.0           # 实际 onset − 期望 onset（按 tempoMap 换算）
    durationRatio: float = 1.0             # 实际时值 / 期望时值


class ErrorType(str, Enum):
    wrong_pitch = "wrong_pitch"
    missed_note = "missed_note"
    extra_note = "extra_note"
    early_late = "early_late"        # 提前/延后
    duration_anomaly = "duration_anomaly"
    tempo_instability = "tempo_instability"
    dynamics_anomaly = "dynamics_anomaly"


class Severity(str, Enum):
    high = "high"
    medium = "medium"
    low = "low"


class Evidence(BaseModel):
    id: str
    fact: str                        # 直接陈述 + 具体数值
    measureNo: int
    beat: float
    expected: str = ""
    actual: str = ""
    deltaMs: Optional[float] = None


class ErrorEvent(BaseModel):
    id: str
    type: ErrorType
    location: dict                   # {measure, beat, eventId}
    severity: Severity
    evidenceIds: list[str] = Field(default_factory=list)
    confidence: float                # 0–1；≥0.75 高，0.45–0.75 中，其余低
    detail: str = ""


class Pattern(BaseModel):
    """模式判断：规则基于多个事实聚合。"""
    id: str
    description: str
    coveredErrorIds: list[str] = Field(default_factory=list)
    sampleCount: int = 0


class Metrics(BaseModel):
    pitchScore: float = 100.0
    rhythmScore: float = 100.0
    fluencyScore: float = 100.0
    dynamicsScore: float = 100.0
    overallScore: float = 100.0
    timingMaeMs: float = 0.0
    avgBpm: float = 0.0
    matchedCount: int = 0
    expectedCount: int = 0


class DiagnosisReport(BaseModel):
    reportId: str
    sessionId: str
    scoreId: str
    metrics: Metrics
    errors: list[ErrorEvent] = Field(default_factory=list)
    evidences: list[Evidence] = Field(default_factory=list)
    patterns: list[Pattern] = Field(default_factory=list)
    hypotheses: list[dict] = Field(default_factory=list)  # {cause, confidence, limitation}
    algorithmVersion: str = ALGORITHM_VERSION
    thresholdProfile: str = DEFAULT_THRESHOLD_PROFILE
    scoreHash: str = ""
    createdAt: str = ""


# ---------- 练习 / 伴奏 / AI 导师 ----------

class ExerciseParams(BaseModel):
    strategy: str = "loop"           # loop | slow_ladder | hands_separate | rhythm_variant | beat_skeleton | chunk_connect
    tempoRatio: float = 0.6
    hands: Optional[str] = None      # RH / LH
    loopCount: int = 4
    errorIds: list[str] = Field(default_factory=list)


class Exercise(BaseModel):
    exerciseId: str
    sourceScoreId: str
    sourceMeasures: list[int]
    ruleId: str
    params: ExerciseParams
    musicXmlPath: str = ""
    midiPath: str = ""
    successCriterion: str = "连续两次 pitchScore ≥ 95 且 timing MAE ≤ 120 ms"
    tempoPlan: list[float] = Field(default_factory=list)


class MentorResponse(BaseModel):
    summary: str
    evidence: list[dict] = Field(default_factory=list)    # {measure, beat, fact}
    hypotheses: list[dict] = Field(default_factory=list)  # {cause, confidence, limitation}
    plan: list[dict] = Field(default_factory=list)        # {exerciseType, measures, tempo, repetitions, successCriterion}
    encouragement: str = ""


class SessionComparison(BaseModel):
    baselineId: str
    retryId: str
    metricDelta: dict = Field(default_factory=dict)
    resolvedErrors: list[str] = Field(default_factory=list)
    persistentErrors: list[str] = Field(default_factory=list)
    newErrors: list[str] = Field(default_factory=list)
    suggestion: str = ""


# ---------- API 请求体 ----------

class SessionCreate(BaseModel):
    scoreId: str
    rangeStart: int = 1
    rangeEnd: int = 0               # 0 = 到结尾
    device: str = "web-midi"


class SessionFinish(BaseModel):
    events: list[PerformanceEvent]
    uploadedMidiRef: Optional[str] = None


class ExerciseCreate(BaseModel):
    reportId: str
    errorIds: list[str] = Field(default_factory=list)
    params: ExerciseParams = Field(default_factory=ExerciseParams)


class MentorRequest(BaseModel):
    reportId: str
    errorId: Optional[str] = None
    question: str = ""


class AccompanimentCreate(BaseModel):
    scoreId: str
    rangeStart: int = 1
    rangeEnd: int = 0
    style: str = "chord_bass"       # 简化和弦/低音
    mode: str = "flexible"          # strict | flexible


class ApiError(BaseModel):
    code: str
    message: str
