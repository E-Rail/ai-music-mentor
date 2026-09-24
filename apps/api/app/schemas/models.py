"""核心数据模型（对应方案第 4 章）。

所有报告记录 algorithmVersion / thresholdProfile / scoreHash，保证同一份数据可复算。
AI 文本保存 modelAdapter / promptVersion / reportId，但不作为成绩真值。
"""
from __future__ import annotations

from enum import Enum
from typing import Any, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field, model_validator

ALGORITHM_VERSION = "1.3.0"
DEFAULT_THRESHOLD_PROFILE = "default-v3-velocity"


class Voiced(BaseModel):
    """A model whose text fields can be said again in another language.

    ``i18n`` maps a field name to the message it was made from (see
    ``app.i18n``). It is stored with the document so a report written in one
    language can be read in the other.
    """
    i18n: dict[str, Any] = Field(default_factory=dict)


class ScoreSourceType(str, Enum):
    musicxml = "musicxml"
    mxl = "mxl"
    midi = "midi"
    pdf = "pdf"
    image = "image"


class ScoreDisplayMode(str, Enum):
    exact_notation = "exact_notation"
    simplified_quantized_staff = "simplified_quantized_staff"


class InputSource(str, Enum):
    web_midi = "web-midi"
    microphone = "microphone"
    midi_upload = "midi-upload"


class InstrumentProfile(str, Enum):
    piano = "piano"
    guitar = "guitar"
    violin = "violin"


class SourceReference(BaseModel):
    """Immutable reference to an uploaded or generated artifact."""
    artifactId: str
    kind: str
    sha256: str
    originalName: str = ""


# ---------- 乐谱侧 ----------

class ScoreEvent(BaseModel):
    """评分的最小乐谱事件。eventId 规则：scoreId:part:measure:onset:index"""
    eventId: str
    measureNo: int
    onsetBeat: float            # 绝对拍点（反复记号已展开）
    absoluteBeat: Optional[float] = Field(default=None, ge=0, allow_inf_nan=False)
    durationBeat: float
    pitches: list[int]          # 和弦音共享 onsetBeat，合并为一个事件
    part: str = "RH"            # RH / LH
    voice: int = 1
    dynamicTarget: Optional[int] = None
    optional: bool = False      # 装饰音，不参与主评分
    # What the page asks of the note beyond its pitch and length: staccato,
    # staccatissimo, tenuto, accent, marcato, fermata. Read from the notation,
    # so a MIDI import never has any.
    articulations: list[str] = Field(default_factory=list)
    # Under a slur that carries on to this part's next note: the page asks for
    # the two to be joined.
    legatoToNext: bool = False


class TempoSpan(BaseModel):
    """A stretch of the piece at one written tempo, or moving away from one.

    ``shape`` is what the words over the staff ask for: *rit.* and *rall.* slow
    down, *accel.* speeds up, and a new metronome mark or *a tempo* is steady.
    A player who slows at a written *rit.* is reading the page, not losing
    the beat, and the tempo rules must be able to tell the two apart.
    """
    startBeat: float
    bpm: float
    shape: Literal["steady", "slowing", "speeding"] = "steady"


class Hairpin(BaseModel):
    """A written crescendo or diminuendo, in timeline beats."""
    startBeat: float
    endBeat: float
    kind: Literal["crescendo", "diminuendo"]


class ScoreMeta(BaseModel):
    scoreId: str
    title: str
    composer: str = ""
    tempo: float = 96.0         # BPM
    timeSignature: str = "4/4"
    beatsPerMeasure: float = 4.0
    measureCount: int = 0
    parts: list[str] = Field(default_factory=list)
    tempoMap: list[dict[str, Any]] = Field(default_factory=list)
    meterMap: list[dict[str, Any]] = Field(default_factory=list)
    writtenToSoundingSemitones: int = Field(default=0, ge=-48, le=48)
    # True only when the source carried written dynamic markings (p, mf, f…).
    # A MIDI file's note velocities are a recording of how someone played, not
    # an instruction on the page, so they must never be graded as one.
    hasNotatedDynamics: bool = False
    # What a musician calls each bar, in timeline order: measureLabels[n - 1] is
    # the label for measureNo n. Usually "1", "2", "3"…, but a pickup bar is
    # printed as 0 and every bar after it is one lower than its position. The
    # app must say the number that is printed on the page the student is reading.
    measureLabels: list[str] = Field(default_factory=list)
    # The written tempo through the piece, in timeline order. Empty for a score
    # imported before it was read, which means one steady tempo throughout.
    tempoPlan: list[TempoSpan] = Field(default_factory=list)
    hairpins: list[Hairpin] = Field(default_factory=list)
    scoreHash: str = ""
    builtin: bool = False


