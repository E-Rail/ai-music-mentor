// 与后端 packages/shared-schema 对齐的 API 类型

export interface ScoreEvent {
  eventId: string
  measureNo: number
  onsetBeat: number
  absoluteBeat?: number | null
  durationBeat: number
  pitches: number[]
  part: string
  voice: number
  dynamicTarget: number | null
  optional: boolean
}

export interface ScoreMeta {
  scoreId: string
  title: string
  composer: string
  tempo: number
  timeSignature: string
  beatsPerMeasure: number
  measureCount: number
  parts: string[]
  tempoMap?: { measureNo?: number; onsetBeat?: number; absoluteBeat?: number; bpm: number }[]
  meterMap?: { measureNo?: number; onsetBeat?: number; absoluteBeat?: number; timeSignature: string }[]
  writtenToSoundingSemitones?: number
  scoreHash: string
}

export type ScoreSourceType = 'musicxml' | 'mxl' | 'midi'
export type ScoreDisplayMode = 'exact_notation' | 'simplified_quantized_staff'
export type ScoreLibraryCategory = 'demo' | 'uploaded' | 'generated' | 'internal'
export type InputSource = 'web-midi' | 'microphone' | 'midi-upload'
export type InstrumentProfile = 'piano' | 'guitar' | 'violin'

export interface ScoreNormalization {
  tempo: number
  timeSignature: string
  quantization: '1/4' | '1/8' | '1/12' | '1/16' | '1/24' | '1/32'
  trackMapping: Record<string, 'RH' | 'LH' | 'split' | 'ignore'>
  confirmed: boolean
}

export interface ScoreDetail {
  scoreId: string
  sourceType: ScoreSourceType
  displayMode: ScoreDisplayMode
  metadata: ScoreMeta
  normalizedMetadata: ScoreMeta
  scoreEvents: ScoreEvent[]
  warnings: string[]
  confidence: number
  normalization: ScoreNormalization
  sourceReferences: { artifactId: string; kind: string; sha256: string; originalName: string }[]
  sourceName?: string | null
  libraryCategory?: ScoreLibraryCategory
  renderUrl: string
  timelineUrl: string | null
  generated?: boolean
  parentScoreId?: string | null
  rootScoreId?: string
  lineageDepth?: number
  sourceExerciseId?: string | null
  sourceReportId?: string | null
  instrument?: InstrumentProfile | null
}

export interface PerformanceEvent {
  id: string
  tOnMs: number
  tOffMs: number
  pitch: number
  velocity: number
  channel: number
  source: string
  pedalDown: boolean
  receivedTimeMs?: number | null
  transcriptionConfidence?: number | null
  pitchBendCents?: number | null
}

export interface CaptureMeta {
  transcriptionEngine: string
  transcriptionVersion: string
  thresholdProfile: string
  audioDurationSeconds: number
  inferenceLatencyMs: number
  acceptedNoteCount: number
  rejectedNoteCount: number
  noiseFloorDb: number | null
  meanConfidence: number | null
  inputGainDb?: number | null
  rawPeakDb?: number | null
  normalizedPeakDb?: number | null
  signalToNoiseDb?: number | null
  lowVolumeRecovered?: boolean
}

export interface InputQuality {
  source: InputSource
  instrument: InstrumentProfile
  status: 'high' | 'medium' | 'low' | 'insufficient'
  confidence: number
  acceptedNoteCount: number
  rejectedNoteCount: number
  noiseFloorDb: number | null
  transcriptionEngine: string
  transcriptionVersion: string
}

export interface Evidence {
  id: string
  fact: string
  measureNo: number
  beat: number
  expected: string
  actual: string
  deltaMs: number | null
  deltaVelocity?: number | null
}

export interface ErrorEvent {
  id: string
  type: string
  location: { measure: number; beat: number; eventId: string | null; eventIds?: string[] }
  severity: 'high' | 'medium' | 'low'
  evidenceIds: string[]
  confidence: number
  detail: string
}

export interface Metrics {
  pitchScore: number
  rhythmScore: number
  fluencyScore: number
  dynamicsScore: number
  overallScore: number
  timingMaeMs: number
  avgBpm: number
  matchedCount: number
  expectedCount: number
}

export interface DiagnosisReport {
  reportId: string
  sessionId: string
  scoreId: string
  metrics: Metrics
  errors: ErrorEvent[]
  evidences: Evidence[]
  patterns: { id: string; description: string; sampleCount: number }[]
  hypotheses: { cause: string; confidence: number; limitation: string }[]
  algorithmVersion: string
  thresholdProfile: string
  scoreHash: string
  sourceReferences?: { artifactId: string; kind: string; sha256: string; originalName: string }[]
  inputQuality?: InputQuality
  warnings?: string[]
}

export interface AnalysisJob {
  analysisJobId: string
  sessionId?: string
  status: 'queued' | 'running' | 'completed' | 'failed'
  progress: number
  reportId: string | null
  errorCode?: string | null
  errorMessage?: string | null
}

export interface MentorPlanItem {
  exerciseType: string
  measures: number[]
  tempo: number | null
  repetitions: number
  successCriterion: string
  label?: string
}

export interface MentorResponse {
  provider: string
  model?: string
  promptVersion?: string
  reportId?: string
  summary: string
  evidence: { measure: number; beat: number; fact: string }[]
  hypotheses: { cause: string; confidence: number; limitation: string }[]
  plan: MentorPlanItem[]
  encouragement: string
  responseMode?: string
  latencyMs?: number
  fallbackReason?: string | null
}

export interface MentorChatAction {
  type: 'generate_exercise' | 'select_error' | 'retry' | 'none'
  label: string
  errorId?: string | null
}

export interface MentorMemoryStatus {
  enabled: boolean
  scopeId: string
  rememberedTurnCount: number
  updatedAt?: string | null
}

export interface MentorChatResponse {
  provider: string
  model?: string
  promptVersion?: string
  reportId?: string
  answer: string
  intent: 'diagnosis' | 'technique' | 'theory' | 'repertoire' | 'practice_plan' | 'clarification' | 'other_music'
  evidenceIds: string[]
  professionalGuidance: string[]
  actions: MentorChatAction[]
  uncertainty: string
  followUpQuestion?: string | null
  responseMode?: string
  latencyMs?: number
  fallbackReason?: string | null
  memory?: MentorMemoryStatus
}

export interface AiExercisePlan {
  title: string
  strategy: string
  errorIds: string[]
  tempoRatio: number
  loopCount: number
  hands: 'RH' | 'LH' | null
  rationale: string
  noteAcknowledgement: string
}

export interface ExerciseResult {
  exerciseId: string
  sourceScoreId?: string
  practiceScoreId?: string
  lineageDepth?: number
  ruleId: string
  sourceMeasures: number[]
  tempoPlan: number[]
  variationIndex?: number
  musicalFingerprint?: string
  cadencePlan?: ('half' | 'deceptive' | 'plagal' | 'authentic')[]
  successCriterion: string
  musicXmlUrl: string
  midiUrl: string
  aiPlan?: AiExercisePlan
  plannerProvider?: string
  plannerModel?: string
  plannerLatencyMs?: number
  plannerFallbackReason?: string | null
}

export interface ComparisonResult {
  baselineId: string
  retryId: string
  metricDelta: Record<string, number>
  resolvedErrors: string[]
  persistentErrors: string[]
  newErrors: string[]
  suggestion: string
  targetChanged?: boolean
  baselineScoreId?: string
  retryScoreId?: string
}
