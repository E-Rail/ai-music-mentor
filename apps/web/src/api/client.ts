import type {
  AnalysisJob, ComparisonResult, DiagnosisReport, ExerciseResult,
  MentorResponse, PerformanceEvent, ScoreDetail, ScoreMeta, ScoreNormalization,
} from '../types'
import { t } from '../i18n/messages'

const BASE = '/api/v1'
const REQUEST_TIMEOUT_MS = 20_000
const AI_REQUEST_TIMEOUT_MS = 40_000

async function req<T>(path: string, init?: RequestInit,
  timeoutMs = REQUEST_TIMEOUT_MS): Promise<T> {
  const controller = new AbortController()
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs)
  let r: Response
  try {
    r = await fetch(`${BASE}${path}`, {
      ...init,
      signal: init?.signal ?? controller.signal,
    })
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw Object.assign(new Error(t('requestTimeout')), { code: 'REQUEST_TIMEOUT' })
    }
    throw error
  } finally {
    window.clearTimeout(timeout)
  }
  if (!r.ok) {
    let detail: { code?: string; message?: string } = {}
    try {
      const payload = await r.json()
      detail = payload.detail ?? payload ?? {}
    } catch { /* ignore */ }
    const err = new Error(detail.message || `HTTP ${r.status}`) as Error & { code?: string }
    err.code = detail.code
    throw err
  }
  if (r.status === 204) return undefined as T
  return r.json() as Promise<T>
}

export const api = {
  listScores: () => req<{ scores: (ScoreMeta & {
    builtin: boolean; sourceType: string; displayMode: string; warnings: string[]; confidence: number
    generated?: boolean; parentScoreId?: string | null; rootScoreId?: string; lineageDepth?: number
  })[] }>('/scores'),

  getScore: (scoreId: string) =>
    req<ScoreDetail>(`/scores/${scoreId}`),

  importScore: (file: File) => {
    const fd = new FormData()
    fd.append('file', file)
    return req<ScoreDetail>('/scores/import', { method: 'POST', body: fd })
  },

  confirmNormalization: (scoreId: string, normalization: ScoreNormalization) =>
    req<ScoreDetail>(`/scores/${scoreId}/normalization`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...normalization, confirmed: true }),
    }),

  scoreXmlUrl: (scoreId: string) => `${BASE}/scores/${scoreId}/render.musicxml`,

  createSession: (scoreId: string, rangeStart: number, rangeEnd: number, device: string) =>
    req<{ sessionId: string; countIn: { beats: number; bpm: number } }>('/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scoreId, rangeStart, rangeEnd, device }),
    }),

  uploadMidi: (sessionId: string, file: File) => {
    const fd = new FormData()
    fd.append('file', file)
    return req<{ uploadedMidiRef: string }>(`/sessions/${sessionId}/upload-midi`, { method: 'POST', body: fd })
  },

  persistEventBatch: (sessionId: string, batchId: string, sequence: number,
    events: PerformanceEvent[]) => req<{ batchId: string; accepted: boolean; storedEventCount: number }>(
      `/sessions/${sessionId}/event-batches`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ batchId, sequence, events }),
      }),

  markDeviceLost: (sessionId: string) => req<{ sessionId: string; status: string }>(
    `/sessions/${sessionId}/device-lost`, { method: 'POST' }),

  discardSession: (sessionId: string) => req<void>(`/sessions/${sessionId}`, { method: 'DELETE' }),

  getAnalysis: (jobId: string) => req<AnalysisJob>(`/analysis/${jobId}`),

  finishSession: async (sessionId: string, events: PerformanceEvent[], uploadedMidiRef?: string) => {
    const submitted = await req<{ analysisJobId: string; reportId: string | null }>(`/sessions/${sessionId}/finish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ events, uploadedMidiRef: uploadedMidiRef ?? null }),
    })
    if (submitted.reportId) return { ...submitted, reportId: submitted.reportId }
    const deadline = Date.now() + 35_000
    while (Date.now() < deadline) {
      const job = await req<AnalysisJob>(`/analysis/${submitted.analysisJobId}`)
      if (job.status === 'completed' && job.reportId) {
        return { analysisJobId: submitted.analysisJobId, reportId: job.reportId }
      }
      if (job.status === 'failed') {
        throw Object.assign(new Error(job.errorMessage || t('analysisJobFailed')), {
          code: job.errorCode || 'ANALYSIS_FAILED',
        })
      }
      await new Promise((resolve) => window.setTimeout(resolve, 250))
    }
    throw Object.assign(new Error(t('analysisQueued')), { code: 'ANALYSIS_TIMEOUT' })
  },

  getReport: (reportId: string) => req<DiagnosisReport>(`/reports/${reportId}`),

  createExercise: (reportId: string, errorIds: string[], params: {
    strategy: string; tempoRatio: number; loopCount: number; hands?: string | null
  }, generationNote = '', aiAssist = true) =>
    req<ExerciseResult>('/exercises', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reportId, errorIds, params, generationNote, aiAssist }),
    }, AI_REQUEST_TIMEOUT_MS),

  getExercise: (exerciseId: string) =>
    req<ExerciseResult>(`/exercises/${exerciseId}`),

  mentor: (reportId: string, question: string, errorId?: string,
    history: { role: 'user' | 'assistant'; content: string }[] = []) =>
    req<MentorResponse>('/mentor/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reportId, question, errorId: errorId ?? null, history }),
    }, AI_REQUEST_TIMEOUT_MS),

  createAccompaniment: (scoreId: string, rangeStart: number, rangeEnd: number, mode: string) =>
    req<{ accompanimentId: string; baseTempo: number; midiUrl: string; harmonyEvents: { measure: number; pitches: number[] }[]; beatsPerMeasure: number }>(
      '/accompaniments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scoreId, rangeStart, rangeEnd, style: 'chord_bass', mode }),
      }),

  compare: (baselineId: string, retryId: string) =>
    req<ComparisonResult>(`/comparisons?baselineId=${encodeURIComponent(baselineId)}&retryId=${encodeURIComponent(retryId)}`),
}
