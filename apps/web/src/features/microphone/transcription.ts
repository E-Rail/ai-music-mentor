import type { CaptureMeta, InstrumentProfile, PerformanceEvent } from '../../types'
import { AUDIO_PROFILES } from './profiles'
import { enhanceAnalysisAudio } from './audioEnhancement'
import type { TranscriptionEngineId } from './engineProtocol'
import {
  ENGINES, engineFor, fallbackFor, runEngine, transcriptionCancelledError,
  type EngineRun, type EngineSpec,
} from './transcriptionEngines'

export interface TranscriptionResult {
  events: PerformanceEvent[]
  captureMeta: CaptureMeta
  backend: string
}

/**
 * Decode to mono at the rate the model was trained at.
 *
 * Every engine has one — 16 kHz for Onsets and Frames, 22.05 kHz for Basic
 * Pitch — and feeding a model anything else is feeding it noise. Resampling
 * through an `OfflineAudioContext` keeps that decision here, where there is an
 * `AudioContext` to do it with; a worker has none.
 */
export async function decodeMono(blob: Blob, sampleRate: number): Promise<Float32Array> {
  const context = new AudioContext()
  try {
    const decoded = await context.decodeAudioData(await blob.arrayBuffer())
    const length = Math.max(1, Math.ceil(decoded.duration * sampleRate))
    const offline = new OfflineAudioContext(1, length, sampleRate)
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

/**
 * Sensitivity for a take that had to be lifted out of the noise floor.
 *
 * Only engines that expose their own thresholds act on this; Onsets and Frames
 * decides for itself and ignores it. The values still travel with every
 * request so that one request shape serves every engine.
 */
function sensitivityFor(lowVolumeRecovered: boolean, signalToNoiseDb: number | null) {
  const recovered = lowVolumeRecovered && (signalToNoiseDb ?? 0) >= 10
  return {
    onsetThreshold: recovered ? 0.22 : 0.25,
    frameThreshold: recovered ? 0.22 : 0.25,
    confidenceAdjustment: recovered ? -0.04 : 0,
  }
}

export async function transcribeAudio(blob: Blob, instrument: InstrumentProfile,
  noiseFloorDb: number | null, onProgress: (progress: number) => void,
  signal?: AbortSignal): Promise<TranscriptionResult> {
  if (signal?.aborted) throw transcriptionCancelledError()

  const chosen = engineFor(instrument)
  const attempt = async (id: TranscriptionEngineId): Promise<{
    spec: EngineSpec; run: EngineRun; enhanced: ReturnType<typeof enhanceAnalysisAudio>
  }> => {
    const spec = ENGINES[id]
    const samples = await decodeMono(blob, spec.sampleRate)
    // `AbortSignal` does not replay to a listener added after decoding, so the
    // expensive step is guarded on both sides of it.
    if (signal?.aborted) throw transcriptionCancelledError()
    const enhanced = enhanceAnalysisAudio(samples, spec.sampleRate, noiseFloorDb)
    const run = await runEngine(spec, {
      audio: enhanced.samples,
      instrument,
      noiseFloorDb,
      ...sensitivityFor(
        enhanced.metrics.lowVolumeRecovered, enhanced.metrics.signalToNoiseDb ?? null),
    }, onProgress, signal)
    return { spec, run, enhanced }
  }

  let result: Awaited<ReturnType<typeof attempt>>
  try {
    result = await attempt(chosen)
  } catch (error) {
    const cancelled = (error as { code?: string })?.code === 'TRANSCRIPTION_CANCELLED'
    const fallback = cancelled ? null : fallbackFor(chosen)
    // A specialist that cannot start — no checkpoint, no WebGL, a browser it
    // does not like — must not cost the student their take. The generalist is
    // less accurate on piano, not useless, and the report records which one ran.
    if (!fallback) throw error
    result = await attempt(fallback)
  }

  // Onsets and Frames is excellent for isolated piano attacks, but it can
  // under-report soft inner voices in dense chords. When its output is
  // suspiciously sparse, run the complementary polyphonic Basic Pitch pass on
  // the same decoded take and keep the richer transcription. This is a
  // deliberate quality fallback (rather than an engine failure fallback), so
  // a valid take is not silently scored from one missing voice.
  if (chosen === 'onsets-frames') {
    try {
      const alternate = await attempt('basic-pitch')
      // Fuse the two decoders instead of selecting one globally. OAF gives
      // better attack timing; Basic Pitch supplies soft inner voices. Events
      // within 70 ms of the same MIDI pitch are one note, with the stronger
      // confidence retained. This is the same complementary strategy used by
      // practical AMT ensembles and is much more reliable than thresholding a
      // single model's output.
      const fused = [...result.run.events]
      for (const event of alternate.run.events) {
        const duplicate = fused.find(candidate => candidate.pitch === event.pitch &&
          Math.abs(candidate.tOnMs - event.tOnMs) <= 70)
        if (duplicate) {
          duplicate.tOnMs = Math.min(duplicate.tOnMs, event.tOnMs)
          duplicate.tOffMs = Math.max(duplicate.tOffMs, event.tOffMs)
          duplicate.transcriptionConfidence = Math.max(
            duplicate.transcriptionConfidence ?? 0, event.transcriptionConfidence ?? 0)
        } else fused.push(event)
      }
      result = {
        ...result,
        run: { ...result.run, events: fused, rejectedCount: result.run.rejectedCount + alternate.run.rejectedCount },
      }
    } catch {
      // The specialist result remains usable when the optional second engine
      // cannot initialize (for example, WebGL is unavailable).
    }
  }

  const { spec, run, enhanced } = result
  const profile = AUDIO_PROFILES[instrument]
  const duration = enhanced.samples.length / spec.sampleRate
  return {
    events: run.events,
    backend: run.backend,
    captureMeta: {
      transcriptionEngine: spec.id,
      transcriptionVersion: spec.version,
      thresholdProfile: profile.id,
      audioDurationSeconds: Math.round(duration * 100) / 100,
      inferenceLatencyMs: run.latencyMs,
      acceptedNoteCount: run.events.length,
      rejectedNoteCount: run.rejectedCount,
      noiseFloorDb,
      meanConfidence: run.meanConfidence,
      inputGainDb: enhanced.metrics.inputGainDb,
      rawPeakDb: enhanced.metrics.rawPeakDb,
      normalizedPeakDb: enhanced.metrics.normalizedPeakDb,
      signalToNoiseDb: enhanced.metrics.signalToNoiseDb,
      lowVolumeRecovered: enhanced.metrics.lowVolumeRecovered,
    },
  }
}

export { transcriptionCancelledError }
