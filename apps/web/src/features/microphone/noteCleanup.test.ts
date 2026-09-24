import { describe, expect, it } from 'vitest'
import { cleanupTranscribedNotes, type TranscribedNote } from './noteCleanup'
import { AUDIO_PROFILES, profileForNoise } from './profiles'

const note = (id: string, pitch: number, on: number, off: number,
  confidence: number, attack?: number, velocity = 80): TranscribedNote => ({
  id, pitch, tOnMs: on, tOffMs: off, velocity, channel: 0,
  source: 'microphone', pedalDown: false, transcriptionConfidence: confidence, attack,
})

/** Basic Pitch on piano: the confidence it reports is the attack. */
const heard = (id: string, pitch: number, on: number, off: number, attack: number,
  velocity = 80) => note(id, pitch, on, off, attack, attack, velocity)

describe('microphone note cleanup', () => {
  it('filters weak fragments and merges the ones that continue a note', () => {
    const result = cleanupTranscribedNotes([
      note('a', 69, 0, 200, .8), note('b', 69, 240, 500, .7),
      note('noise', 70, 510, 530, .2),
    ], AUDIO_PROFILES.violin)
    expect(result.events).toHaveLength(1)
    expect(result.events[0].tOffMs).toBe(500)
    expect(result.rejectedCount).toBe(2)
  })

  it('never hands the attack across the worker boundary', () => {
    const result = cleanupTranscribedNotes([heard('a', 60, 0, 400, .95)], AUDIO_PROFILES.piano)
    expect(result.events[0]).not.toHaveProperty('attack')
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

describe('a repeated note is not a fragmented one', () => {
  it('keeps every note of a trill', () => {
    // C-D-C-D-C, each note about 100ms. The gap between one C ending and the
    // next C starting is 100ms, inside violin's 120ms merge window — but a D
    // was struck in between, so these are five strikes, not a fragmented one.
    const trill = [
      note('c1', 69, 0, 100, .9), note('d1', 71, 100, 200, .9),
      note('c2', 69, 200, 300, .9), note('d2', 71, 300, 400, .9),
      note('c3', 69, 400, 500, .9),
    ]
    const result = cleanupTranscribedNotes(trill, AUDIO_PROFILES.violin)
    expect(result.events.map((event) => event.pitch))
      .toEqual([69, 71, 69, 71, 69])
  })

  it('still merges a note the model split in two', () => {
    // Nothing was struck in between, so these are one sustained note reported
    // as two fragments — the case the merge exists for.
    const result = cleanupTranscribedNotes([
      note('a', 69, 0, 200, .8), note('b', 69, 240, 500, .7),
    ], AUDIO_PROFILES.violin)
    expect(result.events).toHaveLength(1)
    expect(result.events[0].tOffMs).toBe(500)
  })

  it('keeps a violin note bowed again when the engine heard the attack', () => {
    const result = cleanupTranscribedNotes([
      note('a', 69, 0, 200, .8, .9), note('b', 69, 240, 500, .7, .92),
    ], AUDIO_PROFILES.violin)
    expect(result.events).toHaveLength(2)
  })

  it('keeps a repeated piano note that a chord tone separates', () => {
    const result = cleanupTranscribedNotes([
      note('a', 60, 0, 60, .9), note('mid', 64, 70, 130, .9),
      note('b', 60, 100, 200, .9),
    ], AUDIO_PROFILES.piano)
    expect(result.events.filter((event) => event.pitch === 60)).toHaveLength(2)
  })
})

describe('a struck instrument is judged by its attacks', () => {
  it('keeps the second C of "C C G G" — the note the old merge swallowed', () => {
    // Twinkle, as Basic Pitch hears it: the repeated C is struck firmly and
    // nothing else is struck between the two, which is exactly what the old
    // silence-only merge read as one note.
    const result = cleanupTranscribedNotes([
      heard('c', 60, 998, 1_660, .94), heard('c-again', 60, 1_660, 2_149, .97),
    ], AUDIO_PROFILES.piano)
    expect(result.events.map((event) => event.tOnMs)).toEqual([998, 1_660])
  })

  it('reads a held note re-fired at every strike over it as one note', () => {
    // The left hand's C3 held through a bar, re-read each time the right hand
    // plays: contiguous pieces with a weak attack.
    const result = cleanupTranscribedNotes([
      heard('c3', 48, 998, 1_660, .94), heard('c4', 60, 998, 1_660, .94),
      heard('c3-again', 48, 1_660, 2_312, .47), heard('c4-2', 60, 1_660, 2_149, .97),
      heard('c3-again-2', 48, 2_312, 2_962, .48), heard('g4', 67, 2_300, 2_950, .97),
    ], AUDIO_PROFILES.piano)
    const leftHand = result.events.filter((event) => event.pitch === 48)
    expect(leftHand).toHaveLength(1)
    expect(leftHand[0].tOffMs).toBe(2_962)
    expect(result.rejectedCount).toBe(0)
  })

  it('drops a weak overtone of a note struck with it', () => {
    const result = cleanupTranscribedNotes([
      heard('f4', 65, 6_865, 7_365, .98, 84), heard('f6', 89, 6_865, 7_144, .71, 33),
    ], AUDIO_PROFILES.piano)
    expect(result.events.map((event) => event.pitch)).toEqual([65])
  })

  it('keeps an octave the player struck', () => {
    const result = cleanupTranscribedNotes([
      heard('c3', 48, 0, 600, .95, 90), heard('c4', 60, 4, 600, .94, 70),
    ], AUDIO_PROFILES.piano)
    expect(result.events.map((event) => event.pitch)).toEqual([48, 60])
  })

  it('keeps a soft note that was clearly struck', () => {
    const result = cleanupTranscribedNotes([heard('pp', 48, 0, 600, .9, 12)],
      AUDIO_PROFILES.piano)
    expect(result.events).toHaveLength(1)
  })

  it('counts an unexplained half-hearted attack, not the noise under it', () => {
    const result = cleanupTranscribedNotes([
      heard('played', 64, 0, 500, .95), heard('unsure', 71, 900, 1_200, .55),
      heard('nothing', 50, 1_400, 1_600, .12),
    ], AUDIO_PROFILES.piano)
    expect(result.events.map((event) => event.pitch)).toEqual([64])
    expect(result.rejectedCount).toBe(1)
  })

  it('trusts every note from an engine that already decided it was struck', () => {
    // Onsets and Frames reports no attack; its notes exist because it heard one.
    const result = cleanupTranscribedNotes([
      note('a', 60, 0, 600, .6), note('b', 60, 640, 1_200, .6),
    ], AUDIO_PROFILES.piano)
    expect(result.events).toHaveLength(2)
  })
})
