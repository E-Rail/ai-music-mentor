/**
 * Where a label pinned to a point on the score is allowed to sit.
 *
 * Everything the app draws over the engraving — the note you just played, the
 * follower's position, an error marker — hangs a small label off an anchor
 * point. The default is above and centred, which is right in the middle of the
 * page and wrong at its edges: near the top the label lands on the title or on
 * nothing at all, and near the sides it hangs off the paper.
 *
 * One rule, used by every overlay, so no label can leave the page.
 */

export type LabelSide = 'above' | 'below'
export type LabelAlign = 'center' | 'start' | 'end'

/** Room a label needs, in the same units as the sheet it is measured against. */
export const LABEL_ROOM = { above: 26, beside: 34 }

export interface LabelPlacement {
  side: LabelSide
  align: LabelAlign
  /** Ready to append to the anchor's class list. */
  className: string
}

export function labelSide(y: number, room: number = LABEL_ROOM.above): LabelSide {
  return Number.isFinite(y) && y - room < 0 ? 'below' : 'above'
}

export function labelAlign(
  x: number, sheetWidth: number, room: number = LABEL_ROOM.beside,
): LabelAlign {
  if (!Number.isFinite(x) || !Number.isFinite(sheetWidth) || sheetWidth <= 0) return 'center'
  if (x - room < 0) return 'start'
  if (x + room > sheetWidth) return 'end'
  return 'center'
}

/**
 * `x`/`y` are the anchor point in sheet units; `sheetWidth` bounds the page.
 * The returned class names are styled once, in the stylesheet, for every
 * overlay that uses them.
 */
export function labelPlacement(
  x: number, y: number, sheetWidth: number, room = LABEL_ROOM,
): LabelPlacement {
  const side = labelSide(y, room.above)
  const align = labelAlign(x, sheetWidth, room.beside)
  return { side, align, className: `label-${side} label-${align}` }
}
