/**
 * Which hand a score event was written for.
 *
 * Event IDs are `scoreId:part:measure:onset:index`, where the part is the staff
 * name the importer kept — `RH`/`LH` in the demo library, "Right Hand" /
 * "Left Hand" or a translated equivalent in an imported file. One parser, so
 * the staff a note is drawn on and the hand the panel names can never disagree.
 */

export type Hand = 'left' | 'right' | 'unknown'

const LEFT = ['lh', 'left', '左']
const RIGHT = ['rh', 'right', '右']

export function handOfEventId(eventId: string | null | undefined): Hand {
  const part = eventId?.split(':')[1]?.trim().toLowerCase()
  if (!part) return 'unknown'
  if (LEFT.some((token) => part === token || part.includes(token))) return 'left'
  if (RIGHT.some((token) => part === token || part.includes(token))) return 'right'
  return 'unknown'
}

/**
 * The hand a group of events shares, or `unknown` when they do not share one —
 * a chord written across both staves belongs to neither on its own.
 */
export function handOfEventIds(eventIds: Array<string | null | undefined>): Hand {
  const hands = new Set(eventIds.map(handOfEventId))
  hands.delete('unknown')
  return hands.size === 1 ? [...hands][0] : 'unknown'
}
