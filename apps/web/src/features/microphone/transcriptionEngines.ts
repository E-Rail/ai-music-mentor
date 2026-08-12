/**
 * The transcription engines, and the one piece of plumbing that drives them.
 *
 * Running a model in a worker is the same job every time — start it, follow its
 * progress, give up if it goes quiet, tear it down whether it finished or
 * failed. That belongs in one place. What differs between engines is only what
 * this table says: which worker, at which sample rate, under which name. A new
 * model is a row here plus a worker that speaks `engineProtocol`.
 */
import type { InstrumentProfile, PerformanceEvent } from '../../types'
import {
  BASIC_PITCH_SAMPLE_RATE, OAF_SAMPLE_RATE,
  type TranscribeRequest, type TranscriptionEngineId, type WorkerResponse,
} from './engineProtocol'

export interface EngineSpec {
  id: TranscriptionEngineId
  /** Recorded on the report, so a stored result says what produced it. */
  version: string
  /** The rate this model was trained at; audio is decoded to match. */
  sampleRate: number
  /**
   * How long this engine may say nothing before the take is handed back.
   *
   * It is a property of the model, not of the app. Onsets and Frames runs one
   * uninterruptible pass over the whole take and offers no way to hook its
   * progress, so it is genuinely silent for the length of that pass — around
   * twice the duration of the audio on a real GPU, far longer on software
   * rendering. A budget short enough to protect against a hung worker would
   * abandon a take that was merely still working.
   */
  stallTimeoutMs: number
  create(): Worker
}

export const ENGINES: Record<TranscriptionEngineId, EngineSpec> = {
  'onsets-frames': {
    id: 'onsets-frames',
    version: 'magenta-1.23.1',
    sampleRate: OAF_SAMPLE_RATE,
    stallTimeoutMs: 240_000,
    create: () => new Worker(
      new URL('../../workers/onsetsFrames.worker.ts', import.meta.url),
      { type: 'module' },
    ),
  },
  'basic-pitch': {
    id: 'basic-pitch',
    version: 'spotify-basic-pitch-ts-1.0.1',
    sampleRate: BASIC_PITCH_SAMPLE_RATE,
    stallTimeoutMs: 45_000,
    create: () => new Worker(
      new URL('../../workers/basicPitch.worker.ts', import.meta.url),
      { type: 'module' },
    ),
  },
}

/**
 * Which model should hear this take.
 *
 * Basic Pitch is instrument-agnostic and pays for it on piano — its own paper
 * reports 70.9 note F1 on MAESTRO where the piano-specific Onsets and Frames
 * gets 95.2. Piano is also the overwhelming majority of what this app is used
 * for, so it gets the specialist and the other instruments keep the generalist,
 * which is genuinely better at them than a piano model would be.
 */
export function engineFor(instrument: InstrumentProfile): TranscriptionEngineId {
  return instrument === 'piano' ? 'onsets-frames' : 'basic-pitch'
}

/** Where a failed engine sends the take rather than stranding the recording. */
export function fallbackFor(engine: TranscriptionEngineId): TranscriptionEngineId | null {
  return engine === 'basic-pitch' ? null : 'basic-pitch'
}

export interface EngineRun {
  events: PerformanceEvent[]
  rejectedCount: number
  meanConfidence: number
  latencyMs: number
  backend: string
}

export function transcriptionCancelledError(): Error & { code: string } {
  return Object.assign(new Error('转录已取消'), { code: 'TRANSCRIPTION_CANCELLED' })
}

function stalledError(): Error & { code: string } {
  return Object.assign(
    new Error('本地转录长时间没有进度，录音已保留。请点击“分析已保存录音”重试。'),
    { code: 'TRANSCRIPTION_STALLED' },
  )
}

/**
 * Run one engine to completion.
 *
 * The audio buffer is transferred, not copied — it is the largest thing in the
 * message and the caller has no use for it afterwards. A caller that needs to
 * retry on another engine must therefore hand over a buffer it still owns.
 */
export function runEngine(
  spec: EngineSpec,
  request: Omit<TranscribeRequest, 'type'>,
  onProgress: (progress: number) => void,
  signal?: AbortSignal,
): Promise<EngineRun> {
  if (signal?.aborted) return Promise.reject(transcriptionCancelledError())
  const worker = spec.create()
  return new Promise<EngineRun>((resolve, reject) => {
    let settled = false
    let stallTimer = 0
    const cleanup = () => {
      window.clearTimeout(stallTimer)
      signal?.removeEventListener('abort', cancel)
      worker.terminate()
    }
    const fail = (error: Error) => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    }
    function cancel() { fail(transcriptionCancelledError()) }
    const armStallTimer = () => {
      window.clearTimeout(stallTimer)
      stallTimer = window.setTimeout(() => fail(stalledError()), spec.stallTimeoutMs)
    }

    if (signal?.aborted) {
      cancel()
      return
    }
    signal?.addEventListener('abort', cancel, { once: true })
    armStallTimer()

    worker.onerror = (event) => {
      fail(new Error(event.message || `${spec.id} 转录工作线程启动失败`))
    }
    worker.onmessage = (message: MessageEvent<WorkerResponse>) => {
      const payload = message.data
      if (payload.type === 'progress') {
        armStallTimer()
        onProgress(payload.progress)
        return
      }
      if (payload.type === 'error') {
        fail(new Error(payload.message || `${spec.id} 转录失败`))
        return
      }
      if (settled) return
      settled = true
      cleanup()
      resolve({
        events: payload.events,
        rejectedCount: payload.rejectedCount,
        meanConfidence: payload.meanConfidence,
        latencyMs: payload.latencyMs,
        backend: payload.backend,
      })
    }
    worker.postMessage({ type: 'transcribe', ...request }, [request.audio.buffer])
  })
}
