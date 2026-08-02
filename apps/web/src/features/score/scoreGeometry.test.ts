import { describe, expect, it } from 'vitest'
import { buildScoreLayout, locateScorePosition, staffHintFromEventIds } from './scoreGeometry'

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
