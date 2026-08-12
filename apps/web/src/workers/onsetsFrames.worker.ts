/// <reference lib="webworker" />

/**
 * Piano transcription with Magenta's Onsets and Frames, in the browser.
 *
 * Basic Pitch is instrument-agnostic, and its own paper measures the price of
 * that on piano: 70.9 note F1 on MAESTRO against 95.2 for this model. For a
 * piano tutor that gap is not a quality setting, it is whether the notes the
 * student is graded on are the notes they played. So piano takes go through
 * Onsets and Frames and everything else stays with Basic Pitch.
 *
 * The audio arrives already decoded to 16 kHz mono, because a worker has no
 * AudioContext to resample with. Magenta's own mel spectrogram then runs here
 * rather than on the main thread — it is the expensive half of the job and the
 * UI must stay responsive while it happens.
 */
// Must precede every Magenta import — see the module for why.
import './magentaWorkerShim'
import { OnsetsAndFrames } from '@magenta/music/esm/transcription/model'
import { melSpectrogram, powerToDb } from '@magenta/music/esm/core/audio_utils'
import * as tf from '@tensorflow/tfjs'
import type { InstrumentProfile, PerformanceEvent } from '../types'
import { cleanupTranscribedNotes } from '../features/microphone/noteCleanup'
import { profileForNoise } from '../features/microphone/profiles'
import {
  OAF_CHECKPOINT_URL, OAF_SAMPLE_RATE, confidenceFromVelocity,
  type TranscribeRequest, type WorkerResponse,
} from '../features/microphone/engineProtocol'

const workerScope: DedicatedWorkerGlobalScope = self as unknown as DedicatedWorkerGlobalScope

/**
 * Frames per inference chunk. Magenta's default of 250 is ~8 s of audio; a
 * practice passage is short enough that one chunk usually covers the take, and
 * a smaller chunk would only add seams for notes to fall through.
 */
const CHUNK_LENGTH = 250

/** Mel spectrogram settings the checkpoint was trained with. Not tunable. */
const MEL_PARAMS = {
  sampleRate: OAF_SAMPLE_RATE,
  hopLength: 512,
  nMels: 229,
  nFft: 2048,
  fMin: 30,
}

function post(message: WorkerResponse): void {
  workerScope.postMessage(message)
}

/**
 * WebGL is several times faster here and the model is large enough for that to
 * matter, but a worker only has WebGL where OffscreenCanvas is available. The
 * CPU backend is correct everywhere, so it is the fallback rather than a
 * failure.
 */
async function selectBackend(): Promise<string> {
  if (typeof OffscreenCanvas !== 'undefined') {
    try {
      if (await tf.setBackend('webgl')) {
        await tf.ready()
        return 'webgl'
      }
    } catch { /* fall through to CPU */ }
  }
  await tf.setBackend('cpu')
  await tf.ready()
  return 'cpu'
}

workerScope.onmessage = async (message: MessageEvent<TranscribeRequest>) => {
  if (message.data.type !== 'transcribe') return
  const started = performance.now()
  const { audio, instrument, noiseFloorDb } = message.data
  let model: OnsetsAndFrames | null = null
  try {
    const backend = await selectBackend()
    post({ type: 'progress', progress: 0.04, backend })

    // The mel spectrogram is deterministic and roughly a third of the wall
    // clock, so it is worth reporting as real progress rather than a guess.
    const melSpec = powerToDb(melSpectrogram(audio, MEL_PARAMS))
      .map((frame) => Array.from(frame))
    post({ type: 'progress', progress: 0.3, backend })

    model = new OnsetsAndFrames(OAF_CHECKPOINT_URL, CHUNK_LENGTH)
    await model.initialize()
    post({ type: 'progress', progress: 0.55, backend })

    const sequence = await model.transcribeFromMelSpec(melSpec)
    post({ type: 'progress', progress: 0.9, backend })

    const raw: PerformanceEvent[] = (sequence.notes ?? []).map((note, index) => {
      const velocity = Math.max(1, Math.min(127, Math.round(note.velocity ?? 0)))
      return {
        id: `mic_raw_${index + 1}`,
        tOnMs: Math.max(0, (note.startTime ?? 0) * 1000),
        tOffMs: Math.max(0, (note.endTime ?? 0) * 1000),
        pitch: Math.max(0, Math.min(127, Math.round(note.pitch ?? 0))),
        velocity,
        channel: 0,
        source: 'microphone' as const,
        pedalDown: false,
        transcriptionConfidence: confidenceFromVelocity(velocity),
        // Onsets and Frames decides a pitch, not a frequency, so there is no
        // bend to report. Saying null is honest; saying 0 would claim a
        // measurement that was never made.
        pitchBendCents: null,
      }
    })

    const profile = profileForNoise(instrument as InstrumentProfile, noiseFloorDb)
    const cleaned = cleanupTranscribedNotes(raw, {
      ...profile,
      minConfidence: Math.max(0.25,
        profile.minConfidence + message.data.confidenceAdjustment),
    })
    post({
      type: 'complete',
      events: cleaned.events,
      rejectedCount: cleaned.rejectedCount,
      meanConfidence: cleaned.meanConfidence,
      latencyMs: Math.round(performance.now() - started),
      backend,
    })
  } catch (error) {
    post({
      type: 'error',
      message: error instanceof Error ? error.message : String(error),
    })
  } finally {
    try { model?.dispose() } catch { /* a failed load has nothing to dispose */ }
  }
}

export {}
