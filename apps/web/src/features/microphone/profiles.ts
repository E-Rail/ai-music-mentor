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

export function profileForNoise(instrument: InstrumentProfile,
  noiseFloorDb: number | null): AudioDetectionProfile {
  const base = AUDIO_PROFILES[instrument]
  if (noiseFloorDb === null || noiseFloorDb <= -45) return base
  // In a noisy room require stronger model activation so steady room noise is
  // less likely to survive as a playable note. The original profile is immutable.
  const penalty = Math.min(.30, Math.max(0, (noiseFloorDb + 45) / 20) * .20)
  return { ...base, minConfidence: Math.min(.75, base.minConfidence + penalty) }
}
