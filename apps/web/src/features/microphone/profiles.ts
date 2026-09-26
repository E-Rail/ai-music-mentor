import type { InstrumentProfile } from '../../types'

export interface AudioDetectionProfile {
  id: string
  instrument: InstrumentProfile
  minPitch: number
  maxPitch: number
  minConfidence: number
  minDurationMs: number
  mergeGapMs: number
  chordWindowMs: number
  monophonic: boolean
  /**
   * How sure the engine must be that a note *began* for it to count as struck,
   * or null where notes may begin without a strike and sound alone decides.
   *
   * Piano is struck, and Basic Pitch's onset head separates a struck note from
   * a held one being re-read cleanly: on the rendered takes every played note
   * scored 0.84 or more, and every re-read and overtone below 0.76, with room
   * noise mixed in down to 10 dB. A bow can start a note with no attack at
   * all, and guitar has no measurements yet, so they keep the old rule.
   */
  attackFloor: number | null
  vibratoToleranceCents: number
  durationWeight: number
}

export const AUDIO_PROFILES: Record<InstrumentProfile, AudioDetectionProfile> = {
  piano: {
    id: 'audio-piano-v2', instrument: 'piano', minPitch: 21, maxPitch: 108,
    minConfidence: 0.35, minDurationMs: 55, mergeGapMs: 75,
    chordWindowMs: 90, monophonic: false, attackFloor: 0.7, vibratoToleranceCents: 35,
    durationWeight: 0.35,
  },
  guitar: {
    id: 'audio-guitar-v2', instrument: 'guitar', minPitch: 40, maxPitch: 88,
    minConfidence: 0.38, minDurationMs: 65, mergeGapMs: 90,
    chordWindowMs: 75, monophonic: false, attackFloor: null, vibratoToleranceCents: 45,
    durationWeight: 0.25,
  },
  violin: {
    id: 'audio-violin-v2', instrument: 'violin', minPitch: 55, maxPitch: 103,
    minConfidence: 0.40, minDurationMs: 85, mergeGapMs: 120,
    chordWindowMs: 35, monophonic: true, attackFloor: null, vibratoToleranceCents: 70,
    durationWeight: 0.10,
  },
}

/**
 * What an engine's confidence number actually means.
 *
 * - `activation`: how strongly a pitch sounded over the note (Basic Pitch's
 *   frame head). In a noisy room the room sounds too, so the floor rises.
 * - `onset`: how sure the engine is that a key was struck (Basic Pitch's onset
 *   head). Room noise does not strike keys — measured at 10 dB, real attacks
 *   stayed above 0.84 — so the floor stays where it is.
 * - `velocity-proxy`: Onsets and Frames has already decided every note it
 *   reports was struck and hands back a loudness. Thresholding that separates
 *   loud from soft, not real from spurious.
 */
export type ConfidenceKind = 'activation' | 'onset' | 'velocity-proxy'

/** Which confidence an engine should report for this instrument. */
export function confidenceKindFor(instrument: InstrumentProfile): ConfidenceKind {
  return AUDIO_PROFILES[instrument].attackFloor === null ? 'activation' : 'onset'
}

export function profileForNoise(instrument: InstrumentProfile,
  noiseFloorDb: number | null,
  kind: ConfidenceKind = 'activation'): AudioDetectionProfile {
  const base = AUDIO_PROFILES[instrument]
  if (noiseFloorDb === null || noiseFloorDb <= -45) return base
  // Raising the floor on a velocity proxy does not reject room noise, it
  // rejects quiet playing — the one mistake a piano tutor must not make, and
  // the mistake confidenceFromVelocity exists to avoid. At a -15 dB floor the
  // penalty reaches 0.65, which is every note under velocity 38: the soft inner
  // voices of a chord, reported by the model with confidence, thrown away for
  // being played gently. Noise robustness on this path is the model's own onset
  // threshold, not a loudness gate bolted on afterwards.
  if (kind !== 'activation') return base
  // In a noisy room require stronger model activation so steady room noise is
  // less likely to survive as a playable note. The original profile is immutable.
  const penalty = Math.min(.30, Math.max(0, (noiseFloorDb + 45) / 20) * .20)
  return { ...base, minConfidence: Math.min(.75, base.minConfidence + penalty) }
}
