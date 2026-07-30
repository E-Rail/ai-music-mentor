// 与后端 packages/shared-schema 对齐的 API 类型

export interface ScoreEvent {
  eventId: string
  measureNo: number
  onsetBeat: number
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
  scoreHash: string
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
}

export interface Evidence {
  id: string
  fact: string
  measureNo: number
  beat: number
  expected: string
  actual: string
  deltaMs: number | null
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
}

export interface MentorResponse {
  provider: string
  summary: string
  evidence: { measure: number; beat: number; fact: string }[]
  hypotheses: { cause: string; confidence: number; limitation: string }[]
  plan: { exerciseType: string; measures: number[]; tempo: number | null; repetitions: number; successCriterion: string; label?: string }[]
  encouragement: string
}

export interface ExerciseResult {
  exerciseId: string
  ruleId: string
  sourceMeasures: number[]
  tempoPlan: number[]
  successCriterion: string
  musicXmlUrl: string
  midiUrl: string
}

export interface ComparisonResult {
  baselineId: string
  retryId: string
  metricDelta: Record<string, number>
  resolvedErrors: string[]
  persistentErrors: string[]
  newErrors: string[]
  suggestion: string
}

export const ERROR_TYPE_LABEL: Record<string, string> = {
  wrong_pitch: '错音',
  missed_note: '漏音',
  extra_note: '多音',
  early_late: '提前/延后',
  duration_anomaly: '时值异常',
  tempo_instability: '速度不稳',
  dynamics_anomaly: '力度异常',
}

export const SEVERITY_LABEL: Record<string, string> = {
  high: '严重',
  medium: '中等',
  low: '轻微',
}
