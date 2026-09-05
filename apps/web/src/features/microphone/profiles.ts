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
  vibratoToleranceCents: number
  durationWeight: number
}

export const AUDIO_PROFILES: Record<InstrumentProfile, AudioDetectionProfile> = {
  piano: {
    id: 'audio-piano-v2', instrument: 'piano', minPitch: 21, maxPitch: 108,
    minConfidence: 0.35, minDurationMs: 55, mergeGapMs: 75,
    chordWindowMs: 90, monophonic: false, vibratoToleranceCents: 35,
    durationWeight: 0.35,
  },
  guitar: {
    id: 'audio-guitar-v2', instrument: 'guitar', minPitch: 40, maxPitch: 88,
    minConfidence: 0.38, minDurationMs: 65, mergeGapMs: 90,
    chordWindowMs: 75, monophonic: false, vibratoToleranceCents: 45,
    durationWeight: 0.25,
  },
  violin: {
    id: 'audio-violin-v2', instrument: 'violin', minPitch: 55, maxPitch: 103,
    minConfidence: 0.40, minDurationMs: 85, mergeGapMs: 120,
    chordWindowMs: 35, monophonic: true, vibratoToleranceCents: 70,
    durationWeight: 0.10,
  },
}

/**
 * What an engine's confidence number actually means.
 *
 * Basic Pitch reports a per-note activation, so its number is the model's own
 * certainty and a threshold on it genuinely separates a real note from a
 * spurious one. Onsets and Frames has already made that decision — a note only
 * exists if it crossed the model's onset threshold — and hands back a velocity
 * instead. Thresholding that separates loud from soft, not real from spurious.
 */
export type ConfidenceKind = 'activation' | 'velocity-proxy'

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
  if (kind === 'velocity-proxy') return base
  // In a noisy room require stronger model activation so steady room noise is
  // less likely to survive as a playable note. The original profile is immutable.
  const penalty = Math.min(.30, Math.max(0, (noiseFloorDb + 45) / 20) * .20)
  return { ...base, minConfidence: Math.min(.75, base.minConfidence + penalty) }
}