class ScoreBundle(BaseModel):
    meta: ScoreMeta
    events: list[ScoreEvent]


class ScoreNormalization(BaseModel):
    tempo: float = Field(gt=10, le=400)
    timeSignature: str = Field(pattern=r"^\d{1,2}/\d{1,2}$")
    quantization: Literal["1/4", "1/8", "1/12", "1/16", "1/24", "1/32"] = "1/16"
    trackMapping: dict[str, Literal["RH", "LH", "split", "ignore"]] = Field(default_factory=dict)
    confirmed: bool = False


class NormalizedScore(Voiced):
    scoreId: str
    sourceType: ScoreSourceType
    displayMode: ScoreDisplayMode
    bundle: ScoreBundle
    warnings: list[str] = Field(default_factory=list)
    confidence: float = Field(default=1.0, ge=0, le=1)
    normalization: ScoreNormalization
    sourceReferences: list[SourceReference] = Field(default_factory=list)


# ---------- 演奏侧 ----------

class PerformanceEvent(BaseModel):
    """原始演奏证据，不可被 AI 修改。"""
    id: str = Field(min_length=1, max_length=128)
    tOnMs: float = Field(ge=0, allow_inf_nan=False)
    tOffMs: float = Field(default=0.0, ge=0, allow_inf_nan=False)
    pitch: int = Field(ge=0, le=127)
    velocity: int = Field(default=64, ge=0, le=127)
    channel: int = Field(default=0, ge=0, le=15)
    source: str = Field(default="web-midi", min_length=1, max_length=32)
    pedalDown: bool = False
    # The sustain pedal was down when the key came up, so the note kept
    # sounding after its release: how long the key was held says nothing about
    # how long the note was heard.
    pedalAtRelease: bool = False
    receivedTimeMs: Optional[float] = Field(default=None, ge=0, allow_inf_nan=False)
    transcriptionConfidence: Optional[float] = Field(default=None, ge=0, le=1)
    pitchBendCents: Optional[float] = Field(default=None, ge=-1200, le=1200,
                                                    allow_inf_nan=False)

    @model_validator(mode="after")
    def validate_note_interval(self) -> "PerformanceEvent":
        if self.tOffMs and self.tOffMs < self.tOnMs:
            raise ValueError("tOffMs must be greater than or equal to tOnMs")
        return self


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
    # The music stopped where the page does not: a pause before a note, or
    # going back to play a passage again.
    hesitation = "hesitation"


class Severity(str, Enum):
    high = "high"
    medium = "medium"
    low = "low"


class Evidence(Voiced):
    id: str
    fact: str                        # 直接陈述 + 具体数值
    measureNo: int
    beat: float
    expected: str = ""
    actual: str = ""
    # The notes behind expected/actual, for playing them back. Parsing them out
    # of the sentence stopped working the moment the sentence could be English,
    # and never worked for evidence that is not about pitches at all.
    expectedPitches: list[int] = Field(default_factory=list)
    actualPitches: list[int] = Field(default_factory=list)
    deltaMs: Optional[float] = None
    deltaVelocity: Optional[float] = None


class ErrorEvent(Voiced):
    id: str
    type: ErrorType
    location: dict                   # {measure, beat, eventId}
    severity: Severity
    evidenceIds: list[str] = Field(default_factory=list)
    confidence: float                # 0–1；≥0.75 高，0.45–0.75 中，其余低
    detail: str = ""


class Pattern(Voiced):
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


