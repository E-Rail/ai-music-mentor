import { describe, expect, it } from 'vitest'
import { diatonicStep, midiFromOsmdHalfTone, noteName } from './pitch'

describe('how the app spells a pitch', () => {
  it('names the notes a beginner meets', () => {
    expect(noteName(60)).toBe('C4')
    expect(noteName(69)).toBe('A4')
    expect(noteName(21)).toBe('A0')
    expect(noteName(108)).toBe('C8')
  })

  it('draws a note on the line its name implies', () => {
    // The bug this table exists to prevent: a dot labelled B♭4 drawn on the A
    // space, one line below where a reader would look for it.
    expect(diatonicStep(70)).toBe(diatonicStep(71))       // B♭4 shares B4's line
    expect(diatonicStep(70)).not.toBe(diatonicStep(69))   // …and not A4's
    expect(diatonicStep(63)).toBe(diatonicStep(64))       // E♭4 shares E4's line
    expect(diatonicStep(68)).toBe(diatonicStep(69))       // A♭4 shares A4's line
    expect(diatonicStep(61)).toBe(diatonicStep(60))       // C♯4 shares C4's line
    expect(diatonicStep(66)).toBe(diatonicStep(65))       // F♯4 shares F4's line
  })

  it('advances one step per staff position and seven per octave', () => {
    expect(diatonicStep(62) - diatonicStep(60)).toBe(1)   // C4 → D4
    expect(diatonicStep(72) - diatonicStep(60)).toBe(7)   // C4 → C5
    for (let pitch = 21; pitch < 108; pitch += 1) {
      expect(diatonicStep(pitch + 1)).toBeGreaterThanOrEqual(diatonicStep(pitch))
    }
  })

  it('lifts an OSMD half tone into the MIDI number everything else speaks', () => {
    // Measured against a rendered score: OSMD reports 48 for a written C4.
    expect(midiFromOsmdHalfTone(48)).toBe(60)
    expect(midiFromOsmdHalfTone(57)).toBe(69)
    expect(noteName(midiFromOsmdHalfTone(48))).toBe('C4')
    expect(Number.isNaN(midiFromOsmdHalfTone(Number.NaN))).toBe(true)
  })
})
