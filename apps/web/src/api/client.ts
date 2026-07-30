import type {
  ComparisonResult, DiagnosisReport, ExerciseResult,
  MentorResponse, PerformanceEvent, ScoreEvent, ScoreMeta,
} from '../types'

const BASE = '/api'

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(`${BASE}${path}`, init)
  if (!r.ok) {
    let detail: { code?: string; message?: string } = {}
    try { detail = (await r.json()).detail ?? {} } catch { /* ignore */ }
    const err = new Error(detail.message || `HTTP ${r.status}`) as Error & { code?: string }
    err.code = detail.code
    throw err
  }
  return r.json() as Promise<T>
}

export const api = {
  listScores: () => req<{ scores: (ScoreMeta & { builtin: boolean })[] }>('/scores'),

  getScore: (scoreId: string) =>
    req<{ metadata: ScoreMeta; scoreEvents: ScoreEvent[]; renderUrl: string }>(`/scores/${scoreId}`),

  importScore: (file: File) => {
    const fd = new FormData()
    fd.append('file', file)
    return req<{ scoreId: string; metadata: ScoreMeta; scoreEvents: ScoreEvent[]; renderUrl: string }>(
      '/scores/import', { method: 'POST', body: fd })
  },

  scoreXmlUrl: (scoreId: string) => `${BASE}/scores/${scoreId}/musicxml`,

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

  finishSession: (sessionId: string, events: PerformanceEvent[], uploadedMidiRef?: string) =>
    req<{ analysisJobId: string; reportId: string }>(`/sessions/${sessionId}/finish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ events, uploadedMidiRef: uploadedMidiRef ?? null }),
    }),

  getReport: (reportId: string) => req<DiagnosisReport>(`/reports/${reportId}`),

  createExercise: (reportId: string, errorIds: string[], params: {
    strategy: string; tempoRatio: number; loopCount: number; hands?: string | null
  }) =>
    req<ExerciseResult>('/exercises', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reportId, errorIds, params }),
    }),

  mentor: (reportId: string, question: string, errorId?: string) =>
    req<MentorResponse>('/mentor/respond', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reportId, question, errorId: errorId ?? null }),
    }),

  createAccompaniment: (scoreId: string, rangeStart: number, rangeEnd: number, mode: string) =>
    req<{ accompanimentId: string; baseTempo: number; midiUrl: string; harmonyEvents: { measure: number; pitches: number[] }[]; beatsPerMeasure: number }>(
      '/accompaniments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scoreId, rangeStart, rangeEnd, style: 'chord_bass', mode }),
      }),

  compare: (baselineId: string, retryId: string) =>
    req<ComparisonResult>(`/comparisons?baselineId=${baselineId}&retryId=${retryId}`),
}