class CaptureMeta(BaseModel):
    """Non-audio metadata produced by local microphone transcription."""
    model_config = ConfigDict(extra="forbid")
    transcriptionEngine: str = Field(default="", max_length=80)
    transcriptionVersion: str = Field(default="", max_length=40)
    thresholdProfile: str = Field(default="", max_length=80)
    audioDurationSeconds: float = Field(default=0, ge=0, le=90.5,
                                        allow_inf_nan=False)
    inferenceLatencyMs: float = Field(default=0, ge=0, allow_inf_nan=False)
    acceptedNoteCount: int = Field(default=0, ge=0, le=50_000)
    rejectedNoteCount: int = Field(default=0, ge=0, le=50_000)
    noiseFloorDb: Optional[float] = Field(default=None, ge=-160, le=20,
                                          allow_inf_nan=False)
    meanConfidence: Optional[float] = Field(default=None, ge=0, le=1)
    inputGainDb: Optional[float] = Field(default=None, ge=0, le=36,
                                         allow_inf_nan=False)
    rawPeakDb: Optional[float] = Field(default=None, ge=-160, le=20,
                                       allow_inf_nan=False)
    normalizedPeakDb: Optional[float] = Field(default=None, ge=-160, le=20,
                                              allow_inf_nan=False)
    signalToNoiseDb: Optional[float] = Field(default=None, ge=0, le=120,
                                             allow_inf_nan=False)
    lowVolumeRecovered: bool = False


class InputQuality(BaseModel):
    source: InputSource = InputSource.web_midi
    instrument: InstrumentProfile = InstrumentProfile.piano
    status: Literal["high", "medium", "low", "insufficient"] = "high"
    confidence: float = Field(default=1.0, ge=0, le=1)
    acceptedNoteCount: int = Field(default=0, ge=0)
    rejectedNoteCount: int = Field(default=0, ge=0)
    noiseFloorDb: Optional[float] = Field(default=None, ge=-160, le=20)
    transcriptionEngine: str = ""
    transcriptionVersion: str = ""


class TempoPoint(BaseModel):
    """The played tempo around one matched note: what the tempo curve draws."""
    beat: float
    measure: int
    bpm: float
    # What the page asks for here, so a written tempo change draws as a step
    # and not as the player drifting off one number.
    targetBpm: Optional[float] = None
    shape: Literal["steady", "slowing", "speeding"] = "steady"


class HandProfile(BaseModel):
    """How one hand did, measured on its own notes."""
    hand: Literal["RH", "LH"]
    expected: int = 0
    correct: int = 0
    # Mean absolute distance from where the take's own pulse put each note.
    timingMaeMs: Optional[float] = None
    # Median signed distance: + behind the pulse, − ahead of it.
    timingBiasMs: Optional[float] = None
    # Median key velocity. Only from an input that measures one (MIDI).
    medianVelocity: Optional[float] = None


class PerformanceProfile(BaseModel):
    """The measurements behind a teacher's second look at a take.

    Nothing here is a mistake on its own. The rules that grade — a written
    staccato held, a hairpin ignored — report errors; these are the numbers
    those rules and a musician read from: each hand on its own, how the hands
    line up, how wide the dynamics were, how the page's marks were met.
    """
    hands: list[HandProfile] = Field(default_factory=list)
    # Median of (left-hand onset − right-hand onset) where the page puts both
    # hands on one beat: + means the left hand lands after the right.
    handLagMs: Optional[float] = None
    handLagSamples: int = 0
    # Key velocities across the take: 10th percentile, median, 90th.
    velocityRange: Optional[list[float]] = None
    # Right-hand median velocity minus left-hand. + the right hand is louder.
    handBalance: Optional[float] = None
    staccatoChecked: int = 0
    staccatoMet: int = 0
    legatoChecked: int = 0
    legatoMet: int = 0
    accentsChecked: int = 0
    accentsMet: int = 0
    hairpinsChecked: int = 0
    hairpinsMet: int = 0
    # Note lengths not judged because the pedal carried the note on.
    pedalledReleases: int = 0
    hesitations: int = 0
    restarts: int = 0


class DiagnosisReport(Voiced):
    reportId: str
    sessionId: str
    scoreId: str
    metrics: Metrics
    errors: list[ErrorEvent] = Field(default_factory=list)
    evidences: list[Evidence] = Field(default_factory=list)
    patterns: list[Pattern] = Field(default_factory=list)
    hypotheses: list[dict] = Field(default_factory=list)  # {cause, confidence, limitation, i18n}
    algorithmVersion: str = ALGORITHM_VERSION
    thresholdProfile: str = DEFAULT_THRESHOLD_PROFILE
    scoreHash: str = ""
    sourceReferences: list[SourceReference] = Field(default_factory=list)
    inputQuality: InputQuality = Field(default_factory=InputQuality)
    warnings: list[str] = Field(default_factory=list)
    # How the take was measured rather than what is wrong with it. Kept apart
    # from warnings so a report does not flag its own method as a problem.
    notes: list[str] = Field(default_factory=list)
    tempoCurve: list[TempoPoint] = Field(default_factory=list)
    targetBpm: Optional[float] = None
    performance: Optional[PerformanceProfile] = None
    createdAt: str = ""


