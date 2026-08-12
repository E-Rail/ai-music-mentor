/**
 * Keeping the place you are playing on screen, without the page twitching.
 *
 * A cursor that is always re-centred means the music slides under you on every
 * beat, which is far harder to read than a page that holds still. Real players
 * turn a page when they run out of it, so this does the same: while the cursor
 * is anywhere inside a comfortable band the view does not move at all, and when
 * it leaves the band the view slides once to put the cursor near the top, with a
 * bar or two of what came before still visible for context.
 */

/** Fraction of the viewport the cursor may roam before the view follows. */
const BAND_TOP = 0.22
const BAND_BOTTOM = 0.72
/** Where the cursor lands after a move: high, but with the previous bar in view. */
const REST = 0.3

export interface FollowInput {
  /** Cursor position in sheet coordinates. */
  cursorTop: number
  cursorHeight: number
  /** The visible window. */
  viewportHeight: number
  scrollTop: number
  /** Full height of the sheet, for clamping. */
  contentHeight: number
}

/**
 * Where the view should be, or `null` to leave it exactly where it is.
 *
 * Returning null rather than the current position matters: it is the difference
 * between "do nothing" and "smoothly scroll to where you already are", and the
 * latter cancels a scroll the player started themselves.
 */
export function followScrollTop(input: FollowInput): number | null {
  const { cursorTop, cursorHeight, viewportHeight, scrollTop, contentHeight } = input
  if (viewportHeight <= 0 || contentHeight <= viewportHeight) return null

  const relativeTop = cursorTop - scrollTop
  const relativeBottom = relativeTop + cursorHeight
  const inBand = relativeTop >= viewportHeight * BAND_TOP &&
    relativeBottom <= viewportHeight * BAND_BOTTOM
  if (inBand) return null

  const wanted = cursorTop - viewportHeight * REST
  const clamped = Math.max(0, Math.min(wanted, contentHeight - viewportHeight))
  // A move of a few pixels is not worth animating; it reads as a wobble.
  return Math.abs(clamped - scrollTop) < 8 ? null : clamped
}
