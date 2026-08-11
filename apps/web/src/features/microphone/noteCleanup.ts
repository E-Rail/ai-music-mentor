import type { PerformanceEvent } from '../../types'
import type { AudioDetectionProfile } from './profiles'

export interface CleanupResult {
  events: PerformanceEvent[]
  rejectedCount: number
  meanConfidence: number
}

function confidence(event: PerformanceEvent): number {
  return event.transcriptionConfidence ?? 0
}

export function cleanupTranscribedNotes(raw: PerformanceEvent[],
  profile: AudioDetectionProfile): CleanupResult {
  const filtered = raw
    .filter((event) => event.pitch >= profile.minPitch && event.pitch <= profile.maxPitch)
    .filter((event) => confidence(event) >= profile.minConfidence)
    .filter((event) => event.tOffMs - event.tOnMs >= profile.minDurationMs)
    .sort((a, b) => a.tOnMs - b.tOnMs || a.pitch - b.pitch)

  const merged: PerformanceEvent[] = []
  for (const event of filtered) {
    const previous = [...merged].reverse().find((candidate) => candidate.pitch === event.pitch)
    if (previous && event.tOnMs - previous.tOffMs <= profile.mergeGapMs &&
        event.tOnMs >= previous.tOnMs) {
      const previousConfidence = confidence(previous)
      const currentConfidence = confidence(event)
      previous.tOffMs = Math.max(previous.tOffMs, event.tOffMs)
      previous.transcriptionConfidence = Math.max(previousConfidence, currentConfidence)
      previous.velocity = Math.max(previous.velocity, event.velocity)
      continue
    }
    merged.push({ ...event })
  }

  let cleaned = merged
  if (profile.monophonic) {
    cleaned = strongestNonOverlappingSequence(merged)
  }

  const meanConfidence = cleaned.length
    ? cleaned.reduce((sum, event) => sum + confidence(event), 0) / cleaned.length
    : 0
  return {
    events: cleaned.map((event, index) => ({ ...event, id: `mic_${index + 1}` })),
    rejectedCount: raw.length - cleaned.length,
    meanConfidence,
  }
}

/** Select the highest-confidence non-overlapping sequence.
 *
 * Replacing only the first overlapping event can leave the replacement
 * overlapping a second event in a chain. Weighted interval scheduling makes
 * the monophonic profile truly monophonic and preserves credible short notes.
 */
function strongestNonOverlappingSequence(events: PerformanceEvent[]): PerformanceEvent[] {
  const sorted = [...events].sort((a, b) =>
    a.tOffMs - b.tOffMs || a.tOnMs - b.tOnMs || a.pitch - b.pitch)
  const previousCompatible = sorted.map((event, index) => {
    let low = 0
    let high = index - 1
    let result = -1
    while (low <= high) {
      const middle = Math.floor((low + high) / 2)
      if (sorted[middle].tOffMs <= event.tOnMs) {
        result = middle
        low = middle + 1
      } else {
        high = middle - 1
      }
    }
    return result
  })
  const scores = new Array<number>(sorted.length + 1).fill(0)
  const take = new Array<boolean>(sorted.length).fill(false)
  for (let index = 0; index < sorted.length; index += 1) {
    const include = confidence(sorted[index]) + scores[previousCompatible[index] + 1]
    const exclude = scores[index]
    take[index] = include > exclude
    scores[index + 1] = take[index] ? include : exclude
  }
  const chosen: PerformanceEvent[] = []
  for (let index = sorted.length - 1; index >= 0;) {
    const include = confidence(sorted[index]) + scores[previousCompatible[index] + 1]
    if (take[index] && include >= scores[index]) {
      chosen.push(sorted[index])
      index = previousCompatible[index]
    } else {
      index -= 1
    }
  }
  return chosen.sort((a, b) => a.tOnMs - b.tOnMs || a.pitch - b.pitch)
}
