/**
 * Score positions the live layer can point at, and the one function every input
 * source uses to decide which of them the player is on.
 *
 * Score events are per-voice; a live target is per-onset, because the player
 * hits a chord as one gesture. This is the browser-side twin of the analyser's
 * onset clustering, and it uses the same absolute-beat ordering so the live
 * cursor and the final report never disagree about what comes next.
 */
import type { ScoreEvent } from '../../types'
import { PerformanceClock, absoluteBeatOf } from './performanceClock'

export interface LiveTarget {
  measureNo: number
  onsetBeat: number
  absoluteBeat?: number | null
  pitches: number[]
  eventIds: string[]
}

export function buildLiveTargets(
  events: ScoreEvent[], start: number, end: number,
): LiveTarget[] {
  const grouped = new Map<string, LiveTarget>()
  events
    .filter((event) => event.measureNo >= start && event.measureNo <= end)
    .forEach((event) => {
      const key = `${event.measureNo}:${event.onsetBeat}`
      const current = grouped.get(key) ?? {
        measureNo: event.measureNo, onsetBeat: event.onsetBeat,
        absoluteBeat: event.absoluteBeat, pitches: [], eventIds: [],
      }
      current.pitches = [...new Set([...current.pitches, ...event.pitches])]
        .sort((left, right) => left - right)
      current.eventIds = [...new Set([...current.eventIds, event.eventId])]
      grouped.set(key, current)
    })
  // Absolute beats first so a meter change or a pickup bar cannot reorder the
  // sequence relative to the analyser.
  return [...grouped.values()].sort((left, right) =>
    absoluteBeatOf(left, 4) - absoluteBeatOf(right, 4) ||
    left.measureNo - right.measureNo ||
    left.onsetBeat - right.onsetBeat)
}

/**
 * Beat distance from the first target in the range. Working relative to the
 * range start means the caller never has to know whether the passage begins at
 * measure 1, measure 12, or halfway through a bar.
 */
export function relativeBeatOf(
  target: LiveTarget, targets: LiveTarget[], beatsPerMeasure: number,
): number {
  if (!targets.length) return 0
  return absoluteBeatOf(target, beatsPerMeasure) -
    absoluteBeatOf(targets[0], beatsPerMeasure)
}

/**
 * The target nearest to how far the player has actually travelled. Elapsed
 * beats come from the clock, which starts at the player's first note, so
 * waiting before the downbeat no longer skips the passage forward.
 */
export function targetIndexAtElapsedBeats(
  targets: LiveTarget[], elapsedBeats: number, beatsPerMeasure: number,
): number {
  if (!targets.length) return 0
  if (!(elapsedBeats > 0)) return 0
  let bestIndex = 0
  let bestDistance = Number.POSITIVE_INFINITY
  targets.forEach((target, index) => {
    const distance = Math.abs(
      relativeBeatOf(target, targets, beatsPerMeasure) - elapsedBeats)
    if (distance < bestDistance) {
      bestDistance = distance
      bestIndex = index
    }
  })
  return bestIndex
}

export type LivePositionStrategy = 'follower' | 'elapsed'

export interface ResolvePositionInput {
  targets: LiveTarget[]
  strategy: LivePositionStrategy
  clock: PerformanceClock
  atMs: number
  /** Last onset the follower matched. */
  followerIndex?: number | null
  /** Onset the follower expects next; where an unmatched note belongs. */
  expectedIndex?: number | null
  /** Pitches just played, used to choose between the two. */
  played?: number[]
}

/**
 * One position resolver for every input source.
 *
 * USB MIDI has exact onsets, so the beam-search follower is the better judge —
 * it survives wrong notes, repeats and skipped bars. The microphone only offers
 * a smoothed dominant pitch, so it falls back to elapsed time. Both read the
 * same clock and return an index into the same target list, which is what keeps
 * the cursor, the staff marker and the feedback card from drifting apart.
 */
export function resolveTargetIndex(input: ResolvePositionInput): number {
  const { targets, strategy, clock, atMs, followerIndex, expectedIndex, played } = input
  if (!targets.length) return 0
  const clamp = (value: number) =>
    Math.min(Math.max(Math.round(value), 0), targets.length - 1)

  if (strategy === 'follower') {
    const matched = followerIndex != null && Number.isFinite(followerIndex)
      ? clamp(followerIndex) : null
    const expected = expectedIndex != null && Number.isFinite(expectedIndex)
      ? clamp(expectedIndex) : null
    if (expected !== null && played?.length) {
      // A note that fits where the player is due to play belongs there. One
      // that fits nowhere is a mistake *at* that position, not at the last one
      // they got right — which is what makes fixing it recognisable as a fix.
      const here = new Set(targets[expected].pitches)
      if (played.some((pitch) => here.has(pitch))) return expected
      const atMatched = matched === null
        ? null : new Set(targets[matched].pitches)
      if (atMatched && played.some((pitch) => atMatched.has(pitch))) return matched!
      return expected
    }
    if (matched !== null) return matched
    if (expected !== null) return expected
  }
  if (!clock.started) return 0
  return targetIndexAtElapsedBeats(
    targets, clock.elapsedBeats(atMs), clock.beatsPerMeasure)
}
