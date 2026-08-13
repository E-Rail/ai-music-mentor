import { describe, expect, it } from 'vitest'
import type { PerformanceEvent } from '../../types'
import { cleanupTranscribedNotes } from './noteCleanup'
import { AUDIO_PROFILES, profileForNoise } from './profiles'

const note = (id: string, pitch: number, on: number, off: number,
  confidence: number): PerformanceEvent => ({
  id, pitch, tOnMs: on, tOffMs: off, velocity: 80, channel: 0,
  source: 'microphone', pedalDown: false, transcriptionConfidence: confidence,
})

describe('microphone note cleanup', () => {
  it('filters weak fragments and merges repeated fragments', () => {
    const result = cleanupTranscribedNotes([
      note('a', 60, 0, 200, .8), note('b', 60, 240, 500, .7),
      note('noise', 61, 510, 530, .2),
    ], AUDIO_PROFILES.piano)
    expect(result.events).toHaveLength(1)
    expect(result.events[0].tOffMs).toBe(500)
    expect(result.rejectedCount).toBe(2)
  })

  it('keeps only the stronger overlapping violin note', () => {
    const result = cleanupTranscribedNotes([
      note('a', 69, 0, 400, .55), note('b', 70, 120, 500, .9),
    ], AUDIO_PROFILES.violin)
    expect(result.events.map((event) => event.pitch)).toEqual([70])
  })

  it('never leaves a chained overlap in the monophonic violin result', () => {
    const result = cleanupTranscribedNotes([
      note('first', 69, 0, 100, .8),
      note('bridge', 70, 50, 160, .9),
      note('last', 71, 110, 210, .8),
    ], AUDIO_PROFILES.violin)

    expect(result.events.map((event) => event.pitch)).toEqual([69, 71])
    expect(result.events.every((event, index) => index === 0 ||
      result.events[index - 1].tOffMs <= event.tOnMs)).toBe(true)
  })

  it('raises the confidence floor for a noisy room without mutating the base profile', () => {
    const noisy = profileForNoise('piano', -25)
    const result = cleanupTranscribedNotes([
      note('room-noise', 60, 0, 200, .50), note('played', 64, 300, 600, .80),
    ], noisy)

    expect(noisy.minConfidence).toBeCloseTo(.55)
    expect(AUDIO_PROFILES.piano.minConfidence).toBe(.35)
    expect(result.events.map((event) => event.pitch)).toEqual([64])
  })
})
