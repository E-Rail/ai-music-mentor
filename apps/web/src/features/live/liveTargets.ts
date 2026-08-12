/**
 * Score positions the live layer can point at.
 *
 * Score events are per-voice; a live target is per-onset, because a position on
 * the page is one thing the player has to produce even when it is written
 * across two staves. This is the browser-side twin of the analyser's onset
 * clustering, and it uses the same absolute-beat ordering so the live cursor
 * and the final report never disagree about what comes next.
 *
 * Each expected note remembers the hand that wrote it, so the app can say
 * "还差左手 C3" instead of a bare pitch the student has to place themselves.
 */
import type { ScoreEvent } from '../../types'
import { handOfEventId, type Hand } from '../score/hands'
import { absoluteBeatOf } from './performanceClock'

export interface ExpectedNote {
  pitch: number
  hand: Hand
}

export interface LiveTarget {
  measureNo: number
  onsetBeat: number
  absoluteBeat?: number | null
  pitches: number[]
  expected: ExpectedNote[]
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
        absoluteBeat: event.absoluteBeat, pitches: [], expected: [], eventIds: [],
      }
      const hand = handOfEventId(event.eventId)
      const known = new Set(current.expected.map((note) => note.pitch))
      for (const pitch of event.pitches) {
        if (known.has(pitch)) continue
        known.add(pitch)
        current.expected.push({ pitch, hand })
      }
      current.expected.sort((left, right) => left.pitch - right.pitch)
      current.pitches = current.expected.map((note) => note.pitch)
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
