import { describe, expect, it } from 'vitest'
import {
  buildPitchScale, buildScoreLayout, diatonicStep, locateScorePosition,
  staffForPitch, staffHintFromEventIds,
} from './scoreGeometry'

function entry(beat: number, x: number, y: number) {
  return {
    relInMeasureTimestamp: { RealValue: beat / 4 },
    PositionAndShape: { AbsolutePosition: { x, y } },
    getHighestYAtEntry: () => -3,
    getLowestYAtEntry: () => 4,
  }
}

describe('score overlay geometry', () => {
  it('converts OSMD engraving units to SVG pixels and anchors to the staff entry', () => {
    const layout = buildScoreLayout([[
      {
        PositionAndShape: { AbsolutePosition: { x: 30, y: 40 }, Size: { width: 100, height: 8 } },
        staffEntries: [entry(1, 50, 42)],
      },
    ]], 10)

    expect(layout[0]).toMatchObject({ x: 300, y: 400, width: 1000, height: 80 })
    expect(locateScorePosition(layout, 1, 1, 4, 'upper')).toEqual({
      x: 500, top: 385.5, height: 79,
    })
  })

  it('uses the selected hand and lets the cursor span the complete system', () => {
    const layout = buildScoreLayout([[
      {
        PositionAndShape: { AbsolutePosition: { x: 10, y: 20 }, Size: { width: 80, height: 6 } },
        staffEntries: [entry(0, 25, 22)],
      },
      {
        PositionAndShape: { AbsolutePosition: { x: 10, y: 30 }, Size: { width: 80, height: 6 } },
        staffEntries: [entry(0, 25, 32)],
      },
    ]], 10)

    expect(locateScorePosition(layout, 1, 0, 4, 'lower')?.top).toBe(285.5)
    expect(locateScorePosition(layout, 1, 0, 4, null, true)).toEqual({
      x: 250, top: 200, height: 160,
    })
  })

  it('derives upper and lower staff hints from stable event IDs', () => {
    expect(staffHintFromEventIds(['piece:RH:m2:b0:1'])).toBe('upper')
    expect(staffHintFromEventIds(['piece:Left Hand:m2:b0:1'])).toBe('lower')
    expect(staffHintFromEventIds([null])).toBeNull()
  })
})

describe('placing a pitch the score never contained', () => {
  it('counts staff positions diatonically, so C♯ shares C’s line', () => {
    expect(diatonicStep(61)).toBe(diatonicStep(60))
    expect(diatonicStep(62) - diatonicStep(60)).toBe(1)
    // E to F is one staff step even though it is one semitone.
    expect(diatonicStep(65) - diatonicStep(64)).toBe(1)
    expect(diatonicStep(72) - diatonicStep(60)).toBe(7)
  })

  it('fits the staff from engraved notes and extrapolates beyond them', () => {
    // C4 at y=100, E4 at y=90 → one diatonic step is 5 units.
    const scale = buildPitchScale([
      { pitch: 60, y: 100 }, { pitch: 64, y: 90 }, { pitch: 67, y: 80 },
    ], 4)
    expect(scale.fitted).toBe(true)
    expect(scale.stepHeight).toBeCloseTo(5, 5)
    expect(scale.yForPitch(60)).toBeCloseTo(100, 5)
    // A played note far above anything written still lands on the staff.
    expect(scale.yForPitch(72)).toBeCloseTo(65, 5)
    expect(scale.yForPitch(53)).toBeCloseTo(120, 5)
    // An accidental shares the natural's line.
    expect(scale.yForPitch(61)).toBeCloseTo(scale.yForPitch(60), 5)
  })

  it('falls back to a nominal step when a staff engraved only one pitch', () => {
    const scale = buildPitchScale([{ pitch: 60, y: 50 }], 6)
    expect(scale.fitted).toBe(false)
    expect(scale.yForPitch(60)).toBe(50)
    expect(scale.yForPitch(62)).toBe(44)
  })

  it('sends a played pitch to the staff that engraves the nearest notes', () => {
    const staves = new Map([[0, [67, 72]], [1, [43, 48]]])
    expect(staffForPitch(71, staves)).toBe(0)
    expect(staffForPitch(45, staves)).toBe(1)
    expect(staffForPitch(45, staves, 'upper')).toBe(0)
    expect(staffForPitch(71, staves, 'lower')).toBe(1)
  })
})
