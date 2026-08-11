import type { CaptureMeta, InstrumentProfile, PerformanceEvent } from '../../types'
import { AUDIO_PROFILES } from './profiles'
import { enhanceAnalysisAudio } from './audioEnhancement'

export interface TranscriptionResult {
  events: PerformanceEvent[]
  captureMeta: CaptureMeta
  backend: string
}

export async function decodeMono22050(blob: Blob): Promise<Float32Array> {
  const context = new AudioContext()
  try {
    const decoded = await context.decodeAudioData(await blob.arrayBuffer())
    const length = Math.max(1, Math.ceil(decoded.duration * 22_050))
    const offline = new OfflineAudioContext(1, length, 22_050)
    const source = offline.createBufferSource()
    source.buffer = decoded
    source.connect(offline.destination)
    source.start()
    const rendered = await offline.startRendering()
    return new Float32Array(rendered.getChannelData(0))
  } finally {
    await context.close().catch(() => {})
  }
}

export async function transcribeAudio(blob: Blob, instrument: InstrumentProfile,
  noiseFloorDb: number | null, onProgress: (progress: number) => void,
  signal?: AbortSignal): Promise<TranscriptionResult> {
  if (signal?.aborted) throw transcriptionCancelledError()
  const samples = await decodeMono22050(blob)
  // AbortSignal does not replay an abort event to a listener registered after
  // decoding. Check again before starting the expensive model worker.
  if (signal?.aborted) throw transcriptionCancelledError()
  const duration = samples.length / 22_050
  const enhanced = enhanceAnalysisAudio(samples, 22_050, noiseFloorDb)
  const worker = new Worker(
    new URL('../../workers/basicPitch.worker.ts', import.meta.url),
    { type: 'module' },
  )
  return new Promise((resolve, reject) => {
    let settled = false
    let inactivityTimer = 0
    let cancel = () => {}
    const cleanup = () => {
      window.clearTimeout(inactivityTimer)
      signal?.removeEventListener('abort', cancel)
      worker.terminate()
    }
    const fail = (error: Error) => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    }
    const armInactivityTimer = () => {
      window.clearTimeout(inactivityTimer)
      inactivityTimer = window.setTimeout(() => fail(Object.assign(
        new Error('本地转录长时间没有进度，录音已保留。请点击“分析已保存录音”重试。'),
        { code: 'TRANSCRIPTION_STALLED' },
      )), 45_000)
    }
    cancel = () => fail(transcriptionCancelledError())
    if (signal?.aborted) {
      cancel()
      return
    }
    signal?.addEventListener('abort', cancel, { once: true })
    armInactivityTimer()
    worker.onerror = (event) => {
      fail(new Error(event.message || '转录工作线程启动失败'))
    }
    worker.onmessage = (message: MessageEvent<{
      type: 'progress' | 'complete' | 'error'
      progress?: number
      events?: PerformanceEvent[]
      rejectedCount?: number
      meanConfidence?: number
      latencyMs?: number
      backend?: string
      message?: string
    }>) => {
      const payload = message.data
      if (payload.type === 'progress') {
        armInactivityTimer()
        onProgress(payload.progress ?? 0)
        return
      }
      if (payload.type === 'error') {
        fail(new Error(payload.message || '麦克风转录失败'))
        return
      }
      const events = payload.events ?? []
      const profile = AUDIO_PROFILES[instrument]
      if (settled) return
      settled = true
      cleanup()
      resolve({
        events,
        backend: payload.backend ?? 'cpu',
        captureMeta: {
          transcriptionEngine: 'spotify-basic-pitch-ts',
          transcriptionVersion: '1.0.1',
          thresholdProfile: profile.id,
          audioDurationSeconds: Math.round(duration * 100) / 100,
          inferenceLatencyMs: payload.latencyMs ?? 0,
          acceptedNoteCount: events.length,
          rejectedNoteCount: payload.rejectedCount ?? 0,
          noiseFloorDb,
          meanConfidence: payload.meanConfidence ?? 0,
          inputGainDb: enhanced.metrics.inputGainDb,
          rawPeakDb: enhanced.metrics.rawPeakDb,
          normalizedPeakDb: enhanced.metrics.normalizedPeakDb,
          signalToNoiseDb: enhanced.metrics.signalToNoiseDb,
          lowVolumeRecovered: enhanced.metrics.lowVolumeRecovered,
        },
      })
    }
    worker.postMessage({
      type: 'transcribe', audio: enhanced.samples, instrument, noiseFloorDb,
      onsetThreshold: enhanced.metrics.lowVolumeRecovered &&
        (enhanced.metrics.signalToNoiseDb ?? 0) >= 10 ? 0.22 : 0.25,
      frameThreshold: enhanced.metrics.lowVolumeRecovered &&
        (enhanced.metrics.signalToNoiseDb ?? 0) >= 10 ? 0.22 : 0.25,
      confidenceAdjustment: enhanced.metrics.lowVolumeRecovered &&
        (enhanced.metrics.signalToNoiseDb ?? 0) >= 10 ? -0.04 : 0,
    }, [enhanced.samples.buffer])
  })
}

export function transcriptionCancelledError(): Error & { code: string } {
  return Object.assign(new Error('转录已取消'), { code: 'TRANSCRIPTION_CANCELLED' })
}
