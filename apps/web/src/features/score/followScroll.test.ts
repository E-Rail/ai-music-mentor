import { describe, expect, it } from 'vitest'
import { followScrollTop } from './followScroll'

const view = { viewportHeight: 600, contentHeight: 3000, cursorHeight: 40 }

describe('following the place you are playing', () => {
  it('holds still while the cursor is comfortably on screen', () => {
    expect(followScrollTop({ ...view, scrollTop: 0, cursorTop: 250 })).toBeNull()
  })

  it('moves on once the cursor reaches the bottom of the band', () => {
    const next = followScrollTop({ ...view, scrollTop: 0, cursorTop: 520 })
    expect(next).not.toBeNull()
    // The cursor ends high, with what came before it still visible.
    expect(520 - (next as number)).toBeCloseTo(600 * 0.3, 0)
  })

  it('follows a cursor that has scrolled off the top', () => {
    const next = followScrollTop({ ...view, scrollTop: 900, cursorTop: 800 })
    expect(next).not.toBeNull()
    expect(next as number).toBeLessThan(900)
  })

  it('never scrolls past the end of the page', () => {
    const next = followScrollTop({ ...view, scrollTop: 0, cursorTop: 2980 })
    expect(next).toBe(3000 - 600)
  })

  it('does nothing when the whole page already fits', () => {
    expect(followScrollTop({
      ...view, contentHeight: 400, scrollTop: 0, cursorTop: 380,
    })).toBeNull()
  })

  it('ignores a move too small to be worth animating', () => {
    // Just outside the band, but only by a few pixels — sliding here reads as
    // a wobble rather than a page turn.
    const scrollTop = 520 - 600 * 0.3
    expect(followScrollTop({ ...view, scrollTop, cursorTop: 521 })).toBeNull()
  })

  it('says nothing rather than re-scrolling to where it already is', () => {
    // Returning the current position would cancel a scroll the player started.
    const settled = followScrollTop({ ...view, scrollTop: 0, cursorTop: 520 }) as number
    expect(followScrollTop({ ...view, scrollTop: settled, cursorTop: 520 })).toBeNull()
  })
})
