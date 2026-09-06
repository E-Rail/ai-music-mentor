import { describe, expect, it } from 'vitest'
import { confidenceFromVelocity } from './engineProtocol'
import { cleanupTranscribedNotes } from './noteCleanup'
import { AUDIO_PROFILES, profileForNoise } from './profiles'
import type { PerformanceEvent } from '../../types'

/** A note the model already decided was real, played at `velocity`. */
function played(id: string, onset: number, pitch: number,
  velocity: number): PerformanceEvent {
  return {
    id, tOnMs: onset, tOffMs: onset + 600, pitch, velocity,
    channel: 0, source: 'microphone', pedalDown: false,
    transcriptionConfidence: confidenceFromVelocity(velocity),
    pitchBendCents: null,
  } as PerformanceEvent
}

describe('noise floor and what a confidence number means', () => {
  it('still tightens the floor for an engine that reports real certainty', () => {
    const quiet = profileForNoise('guitar', -60, 'activation')
    const noisy = profileForNoise('guitar', -15, 'activation')
    expect(quiet.minConfidence).toBe(AUDIO_PROFILES.guitar.minConfidence)
    expect(noisy.minConfidence).toBeGreaterThan(quiet.minConfidence)
  })

  it('leaves the floor alone when the number is only loudness', () => {
    const noisy = profileForNoise('piano', -15, 'velocity-proxy')
    expect(noisy.minConfidence).toBe(AUDIO_PROFILES.piano.minConfidence)
  })

  it('keeps the soft inner voices of a chord in a noisy room', () => {
    // A three-note chord: melody struck firmly, inner voices played gently.
    // Onsets and Frames reported all three — it had already decided they were
    // real. Only their loudness differs.
    const chord = [
      played('a', 0, 60, 30),
      played('b', 4, 64, 26),
      played('c', 8, 67, 100),
    ]
    const profile = profileForNoise('piano', -15, 'velocity-proxy')
    const { events } = cleanupTranscribedNotes(chord, profile)
    expect(events.map((event) => event.pitch).sort((x, y) => x - y))
      .toEqual([60, 64, 67])
  })

  it('would have dropped them under the old loudness gate', () => {
    // Guards the regression rather than the fix: if the penalty is ever
    // reapplied to a velocity proxy, this is what it costs.
    const chord = [
      played('a', 0, 60, 30),
      played('b', 4, 64, 26),
      played('c', 8, 67, 100),
    ]
    const gated = profileForNoise('piano', -15, 'activation')
    const { events } = cleanupTranscribedNotes(chord, gated)
    expect(events.map((event) => event.pitch)).toEqual([67])
  })
})
