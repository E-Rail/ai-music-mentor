import { describe, expect, it } from 'vitest'
import { LABEL_ROOM, labelAlign, labelPlacement, labelSide } from './overlayLabels'

describe('keeping overlay labels on the paper', () => {
  it('hangs a label below its anchor when there is no room above', () => {
    expect(labelSide(4)).toBe('below')
    expect(labelSide(LABEL_ROOM.above - 1)).toBe('below')
    expect(labelSide(LABEL_ROOM.above + 1)).toBe('above')
  })

  it('tucks a label in at either edge of the page', () => {
    expect(labelAlign(2, 900)).toBe('start')
    expect(labelAlign(898, 900)).toBe('end')
    expect(labelAlign(450, 900)).toBe('center')
  })

  it('stays centred when the page size is unknown', () => {
    expect(labelAlign(10, 0)).toBe('center')
    expect(labelAlign(Number.NaN, 900)).toBe('center')
  })

  it('hands back class names the stylesheet already understands', () => {
    expect(labelPlacement(450, 300, 900).className).toBe('label-above label-center')
    // The corner case that produced the screenshot: first bar, top staff line.
    expect(labelPlacement(8, 6, 900).className).toBe('label-below label-start')
  })
})