# ---------- 练习 / 伴奏 / AI 导师 ----------

class ExerciseParams(BaseModel):
    strategy: Literal[
        "auto", "loop", "slow_ladder", "hands_separate", "rhythm_variant",
        "beat_skeleton", "chunk_connect",
    ] = "loop"
    tempoRatio: float = Field(default=0.6, ge=0.25, le=1.25)
    hands: Optional[Literal["RH", "LH"]] = None
    loopCount: int = Field(default=4, ge=1, le=10)
    errorIds: list[str] = Field(default_factory=list)


class Exercise(Voiced):
    exerciseId: str
    sourceScoreId: str
    practiceScoreId: str = ""
    sourceMeasures: list[int]
    ruleId: str
    params: ExerciseParams
    musicXmlPath: str = ""
    midiPath: str = ""
    successCriterion: str = "pitchScore ≥ 95, timing MAE ≤ 120 ms"
    tempoPlan: list[float] = Field(default_factory=list)
    variationIndex: int = Field(default=0, ge=0)
    musicalFingerprint: str = ""
    cadencePlan: list[Literal[
        "half", "deceptive", "plagal", "authentic",
    ]] = Field(default_factory=list)


class MentorEvidence(BaseModel):
    model_config = ConfigDict(extra="forbid")
    measure: int = Field(ge=1)
    beat: float = Field(ge=0)
    fact: str = Field(min_length=1, max_length=500)


class MentorHypothesis(BaseModel):
    model_config = ConfigDict(extra="forbid")
    cause: str = Field(min_length=1, max_length=500)
    confidence: float = Field(ge=0, le=1)
    limitation: str = Field(min_length=1, max_length=500)


class MentorPlanItem(BaseModel):
    model_config = ConfigDict(extra="forbid")
    exerciseType: str = Field(min_length=1, max_length=80)
    measures: list[int] = Field(max_length=16)
    tempo: Optional[float] = Field(ge=20, le=300)
    repetitions: int = Field(ge=1, le=20)
    successCriterion: str = Field(min_length=1, max_length=500)
    label: str = Field(max_length=200)


class MentorResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")
    summary: str
    evidence: list[MentorEvidence]
    hypotheses: list[MentorHypothesis]
    plan: list[MentorPlanItem]
    encouragement: str


class MentorChatTurn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    role: Literal["user", "assistant"]
    content: str = Field(min_length=1, max_length=2_000)


class MentorChatAction(BaseModel):
    model_config = ConfigDict(extra="forbid")
    type: Literal["generate_exercise", "select_error", "retry", "none"]
    label: str = Field(min_length=1, max_length=160)
    errorId: Optional[str] = Field(default=None, max_length=128)


class MentorChatResponse(BaseModel):
    """A conversational answer; unlike MentorResponse it need not restate a report."""
    model_config = ConfigDict(extra="forbid")
    answer: str = Field(min_length=1, max_length=4_000)
    intent: Literal[
        "diagnosis", "technique", "theory", "repertoire", "practice_plan",
        "clarification", "other_music",
    ]
    evidenceIds: list[str] = Field(default_factory=list, max_length=12)
    professionalGuidance: list[str] = Field(default_factory=list, max_length=8)
    actions: list[MentorChatAction] = Field(default_factory=list, max_length=4)
    uncertainty: str = Field(default="", max_length=1_000)
    followUpQuestion: Optional[str] = Field(default=None, max_length=500)


class ExercisePlannerResponse(BaseModel):
    """AI may choose bounded parameters; deterministic code still builds the score."""
    model_config = ConfigDict(extra="forbid")
    title: str = Field(min_length=1, max_length=160)
    strategy: Literal[
        "loop", "slow_ladder", "hands_separate", "rhythm_variant",
        "beat_skeleton", "chunk_connect",
    ]
    errorIds: list[str] = Field(max_length=8)
    tempoRatio: float = Field(ge=0.25, le=1.25)
    loopCount: int = Field(ge=1, le=10)
    hands: Optional[Literal["RH", "LH"]]
    rationale: str = Field(min_length=1, max_length=800)
    noteAcknowledgement: str = Field(max_length=500)


