/**
 * The contract every transcription engine speaks.
 *
 * Two models transcribe a take — Onsets and Frames for piano, Basic Pitch for
 * everything else — and the app must not care which one ran. One message
 * protocol, one confidence scale, one `PerformanceEvent` shape out. Adding a
 * third engine means writing a worker that speaks this and registering it, not
 * touching the microphone flow.
 *
 * Pure types and constants only: this module is imported by workers, so it must
 * never reach for a `Worker`, the DOM, or an `AudioContext`.
 */
import type { InstrumentProfile, PerformanceEvent } from '../../types'

export type TranscriptionEngineId = 'onsets-frames' | 'basic-pitch'

export interface TranscribeRequest {
  type: 'transcribe'
  /** Mono samples at the engine's own `sampleRate`. */
  audio: Float32Array
  instrument: InstrumentProfile
  noiseFloorDb: number | null
  /** Model activation thresholds. Engines that decide for themselves ignore these. */
  onsetThreshold: number
  frameThreshold: number
  /** Shifts the profile's confidence floor when the room was quiet enough to trust. */
  confidenceAdjustment: number
}

export type WorkerResponse =
  | { type: 'progress'; progress: number; backend: string }
  | {
      type: 'complete'
      events: PerformanceEvent[]
      rejectedCount: number
      meanConfidence: number
      latencyMs: number
      backend: string
    }
  | { type: 'error'; message: string }

// --- Onsets and Frames ------------------------------------------------------

/** The rate the checkpoint was trained at. Feeding it anything else is noise. */
export const OAF_SAMPLE_RATE = 16_000

/**
 * Vendored by `scripts/copy-audio-assets.mjs`, never fetched from Google at
 * runtime: a demo cannot depend on the network, and a 60 MB download in front
 * of an audience is not a risk worth taking.
 */
export const OAF_CHECKPOINT_URL = '/models/onsets-frames'

/** The rate Basic Pitch was trained at. */
export const BASIC_PITCH_SAMPLE_RATE = 22_050

/**
 * Put a note the model committed to onto the shared confidence scale.
 *
 * The two engines mean different things by their own numbers. Basic Pitch
 * reports a per-note activation, so its confidence *is* the model's certainty.
 * Onsets and Frames has already made that decision — a note only exists if it
 * crossed the model's own onset threshold — and what it hands back instead is a
 * velocity, which is loudness, not certainty.
 *
 * Reading velocity directly as confidence would throw away notes the model was
 * sure about simply because they were played softly, which is precisely the
 * mistake a piano tutor must not make. So a surviving note starts at 0.5 and
 * loudness only moves it up from there. It stays below 1 so that the noise-room
 * penalty can still tighten the floor, and it keeps a real ordering for the
 * monophonic profile's interval scheduling.
 */
export function confidenceFromVelocity(velocity: number): number {
  const scaled = Math.max(0, Math.min(127, velocity)) / 127
  return 0.5 + 0.5 * scaled
}