class SessionComparison(BaseModel):
    baselineId: str
    retryId: str
    metricDelta: dict = Field(default_factory=dict)
    resolvedErrors: list[str] = Field(default_factory=list)
    persistentErrors: list[str] = Field(default_factory=list)
    newErrors: list[str] = Field(default_factory=list)
    suggestion: str = ""


class PracticeSession(BaseModel):
    sessionId: str
    profileId: str = "local"
    scoreId: str
    rangeStart: int
    rangeEnd: int
    device: str
    inputSource: InputSource = InputSource.web_midi
    instrument: InstrumentProfile = InstrumentProfile.piano
    status: Literal[
        "created", "recording", "device_lost", "queued", "analyzing",
        "completed", "failed", "discarded", "abandoned",
    ] = "created"
    countInBeats: int = Field(default=4, ge=1, le=12)
    countInBpm: float = Field(default=120, ge=20, le=300)
    createdAt: str
    sourceReferences: list[SourceReference] = Field(default_factory=list)


class AnalysisJob(BaseModel):
    analysisJobId: str
    sessionId: str
    status: Literal["queued", "running", "completed", "failed"]
    progress: int = Field(default=0, ge=0, le=100)
    reportId: Optional[str] = None
    errorCode: Optional[str] = None
    errorMessage: Optional[str] = None


# ---------- API 请求体 ----------

class SessionCreate(BaseModel):
    scoreId: str
    rangeStart: int = Field(default=1, ge=1)
    rangeEnd: int = Field(default=0, ge=0)  # 0 = 到结尾
    device: str = "web-midi"
    inputSource: Optional[InputSource] = None
    instrument: Optional[InstrumentProfile] = None
    countInBeats: Optional[int] = Field(default=None, ge=1, le=12)
    countInBpm: Optional[float] = Field(default=None, ge=20, le=300)

    @model_validator(mode="after")
    def validate_range_order(self) -> "SessionCreate":
        if self.rangeEnd and self.rangeEnd < self.rangeStart:
            raise ValueError("rangeEnd must be zero or greater than or equal to rangeStart")
        return self


class SessionFinish(BaseModel):
    events: list[PerformanceEvent] = Field(default_factory=list, max_length=50_000)
    uploadedMidiRef: Optional[str] = None
    captureMeta: Optional[CaptureMeta] = None


class EventBatchCreate(BaseModel):
    batchId: str = Field(min_length=1, max_length=128)
    sequence: int = Field(ge=0)
    events: list[PerformanceEvent] = Field(min_length=1, max_length=5_000)


class ScoreNormalizationPatch(BaseModel):
    tempo: float = Field(gt=10, le=400)
    timeSignature: str = Field(pattern=r"^\d{1,2}/\d{1,2}$")
    quantization: Literal["1/4", "1/8", "1/12", "1/16", "1/24", "1/32"] = "1/16"
    trackMapping: dict[str, Literal["RH", "LH", "split", "ignore"]] = Field(default_factory=dict)
    confirmed: bool = True


class ExerciseCreate(BaseModel):
    reportId: str
    errorIds: list[str] = Field(default_factory=list)
    params: ExerciseParams = Field(default_factory=ExerciseParams)
    aiAssist: bool = False
    generationNote: str = Field(default="", max_length=1_000)


class MentorRequest(BaseModel):
    reportId: str
    errorId: Optional[str] = None
    question: str = Field(default="", max_length=2_000)
    history: list[MentorChatTurn] = Field(default_factory=list, max_length=12)


class MentorChatRequest(BaseModel):
    reportId: str
    errorId: Optional[str] = None
    message: str = Field(min_length=1, max_length=2_000)
    history: list[MentorChatTurn] = Field(default_factory=list, max_length=12)


class AccompanimentCreate(BaseModel):
    scoreId: str
    rangeStart: int = Field(default=1, ge=1)
    rangeEnd: int = Field(default=0, ge=0)
    style: Literal["chord_bass"] = "chord_bass"
    mode: Literal["strict", "flexible"] = "flexible"

    @model_validator(mode="after")
    def validate_range_order(self) -> "AccompanimentCreate":
        if self.rangeEnd and self.rangeEnd < self.rangeStart:
            raise ValueError("rangeEnd must be zero or greater than or equal to rangeStart")
        return self


class ApiError(BaseModel):
    code: str
    message: str
